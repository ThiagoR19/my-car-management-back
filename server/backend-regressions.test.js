import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createApiServer } from './server.js'
import { passwordRecord } from './store.js'
import { csvEscape } from './validation.js'

const password = 'prueba-segura-123'
const credentials = passwordRecord(password)

function fixture(overrides = {}) {
  let store = {
    employees: [
      { id: 'admin', name: 'Administración', username: 'admin', email: 'admin@example.test', role: 'Administrador', active: true, ...credentials },
      { id: 'employee', name: 'Operación', username: 'empleado', email: 'empleado@example.test', role: 'Empleado', active: true, ...credentials },
    ],
    accessRequests: [],
    vehicleTypes: [{ id: 'truck', name: 'Camión', active: true }, { id: 'pickup', name: 'Camioneta', active: true }],
    documentTypes: [
      { id: 'required', name: 'Seguro', requiresExpiration: true, alertDays: 30, active: true },
      { id: 'optional', name: 'Cédula', requiresExpiration: false, alertDays: 0, active: true },
    ],
    vehicles: [{ id: 'vehicle', plate: 'AB123CD', unit: '24', typeId: 'truck', brand: 'Marca', model: 'Modelo', year: 2020, status: 'Activo', mileage: 0 }],
    documents: [{ id: 'document', vehicleId: 'vehicle', typeId: 'required', number: 'Anterior', issueDate: '2026-01-01', expirationDate: '2030-01-01', notes: 'Nota anterior', active: true, version: 1 }],
    audit: [], notifications: [],
    settings: { companyName: 'Flota', firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7, timezone: 'America/Argentina/Buenos_Aires' },
    ...overrides,
  }
  // Exercise the real request dispatcher and mutation queue without sockets or a database.
  const server = createApiServer({
    readStore: async () => structuredClone(store),
    writeStore: async (next) => { store = structuredClone(next) },
  })
  function request(path, { method = 'GET', body, token } = {}) {
    return new Promise((resolve) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method, url: `/api${path}`, headers: { host: 'localhost', ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) } })
      let status
      let headers = {}
      const res = {
        setHeader(name, value) { headers[name] = value },
        writeHead(code, nextHeaders) { status = code; Object.assign(headers, nextHeaders) },
        end(raw) {
          const text = String(raw ?? '')
          resolve({ status, headers, body: headers['Content-Type']?.includes('application/json') ? JSON.parse(text) : text })
        },
      }
      server.emit('request', req, res)
    })
  }
  async function login(identifier = 'admin', loginPassword = password) {
    const result = await request('/auth/login', { method: 'POST', body: { identifier, password: loginPassword } })
    assert.equal(result.status, 200)
    return result.body.token
  }
  return { request, login, snapshot: () => structuredClone(store) }
}

test('valida fechas reales, su orden y el requisito de vencimiento del tipo', async () => {
  const api = fixture({ documents: [] })
  const token = await api.login()
  for (const body of [
    { typeId: 'required' },
    { typeId: 'unknown', expirationDate: '2030-01-01' },
    { typeId: 'required', expirationDate: '2030-02-30' },
    { typeId: 'required', expirationDate: 'fecha incorrecta' },
    { typeId: 'required', issueDate: '2031-01-01', expirationDate: '2030-01-01' },
  ]) {
    assert.equal((await api.request('/vehicles/vehicle/documents', { method: 'POST', token, body })).status, 400)
    assert.equal(api.snapshot().documents.length, 0)
  }
  const result = await api.request('/vehicles/vehicle/documents', { method: 'POST', token, body: { typeId: 'optional', issueDate: '2026-01-01' } })
  assert.equal(result.status, 201)
  assert.equal(result.body.expirationDate, null)
  assert.equal(result.body.status, 'Sin vencimiento')
})

test('limita intentos públicos por IP y neutraliza fórmulas de planillas', async () => {
  const api = fixture()
  const attempts = await Promise.all(Array.from({ length: 21 }, () => api.request('/auth/login', { method: 'POST', body: { identifier: 'admin', password: 'incorrecta' } })))
  assert.equal(attempts.filter((response) => response.status === 429).length, 1)
  assert.equal(csvEscape('=HYPERLINK("https://example.test")'), '"\'=HYPERLINK(""https://example.test"")"')
})

