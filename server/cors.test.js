import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApiServer } from './server.js'

async function fixture(t, options) {
  const server = createApiServer(options)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  return (path, { headers, ...options } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { Origin: 'http://localhost:5173', ...headers },
  })
}

test('todas las rutas aceptan preflight y encabezados personalizados sin acceder a MySQL', async (t) => {
  let transactions = 0
  const request = await fixture(t, {
    withTransaction: async () => { transactions++; throw new Error('Invalid URL') },
  })
  const routes = [
    ['/api/auth/login', 'POST'], ['/api/auth/logout', 'POST'],
    ['/api/vehicles', 'GET'], ['/api/vehicles/vehicle', 'PUT'],
    ['/api/parts/part', 'PATCH'], ['/api/documents/document', 'DELETE'],
    ['/api/files/document', 'HEAD'], ['/ruta-inexistente', 'OPTIONS'],
  ]
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://frontend.example.test']) {
    for (const [path, method] of routes) {
      const response = await request(path, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type, authorization, x-request-id',
        },
      })
      assert.equal(response.status, 204, `${origin} ${method} ${path}`)
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
      assert.ok(response.headers.get('access-control-allow-methods').split(/,\s*/).includes(method))
      assert.equal(response.headers.get('access-control-allow-headers'), 'content-type, authorization, x-request-id')
      assert.match(response.headers.get('vary'), /Access-Control-Request-Headers/i)
      assert.equal(response.headers.get('access-control-max-age'), '600')
      assert.equal(await response.text(), '')
    }
  }
  assert.equal(transactions, 0)
})

test('los errores de base de datos conservan CORS en login y logout', async (t) => {
  const request = await fixture(t, {
    withTransaction: async () => { throw new Error('Invalid URL') },
  })
  for (const path of ['/api/auth/login', '/api/auth/logout']) {
    const response = await request(path, { method: 'POST' })
    assert.equal(response.status, 500)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(await response.json(), { error: 'Invalid URL' })
  }
})

test('CORS cubre respuestas correctas, rutas inexistentes, JSON inválido y acceso sin sesión', async (t) => {
  const request = await fixture(t, { readStore: async () => ({ employees: [] }) })
  for (const [path, options, expectedStatus] of [
    ['/api/health', {}, 200],
    ['/ruta-inexistente', {}, 404],
    ['/api/vehicles', {}, 401],
    ['/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
  ]) {
    const response = await request(path, options)
    assert.equal(response.status, expectedStatus)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    await response.text()
  }
})

test('las descargas autenticadas también incluyen CORS y exponen Content-Disposition', async (t) => {
  const token = 'cors-test-token'
  const path = fileURLToPath(new URL('../package.json', import.meta.url))
  const request = await fixture(t, {
    readStore: async () => ({
      employees: [{ id: 'employee', active: true }],
      sessions: [{ id: createHash('sha256').update(token).digest('hex'), employeeId: 'employee', expiresAt: '2099-01-01T00:00:00.000Z' }],
      documents: [{ id: 'document', filePath: path, fileName: 'document.json', mimeType: 'application/json' }],
    }),
  })
  const response = await request('/api/files/document', { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('access-control-expose-headers'), 'Content-Disposition')
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="document.json"')
  assert.equal(await response.text(), readFileSync(path, 'utf8'))
})
