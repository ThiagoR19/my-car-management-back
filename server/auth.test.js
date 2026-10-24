import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createApiServer } from './server.js'
import { passwordRecord } from './store.js'

const adminPassword = 'admin-test-1234'
const employeePassword = 'employee-test-1234'
const adminCredentials = passwordRecord(adminPassword)
const employeeCredentials = passwordRecord(employeePassword)

function employee(overrides = {}) {
  return {
    id: 'emp-test', name: 'Persona preagregada', username: 'persona', email: 'persona@example.com',
    role: 'Empleado', active: true, passwordHash: '', passwordSalt: '', ...overrides,
  }
}

function registration(overrides = {}) {
  return {
    name: 'Persona registrada', username: 'persona', email: 'persona@example.com',
    password: employeePassword, passwordConfirmation: employeePassword, ...overrides,
  }
}

async function fixture(t, employees = [], { beforeWrite } = {}) {
  let store = {
    employees: [{ id: 'emp-admin', name: 'Administración', username: 'admin', email: 'admin@example.com', role: 'Administrador', active: true, ...adminCredentials }, ...employees],
    accessRequests: [], vehicleTypes: [], documentTypes: [], vehicles: [], documents: [], audit: [], notifications: [],
    settings: { companyName: 'Test', firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7 },
  }
  const server = createApiServer({
    readStore: async () => structuredClone(store),
    writeStore: async (nextStore) => {
      if (beforeWrite) await beforeWrite(nextStore)
      store = structuredClone(nextStore)
    },
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  async function login(identifier, password = employeePassword) {
    return request('/auth/login', { method: 'POST', body: { identifier, password } })
  }
  async function adminToken() {
    const response = await login('admin', adminPassword)
    assert.equal(response.status, 200)
    assert.ok(response.body.token)
    return response.body.token
  }
  return {
    request, login, adminToken, server, baseUrl,
    snapshot: () => structuredClone(store),
    update: (change) => { change(store) },
  }
}

function assertPrivateCredentials(payload) {
  assert.equal(Object.hasOwn(payload, 'passwordHash'), false)
  assert.equal(Object.hasOwn(payload, 'passwordSalt'), false)
}

test('registrarse sin estar en empleados crea una solicitud y bloquea el ingreso por usuario y email', async (t) => {
  const api = await fixture(t)
  const response = await api.request('/auth/register', { method: 'POST', body: registration({ active: true, role: 'Administrador' }) })
  assert.equal(response.status, 201)
  assert.equal(response.body.pendingApproval, true)
  assert.equal(response.body.token, undefined)
  assert.equal(response.body.employee, undefined)
  assertPrivateCredentials(response.body.request)
  const store = api.snapshot()
  assert.equal(store.employees.length, 1)
  assert.equal(store.accessRequests.length, 1)
  assert.ok(store.accessRequests[0].passwordHash)
  assert.ok(store.accessRequests[0].passwordSalt)
  for (const identifier of ['persona', 'persona@example.com']) {
    assert.equal((await api.login(identifier)).status, 403)
  }
  assert.equal((await api.request('/auth/me')).status, 401)
  assert.equal((await api.request('/employees')).status, 401)
})

test('el empleado preagregado activo completa sus credenciales y puede iniciar sesión', async (t) => {
  const api = await fixture(t, [employee({ role: 'Administrador' })])
  const response = await api.request('/auth/register', { method: 'POST', body: registration({ username: ' PERSONA ', email: ' PERSONA@EXAMPLE.COM ' }) })
  assert.equal(response.status, 201)
  assert.equal(response.body.pendingApproval, false)
  assert.equal(response.body.token, undefined)
  assert.equal(response.body.employee.id, 'emp-test')
  assert.equal(response.body.employee.role, 'Administrador')
  assertPrivateCredentials(response.body.employee)
  const store = api.snapshot()
  assert.equal(store.employees.length, 2)
  assert.equal(store.accessRequests.length, 0)
  assert.ok(store.employees[1].passwordHash)
  for (const identifier of ['persona', 'persona@example.com']) {
    const loggedIn = await api.login(identifier)
    assert.equal(loggedIn.status, 200)
    assert.ok(loggedIn.body.token)
    assertPrivateCredentials(loggedIn.body.employee)
    assert.equal((await api.request('/auth/me', { token: loggedIn.body.token })).status, 200)
  }
})

test('el empleado preagregado inactivo registra su contraseña pero espera la activación del administrador', async (t) => {
  const api = await fixture(t, [employee({ active: false })])
  const response = await api.request('/auth/register', { method: 'POST', body: registration({ active: true, role: 'Administrador' }) })
  assert.equal(response.status, 201)
  assert.equal(response.body.pendingApproval, true)
  assert.equal(response.body.token, undefined)
  assert.equal(response.body.employee.id, 'emp-test')
  assert.equal(response.body.employee.role, 'Empleado')
  assert.equal(api.snapshot().employees[1].active, false)
  assert.equal(api.snapshot().accessRequests.length, 0)
  assert.equal((await api.login('persona')).status, 403)
  assert.equal((await api.login('persona@example.com')).status, 403)
  const enabled = await api.request('/employees/emp-test', { method: 'PUT', token: await api.adminToken(), body: { active: true } })
  assert.equal(enabled.status, 200)
  assert.equal((await api.login('persona')).status, 200)
})

test('agregar empleados sin contraseña no crea una contraseña predeterminada y respeta el acceso elegido', async (t) => {
  const api = await fixture(t)
  const token = await api.adminToken()
  for (const active of [true, false]) {
    const username = active ? 'habilitado' : 'deshabilitado'
    const response = await api.request('/employees', {
      method: 'POST', token,
      body: { username, email: `${username}@example.com`, ...(active ? {} : { active: false }) },
    })
    assert.equal(response.status, 201)
    assert.equal(response.body.active, active)
    assertPrivateCredentials(response.body)
    const saved = api.snapshot().employees.find((item) => item.id === response.body.id)
    assert.equal(saved.passwordHash, '')
    assert.equal(saved.passwordSalt, '')
    const login = await api.login(username, 'user1234')
    assert.equal(login.status, active ? 401 : 403)
  }
})

test('agregar o editar empleados rechaza estados de acceso que no son booleanos', async (t) => {
  const api = await fixture(t, [employee()])
  const token = await api.adminToken()
  const before = api.snapshot()
  for (const active of [null, 'true', 'false', 1, 0]) {
    const created = await api.request('/employees', { method: 'POST', token, body: { username: 'otra', email: 'otra@example.com', active } })
    assert.equal(created.status, 400)
    const updated = await api.request('/employees/emp-test', { method: 'PUT', token, body: { active } })
    assert.equal(updated.status, 400)
    assert.deepEqual(api.snapshot(), before)
  }
})

test('el registro exige que usuario y email identifiquen al mismo empleado y no sobrescribe cuentas', async (t) => {
  const cases = [
    { name: 'solo coincide el usuario', employees: [employee()], body: registration({ email: 'otra@example.com' }) },
    { name: 'solo coincide el email', employees: [employee()], body: registration({ username: 'otra' }) },
    { name: 'usuario y email pertenecen a empleados distintos', employees: [employee({ email: 'otra@example.com' }), employee({ id: 'emp-other', username: 'otra' })], body: registration() },
    { name: 'la cuenta ya tiene contraseña', employees: [employee(employeeCredentials)], body: registration({ password: 'reemplazo-1234', passwordConfirmation: 'reemplazo-1234' }) },
    { name: 'la cuenta tiene credenciales incompletas', employees: [employee({ passwordHash: employeeCredentials.passwordHash })], body: registration() },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const api = await fixture(subtest, scenario.employees)
      const before = api.snapshot()
      const response = await api.request('/auth/register', { method: 'POST', body: scenario.body })
      assert.equal(response.status, 409)
      assert.deepEqual(api.snapshot(), before)
    })
  }
})