test('dos renovaciones simultáneas crean un solo sucesor y conservan el adjunto en el original', async () => {
  const api = fixture({ documents: [{ id: 'document', vehicleId: 'vehicle', typeId: 'optional', issueDate: '2026-01-01', expirationDate: null, active: true, version: 1, fileName: 'anterior.pdf', filePath: 'adjunto-anterior.pdf', mimeType: 'application/pdf', sizeBytes: 20 }] })
  const token = await api.login()
  assert.equal((await api.request('/documents/document/renew', { method: 'POST', token, body: { typeId: 'required', expirationDate: '2031-01-01' } })).status, 400)
  const options = { method: 'POST', token, body: { typeId: 'optional', issueDate: '2031-01-02', expirationDate: null, number: '', notes: 'Nueva versión' } }
  const results = await Promise.all([api.request('/documents/document/renew', options), api.request('/documents/document/renew', options)])
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
  const store = api.snapshot()
  assert.equal(store.documents.length, 2)
  assert.equal(store.documents[0].active, false)
  assert.equal(store.documents[0].fileName, 'anterior.pdf')
  const renewed = store.documents[1]
  assert.equal(renewed.previousId, 'document')
  assert.equal(renewed.version, 2)
  assert.equal(renewed.typeId, 'optional')
  assert.equal(renewed.issueDate, '2031-01-02')
  assert.equal(renewed.number, '')
  assert.equal(renewed.expirationDate, null)
  for (const field of ['fileName', 'filePath', 'mimeType', 'sizeBytes']) assert.equal(Object.hasOwn(renewed, field), false)
})

test('editar un documento histórico conserva su baja y la nueva versión permanece vigente', async () => {
  const api = fixture()
  const token = await api.login()
  const renewed = await api.request('/documents/document/renew', { method: 'POST', token, body: { issueDate: '2030-01-01', expirationDate: '2031-01-01' } })
  assert.equal(renewed.status, 201)
  const edited = await api.request('/documents/document', { method: 'PUT', token, body: { notes: 'Corrección histórica', active: true } })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.active, false)
  const history = await api.request('/vehicles/vehicle/documents', { token })
  assert.equal(history.body.items.length, 2)
  assert.equal(api.snapshot().documents.filter((document) => document.active).length, 1)
  const vehicle = await api.request('/vehicles/vehicle', { token })
  assert.deepEqual(vehicle.body.documents.map((document) => document.id), [renewed.body.id])
})

test('dar de baja documentación conserva historial y bloquea su renovación', async () => {
  const api = fixture()
  const token = await api.login()
  assert.equal((await api.request('/documents/document', { method: 'DELETE', token })).status, 200)
  assert.equal((await api.request('/vehicles/vehicle/documents', { token })).body.items.length, 1)
  assert.equal((await api.request('/vehicles/vehicle', { token })).body.documents.length, 0)
  assert.equal((await api.request('/vehicles/vehicle', { token })).body.documentationIncomplete, true)
  assert.equal((await api.request('/documents/document/renew', { method: 'POST', token, body: { expirationDate: '2031-01-01' } })).status, 409)
})

test('el detalle y el dashboard usan el mismo criterio de documentación incompleta y exponen la fecha de la app', async () => {
  const api = fixture({ documents: [] })
  const token = await api.login('empleado')
  const dashboard = await api.request('/dashboard', { token })
  assert.equal(dashboard.status, 200)
  assert.match(dashboard.body.today, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(dashboard.body.timezone, 'America/Argentina/Buenos_Aires')
  assert.equal(dashboard.body.incompleteVehicles, 1)
  assert.equal((await api.request('/vehicles/vehicle', { token })).body.documentationIncomplete, true)
  const changed = await api.request('/vehicles/vehicle', { method: 'PUT', token, body: { status: 'En mantenimiento' } })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.documentationIncomplete, false)
  assert.equal((await api.request('/dashboard', { token })).body.incompleteVehicles, 0)
})

test('exportar e importar conserva tipo, estado, comillas, comas y campos multilínea', async () => {
  const vehicle = { id: 'vehicle', plate: 'AB123CD', unit: '24', typeId: 'truck', brand: 'Marca', model: 'Modelo, "especial"', year: 2020, status: 'Fuera de servicio', mileage: 1234, chassis: 'CH123', engine: 'MO123', color: 'Azul', branch: 'Sucursal, Norte', driver: 'Persona', notes: 'Primera línea\nSegunda "línea"' }
  const source = fixture({ vehicles: [vehicle], documents: [] })
  const exported = await source.request('/export/vehicles.csv', { token: await source.login() })
  assert.equal(exported.status, 200)
  assert.match(exported.body, /Camión/)
  const target = fixture({ vehicles: [], documents: [] })
  const result = await target.request('/import/vehicles', { method: 'POST', token: await target.login(), body: { csv: `\uFEFF${exported.body.replaceAll('\n', '\r\n')}` } })
  assert.equal(result.status, 201)
  assert.deepEqual(result.body, { created: 1, errors: [] })
  const imported = target.snapshot().vehicles[0]
  for (const field of ['plate', 'unit', 'typeId', 'brand', 'model', 'year', 'status', 'mileage', 'chassis', 'engine', 'color', 'branch', 'driver']) assert.equal(imported[field], vehicle[field], field)
  assert.equal(imported.notes.replaceAll('\r\n', '\n'), vehicle.notes)
})