test('una solicitud pendiente no puede duplicarse ni reemplazar su contraseña', async (t) => {
  const api = await fixture(t)
  assert.equal((await api.request('/auth/register', { method: 'POST', body: registration() })).status, 201)
  const before = api.snapshot()
  for (const body of [
    registration({ password: 'reemplazo-1234', passwordConfirmation: 'reemplazo-1234' }),
    registration({ email: 'otra@example.com' }),
    registration({ username: 'otra' }),
  ]) {
    const response = await api.request('/auth/register', { method: 'POST', body })
    assert.equal(response.status, 409)
    assert.deepEqual(api.snapshot(), before)
  }
})

test('las cuentas existentes conservan su login y el registro no reemplaza sus credenciales', async (t) => {
  const api = await fixture(t, [employee(employeeCredentials)])
  for (const identifier of ['persona', 'persona@example.com']) {
    assert.equal((await api.login(identifier)).status, 200)
  }
  const before = api.snapshot()
  const response = await api.request('/auth/register', {
    method: 'POST', body: registration({ password: 'reemplazo-1234', passwordConfirmation: 'reemplazo-1234' }),
  })
  assert.equal(response.status, 409)
  assert.deepEqual(api.snapshot(), before)
  assert.equal((await api.login('persona')).status, 200)
  assert.equal((await api.login('persona', 'reemplazo-1234')).status, 401)
})

test('un registro con cuerpo incompleto no restaura el acceso desactivado mientras esperaba', { timeout: 5_000 }, async (t) => {
  const api = await fixture(t, [employee()])
  const token = await api.adminToken()
  const body = Buffer.from(JSON.stringify(registration()))
  const split = Math.floor(body.length / 2)
  const accepted = new Promise((resolve) => api.server.once('request', resolve))
  let pendingRequest
  const result = new Promise((resolve, reject) => {
    pendingRequest = httpRequest(`${api.baseUrl}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, async (response) => {
      try {
        const chunks = []
        for await (const chunk of response) chunks.push(chunk)
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch (error) { reject(error) }
    })
    pendingRequest.once('error', reject)
  })
  t.after(() => pendingRequest.destroy())
  pendingRequest.write(body.subarray(0, split))
  await accepted
  const disabled = await api.request('/employees/emp-test', { method: 'PUT', token, body: { active: false } })
  assert.equal(disabled.status, 200)
  assert.equal(api.snapshot().employees[1].active, false)
  pendingRequest.end(body.subarray(split))
  const completed = await result
  assert.equal(completed.status, 201)
  assert.equal(completed.body.pendingApproval, true)
  assert.equal(completed.body.token, undefined)
  assert.equal(completed.body.employee.active, false)
  assert.equal(api.snapshot().employees[1].active, false)
  assert.equal((await api.login('persona')).status, 403)
})

test('generar notificaciones serializa su escritura con la desactivación de acceso', async (t) => {
  for (const path of ['/notifications', '/%6eotifications']) {
    await t.test(path, { timeout: 5_000 }, async (subtest) => {
      let notifyFirstWrite
      let releaseFirstWrite
      let writes = 0
      let armed = false
      const firstWriteStarted = new Promise((resolve) => { notifyFirstWrite = resolve })
      const firstWriteReleased = new Promise((resolve) => { releaseFirstWrite = resolve })
      const api = await fixture(subtest, [employee(employeeCredentials)], {
        beforeWrite: async (nextStore) => {
          if (!armed) return
          writes += 1
          if (writes === 1) {
            assert.equal(nextStore.employees[1].active, true)
            notifyFirstWrite()
            await firstWriteReleased
          }
        },
      })
      subtest.after(() => releaseFirstWrite())
      const token = await api.adminToken()
      armed = true
      const notifications = api.request(path, { token })
      await firstWriteStarted
      const disableBodyReceived = new Promise((resolve) => {
        api.server.once('request', (request) => request.once('end', resolve))
      })
      const disabled = api.request('/employees/emp-test', { method: 'PUT', token, body: { active: false } })
      await disableBodyReceived
      // El cuerpo terminó y las continuaciones de dispatch llegaron a la cola antes de liberar la escritura.
      await new Promise((resolve) => setImmediate(resolve))
      releaseFirstWrite()
      const responses = await Promise.all([notifications, disabled])
      assert.ok(responses.every((response) => response.status === 200))
      assert.equal(writes, 2)
      assert.equal(api.snapshot().employees[1].active, false)
      assert.equal((await api.login('persona')).status, 403)
    })
  }
})

test('el administrador aprueba una solicitud conservando su contraseña y respetando active', async (t) => {
  for (const active of [true, false]) {
    await t.test(`active=${active}`, async (subtest) => {
      const api = await fixture(subtest)
      assert.equal((await api.request('/auth/register', { method: 'POST', body: registration() })).status, 201)
      const pending = api.snapshot().accessRequests[0]
      const response = await api.request('/employees', {
        method: 'POST', token: await api.adminToken(),
        body: { username: 'persona', email: 'persona@example.com', active, password: 'no-reemplazar-1234' },
      })
      assert.equal(response.status, 201)
      assert.equal(response.body.active, active)
      const store = api.snapshot()
      assert.equal(store.accessRequests.length, 0)
      assert.equal(store.employees[1].passwordHash, pending.passwordHash)
      assert.equal(store.employees[1].passwordSalt, pending.passwordSalt)
      assert.equal((await api.login('persona')).status, active ? 200 : 403)
      if (active) assert.equal((await api.login('persona', 'no-reemplazar-1234')).status, 401)
    })
  }
})

test('el administrador no puede aprobar una solicitud con otro usuario o email', async (t) => {
  const api = await fixture(t)
  assert.equal((await api.request('/auth/register', { method: 'POST', body: registration() })).status, 201)
  const token = await api.adminToken()
  const before = api.snapshot()
  for (const body of [
    { username: 'persona', email: 'otra@example.com' },
    { username: 'otra', email: 'persona@example.com' },
  ]) {
    assert.equal((await api.request('/employees', { method: 'POST', token, body })).status, 409)
    assert.deepEqual(api.snapshot(), before)
  }
})

test('login y rutas protegidas exigen acceso activado con el booleano true', async (t) => {
  for (const active of [false, undefined, null, 'true', 1]) {
    await t.test(`active=${JSON.stringify(active)}`, async (subtest) => {
      const api = await fixture(subtest, [employee(employeeCredentials)])
      const login = await api.login('persona')
      assert.equal(login.status, 200)
      api.update((store) => { store.employees[1].active = active })
      assert.equal((await api.login('persona')).status, 403)
      assert.equal((await api.request('/auth/me', { token: login.body.token })).status, 401)
      assert.equal((await api.request('/vehicles', { token: login.body.token })).status, 401)
    })
  }
})

test('desactivar revoca todas las sesiones y reactivar exige iniciar sesión nuevamente', async (t) => {
  const api = await fixture(t, [employee(employeeCredentials)])
  const token = await api.adminToken()
  const sessions = [await api.login('persona'), await api.login('persona@example.com')]
  assert.ok(sessions.every((session) => session.status === 200))
  assert.equal((await api.request('/employees/emp-test', { method: 'PUT', token, body: { active: false } })).status, 200)
  assert.equal((await api.login('persona')).status, 403)
  assert.equal((await api.request('/auth/me', { token: sessions[0].body.token })).status, 401)
  assert.equal((await api.request('/employees/emp-test', { method: 'PUT', token, body: { active: true } })).status, 200)
  for (const session of sessions) {
    assert.equal((await api.request('/auth/me', { token: session.body.token })).status, 401)
  }
  const newSession = await api.login('persona')
  assert.equal(newSession.status, 200)
  assert.equal((await api.request('/auth/me', { token: newSession.body.token })).status, 200)
})

test('eliminar un empleado revoca su sesión incluso si vuelve a existir el mismo id', async (t) => {
  const original = employee(employeeCredentials)
  const api = await fixture(t, [original])
  const session = await api.login('persona')
  assert.equal(session.status, 200)
  assert.equal((await api.request('/employees/emp-test', { method: 'DELETE', token: await api.adminToken() })).status, 200)
  assert.equal((await api.request('/auth/me', { token: session.body.token })).status, 401)
  assert.equal((await api.login('persona')).status, 401)
  api.update((store) => { store.employees.push(structuredClone(original)) })
  assert.equal((await api.request('/auth/me', { token: session.body.token })).status, 401)
  assert.equal((await api.login('persona')).status, 200)
})

test('solo el administrador puede listar, agregar, activar y eliminar empleados', async (t) => {
  const api = await fixture(t, [employee(employeeCredentials), employee({ id: 'emp-other', username: 'otra', email: 'otra@example.com', active: false })])
  const session = await api.login('persona')
  assert.equal(session.status, 200)
  const before = api.snapshot()
  const requests = [
    ['/employees', {}],
    ['/employees', { method: 'POST', body: { username: 'nueva', email: 'nueva@example.com' } }],
    ['/employees/emp-other', { method: 'PUT', body: { active: true } }],
    ['/employees/emp-other', { method: 'DELETE' }],
  ]
  for (const [path, options] of requests) {
    assert.equal((await api.request(path, options)).status, 401)
    assert.equal((await api.request(path, { ...options, token: session.body.token })).status, 403)
    assert.deepEqual(api.snapshot(), before)
  }
})