test('CSV informa encabezados faltantes, tipo desconocido, año inválido y fila original', async () => {
  const api = fixture({ vehicles: [], documents: [] })
  const token = await api.login()
  const missing = await api.request('/import/vehicles', { method: 'POST', token, body: { csv: 'Patente,Tipo,Marca,Modelo\nAB123CD,Camión,Marca,Modelo' } })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /unidad/)
  const invalid = await api.request('/import/vehicles', { method: 'POST', token, body: { csv: 'Patente,Unidad,Tipo,Marca,Modelo,Año\n\nAB123CD,24,Desconocido,Marca,Modelo,2020\nAB124CD,25,Camión,Marca,Modelo,no-es-un-año\nAB125CD,26,Camión,Marca,Modelo,2020' } })
  assert.equal(invalid.status, 201)
  assert.equal(invalid.body.created, 1)
  assert.deepEqual(invalid.body.errors.map((item) => item.row), [3, 4])
  assert.match(invalid.body.errors[0].error, /Tipo de vehículo no reconocido/)
  assert.match(invalid.body.errors[1].error, /año/)
  const malformed = await api.request('/import/vehicles', { method: 'POST', token, body: { csv: 'Patente,Unidad,Tipo,Marca,Modelo\nAB127CD,27,Camión,Marca,"sin cierre' } })
  assert.equal(malformed.status, 400)
  assert.match(malformed.body.error, /comillas/)
})

test('leer notificaciones mantiene su estado leído y fecha de creación', async () => {
  const api = fixture({ documents: [{ id: 'document', vehicleId: 'vehicle', typeId: 'required', expirationDate: '2000-01-01', active: true }] })
  const token = await api.login()
  const first = await api.request('/notifications', { token })
  const notification = first.body.items[0]
  assert.equal(notification.read, false)
  assert.equal((await api.request(`/notifications/${notification.id}`, { method: 'PUT', token, body: { read: true } })).status, 200)
  const second = await api.request('/notifications', { token })
  assert.equal(second.body.items[0].read, true)
  assert.equal(second.body.items[0].createdAt, notification.createdAt)
})

test('cambiar contraseña de perfil revoca otras sesiones y mantiene la sesión actual', async () => {
  const api = fixture()
  const current = await api.login('empleado')
  const other = await api.login('empleado')
  const result = await api.request('/auth/me', { method: 'PUT', token: current, body: { currentPassword: password, password: 'nueva-clave-123', passwordConfirmation: 'nueva-clave-123' } })
  assert.equal(result.status, 200)
  assert.equal((await api.request('/auth/me', { token: current })).status, 200)
  assert.equal((await api.request('/auth/me', { token: other })).status, 401)
  assert.equal((await api.request('/auth/login', { method: 'POST', body: { identifier: 'empleado', password } })).status, 401)
  await api.login('empleado', 'nueva-clave-123')
})

test('reset administrativo exige ocho caracteres y revoca todas las sesiones del empleado', async () => {
  const api = fixture()
  const admin = await api.login()
  const sessions = [await api.login('empleado'), await api.login('empleado')]
  const before = api.snapshot()
  for (const invalid of ['x', '', 12345678, null]) {
    assert.equal((await api.request('/employees/employee', { method: 'PUT', token: admin, body: { password: invalid } })).status, 400)
    assert.deepEqual(api.snapshot(), before)
  }
  assert.equal((await api.request('/employees/employee', { method: 'PUT', token: admin, body: { password: 'restablecida-123' } })).status, 200)
  for (const token of sessions) assert.equal((await api.request('/auth/me', { token })).status, 401)
  assert.equal((await api.request('/auth/me', { token: admin })).status, 200)
  await api.login('empleado', 'restablecida-123')
})

test('no se puede degradar, desactivar o eliminar al último administrador activo', async () => {
  const api = fixture()
  const token = await api.login()
  const before = api.snapshot()
  for (const body of [{ role: 'Empleado' }, { active: false }, { role: 'Empleado', active: false }]) {
    const result = await api.request('/employees/admin', { method: 'PUT', token, body })
    assert.equal(result.status, 409)
    assert.match(result.body.error, /al menos un administrador/)
    assert.deepEqual(api.snapshot(), before)
  }
  assert.equal((await api.request('/employees/admin', { method: 'DELETE', token })).status, 409)
  assert.deepEqual(api.snapshot(), before)
  const created = await api.request('/employees', { method: 'POST', token, body: { username: 'segundo', email: 'segundo@example.test', role: 'Administrador', password } })
  assert.equal(created.status, 201)
  const secondToken = await api.login('segundo')
  assert.equal((await api.request('/employees/admin', { method: 'PUT', token: secondToken, body: { role: 'Empleado' } })).status, 200)
  assert.equal((await api.request(`/employees/${created.body.id}`, { method: 'PUT', token: secondToken, body: { role: 'Empleado' } })).status, 409)
})

test('el historial API conserva acceso a más de cien eventos mediante páginas', async () => {
  const audit = Array.from({ length: 130 }, (_, index) => ({ id: `audit-${index}`, entity: 'profile', entityId: 'admin', action: 'updated', employeeName: 'Admin', data: {} }))
  const api = fixture({ audit })
  const token = await api.login()
  const first = await api.request('/audit', { token })
  assert.equal(first.status, 200)
  assert.deepEqual({ total: first.body.total, page: first.body.page, pageSize: first.body.pageSize, totalPages: first.body.totalPages }, { total: 130, page: 1, pageSize: 30, totalPages: 5 })
  assert.deepEqual(first.body.items.map((item) => item.id), audit.slice(0, 30).map((item) => item.id))
  const last = await api.request('/audit?page=5', { token })
  assert.deepEqual(last.body.items.map((item) => item.id), audit.slice(120).map((item) => item.id))
  // Valores fuera de rango no fallan: la página se ajusta y el tamaño queda acotado a 100.
  assert.equal((await api.request('/audit?page=99', { token })).body.page, 5)
  assert.equal((await api.request('/audit?page=-3&pageSize=abc', { token })).body.page, 1)
  assert.equal((await api.request('/audit?pageSize=5000', { token })).body.items.length, 100)
})

test('el historial API busca en todo el historial y vuelve a contar las páginas', async () => {
  const audit = Array.from({ length: 70 }, (_, index) => ({ id: `audit-${index}`, entity: 'vehicle', entityId: 'vh-1', action: index % 10 === 0 ? 'renewed' : 'updated', employeeName: index === 65 ? 'Carla Gómez' : 'Admin', data: { plate: `AB${index}CD` } }))
  const api = fixture({ audit })
  const token = await api.login()
  const renewed = await api.request(`/audit?q=${encodeURIComponent('renovó')}`, { token })
  assert.deepEqual({ total: renewed.body.total, totalPages: renewed.body.totalPages }, { total: 7, totalPages: 1 })
  assert.ok(renewed.body.items.every((item) => item.action === 'renewed'))
  assert.deepEqual((await api.request('/audit?q=gomez', { token })).body.items.map((item) => item.id), ['audit-65'])
  assert.deepEqual((await api.request('/audit?q=AB42CD', { token })).body.items.map((item) => item.id), ['audit-42'])
})

test('configuración rechaza umbrales negativos, fraccionarios, desordenados y zonas inexistentes', async () => {
  const api = fixture()
  const token = await api.login()
  const before = api.snapshot()
  for (const body of [{ urgentDays: -1 }, { firstAlertDays: 2.5 }, { firstAlertDays: 'abc' }, { urgentDays: 20 }, { firstAlertDays: 10 }, { timezone: 'Mars/Olympus' }, { companyName: '' }]) {
    assert.equal((await api.request('/settings', { method: 'PUT', token, body })).status, 400)
    assert.deepEqual(api.snapshot(), before)
  }
  const saved = await api.request('/settings', { method: 'PUT', token, body: { firstAlertDays: 0, secondAlertDays: 0, urgentDays: 0, timezone: 'UTC' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.urgentDays, 0)
})

test('tipos de documento conservan flags omitidos y permiten heredar o desactivar alertas', async () => {
  const api = fixture()
  const token = await api.login()
  const created = await api.request('/document-types', { method: 'POST', token, body: { name: 'Sin vencimiento', requiresExpiration: false } })
  assert.equal(created.status, 201)
  assert.equal(created.body.alertDays, null)
  const updated = await api.request(`/document-types/${created.body.id}`, { method: 'PUT', token, body: { name: 'Nombre nuevo', alertDays: 0 } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.requiresExpiration, false)
  assert.equal(updated.body.alertDays, 0)
  assert.equal((await api.request(`/document-types/${created.body.id}`, { method: 'PUT', token, body: { alertDays: -1 } })).status, 400)
  const inherited = await api.request(`/document-types/${created.body.id}`, { method: 'PUT', token, body: { alertDays: null } })
  assert.equal(inherited.body.alertDays, null)
})
