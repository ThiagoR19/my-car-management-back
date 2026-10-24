import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from './server.js'
import { seedDatabase } from './test-fixtures.js'
import { csvEscape, parseCsv, validateVehicle } from './validation.js'
import { dashboard, enrichDocument, expirationStatus, getExpirations } from './domain.js'

async function fixture(t, change = () => {}, options = {}) {
  let store = seedDatabase()
  change(store)
  const servers = []
  async function start() {
    const server = createApiServer({ readStore: async () => structuredClone(store), writeStore: async next => { store = structuredClone(next) }, ...options })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    return server
  }
  let server = await start()
  t.after(async () => { for (const server of servers) if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) })
  const request = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
    return { status: response.status, body: (response.headers.get('Content-Type') || '').includes('application/json') ? await response.json() : await response.text() }
  }
  const login = async (identifier = 'admin', password = 'admin1234') => (await request('/auth/login', { method: 'POST', body: { identifier, password } })).body.token
  return { request, login, snapshot: () => structuredClone(store), restart: async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); server = await start() } }
}

test('renovaciones simultáneas generan una sola versión activa y no aceptan campos ignorados', async t => {
  const api = await fixture(t)
  const token = await api.login()
  assert.equal((await api.request('/documents/doc-1/renew', { method: 'POST', token, body: { expirationDate: '2027-10-19', typeId: 'dt-fire' } })).status, 400)
  const responses = await Promise.all([1, 2].map(() => api.request('/documents/doc-1/renew', { method: 'POST', token, body: { expirationDate: '2027-10-19', issueDate: '2026-10-18', number: '', notes: 'Renovado' } })))
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409])
  const renewed = responses.find(r => r.status === 201).body
  assert.equal(renewed.issueDate, '2026-10-18')
  assert.equal(renewed.number, '')
  assert.equal(renewed.filePath, undefined)
  assert.equal(api.snapshot().documents.filter(d => [d.id, d.previousId].includes('doc-1') && d.active !== false).length, 1)
  assert.equal((await api.request('/documents/doc-1', { method: 'PUT', token, body: { notes: 'Corrección histórica', active: true } })).body.active, false)
  assert.equal((await api.request('/documents/doc-1/renew', { method: 'POST', token, body: { expirationDate: '2028-01-01' } })).status, 409)
})

test('documentos validan fechas, orden, tipos activos y preservan versiones', async t => {
  const api = await fixture(t, store => { store.documentTypes.push({ id: 'inactive', active: false, requiresExpiration: true }) })
  const token = await api.login()
  for (const body of [
    { typeId: 'dt-rto' }, { typeId: 'inexistente', expirationDate: '2027-01-01' }, { typeId: 'inactive', expirationDate: '2027-01-01' },
    { typeId: 'dt-rto', expirationDate: '2026-02-30' }, { typeId: 'dt-rto', issueDate: 'ayer', expirationDate: '2027-01-01' },
    { typeId: 'dt-rto', issueDate: '2027-01-02', expirationDate: '2027-01-01' },
  ]) {
    const before = api.snapshot()
    assert.equal((await api.request('/vehicles/vh-1/documents', { method: 'POST', token, body })).status, 400, JSON.stringify(body))
    assert.deepEqual(api.snapshot(), before)
  }
  for (const body of [{ typeId: 'missing' }, { vehicleId: 'vh-2' }, { expirationDate: '2026-04-31' }]) assert.equal((await api.request('/documents/doc-1', { method: 'PUT', token, body })).status, 400)
  const card = await api.request('/vehicles/vh-1/documents', { method: 'POST', token, body: { typeId: 'dt-card', issueDate: '2026-10-19' } })
  assert.equal(card.status, 201)
  assert.equal(card.body.expirationDate, null)
  assert.equal(card.body.status, 'Sin vencimiento')
  assert.equal((await api.request(`/documents/${card.body.id}/renew`, { method: 'POST', token, body: { issueDate: '2026-10-19', notes: 'Sin vencimiento' } })).status, 201)
})

test('último administrador, roles y contraseñas se validan antes de guardar', async t => {
  const api = await fixture(t)
  const token = await api.login()
  for (const [id, body, status] of [
    ['emp-admin', { role: 'Empleado' }, 409], ['emp-manager', { role: 'root' }, 400], ['emp-manager', { password: 'x' }, 400],
    ['emp-manager', { password: 12345678 }, 400], ['emp-manager', { name: ' ' }, 400],
  ]) {
    const before = api.snapshot()
    assert.equal((await api.request(`/employees/${id}`, { method: 'PUT', token, body })).status, status)
    assert.deepEqual(api.snapshot(), before)
  }
  assert.equal((await api.request('/employees/emp-manager', { method: 'PUT', token, body: { role: 'Administrador' } })).status, 200)
  assert.equal((await api.request('/employees/emp-admin', { method: 'PUT', token, body: { role: 'Empleado' } })).status, 200)
  assert.equal((await api.request('/employees', { token })).status, 403)
})

test('sesiones persisten entre instancias, caducan y el logout se conserva', async t => {
  let now = Date.now()
  const api = await fixture(t, () => {}, { now: () => now, sessionTtlMs: 1000 })
  const token = await api.login()
  assert.equal(api.snapshot().sessions.some(s => s.id === token), false)
  await api.restart()
  assert.equal((await api.request('/auth/me', { token })).status, 200)
  now += 1000
  assert.equal((await api.request('/auth/me', { token })).status, 401)
  const second = await api.login()
  assert.equal((await api.request('/auth/logout', { method: 'POST', token: second })).status, 200)
  await api.restart()
  assert.equal((await api.request('/auth/me', { token: second })).status, 401)
})

test('cambiar contraseñas revoca sesiones previas y conserva solo la sesión de perfil actual', async t => {
  const api = await fixture(t)
  const admin = await api.login(), first = await api.login('ana', 'manager1234'), second = await api.login('ana', 'manager1234')
  assert.equal((await api.request('/auth/me', { method: 'PUT', token: first, body: { currentPassword: 'manager1234', password: 'nueva-clave-1234', passwordConfirmation: 'nueva-clave-1234' } })).status, 200)
  assert.equal((await api.request('/auth/me', { token: first })).status, 200)
  assert.equal((await api.request('/auth/me', { token: second })).status, 401)
  assert.equal((await api.request('/employees/emp-manager', { method: 'PUT', token: admin, body: { password: 'otra-clave-1234' } })).status, 200)
  assert.equal((await api.request('/auth/me', { token: first })).status, 401)
  await api.restart()
  assert.equal((await api.request('/auth/me', { token: first })).status, 401)
})

test('notificaciones conservan lectura y fecha al consultar repetidamente', async t => {
  const api = await fixture(t, store => { store.documents[0].expirationDate = '2000-01-01' })
  const token = await api.login()
  const first = (await api.request('/notifications', { token })).body.items.find(n => n.documentId === 'doc-1')
  await api.request(`/notifications/${first.id}`, { method: 'PUT', token, body: { read: true } })
  await api.restart()
  const second = (await api.request('/notifications', { token })).body.items.find(n => n.id === first.id)
  assert.equal(second.read, true)
  assert.equal(second.createdAt, first.createdAt)
})

test('CSV interpreta comillas, comas, CRLF, BOM y saltos internos y señala filas físicas', () => {
  const cells = ['AA123BB', '1', 'Marca, SA', 'Modelo "Especial"\nDos líneas']
  const rows = parseCsv('\uFEFFPatente,Unidad,Marca,Modelo\r\n' + cells.map(csvEscape).join(',') + '\r\nAA234BB,2,M,F\r\n')
  assert.deepEqual(Object.values(rows[0]), cells)
  assert.equal(rows[1].csvLine, 4)
  assert.throws(() => parseCsv('Patente,Unidad\n"sin cerrar'), /comillas sin cerrar/)
  assert.throws(() => parseCsv('Patente,Patente\nA,B'), /repetidos/)
  assert.throws(() => parseCsv('Patente,Unidad\n"A"B,2'), /inválido/)
})

test('importación rechaza tipos desconocidos o inactivos, estados y columnas, y exporta el tipo derivado', async t => {
  const api = await fixture(t, store => { store.vehicleTypes[1].active = false; store.vehicles.forEach(v => delete v.type) })
  const token = await api.login()
  const csv = 'Patente,Unidad,Tipo,Marca,Modelo,Año,Estado\nNEW001,1,Camión,"Marca, SA",M,2020,Activo\nNEW002,2,INEXISTENTE,M,M,2020,Activo\nNEW003,3,Semirremolque,M,M,2020,Activo\nNEW004,4,Camión,M,M,2020,Desconocido\nNEW005,5,Camión,M,M,2020\n'
  const result = await api.request('/import/vehicles', { method: 'POST', token, body: { csv } })
  assert.equal(result.status, 201)
  assert.equal(result.body.created, 1)
  assert.deepEqual(result.body.errors.map(row => row.row), [3, 4, 5, 6])
  const exported = await api.request('/export/vehicles.csv', { token })
  const row = parseCsv(exported.body).find(row => row.patente === 'NEW001')
  assert.equal(row.tipo, 'Camión')
  assert.equal(row.marca, 'Marca, SA')
})

test('validaciones numéricas, tipos duplicados y renombrado de repuestos rechazan sin cambios', async t => {
  const api = await fixture(t)
  const token = await api.login()
  for (const [path, method, body, status] of [
    ['/document-types', 'POST', { name: 'rto' }, 409], ['/document-types/dt-insurance', 'PUT', { name: ' RTO ' }, 409],
    ['/document-types', 'POST', { name: 'Otro', alertDays: -1 }, 400], ['/document-types', 'POST', { name: 'Otro', alertDays: 1.5 }, 400],
    ['/document-types', 'POST', { name: 'Otro', requiresExpiration: 'false' }, 400], ['/vehicle-types/vt-truck', 'PUT', { active: 'false' }, 400],
    ['/parts/prt-1', 'PUT', { stock: 10, name: 'Filtro de aceite' }, 409], ['/parts/prt-1', 'PUT', { stock: null }, 400],
    ['/settings', 'PUT', { urgentDays: 31 }, 400], ['/settings', 'PUT', { firstAlertDays: 1.5 }, 400],
  ]) {
    const before = api.snapshot()
    assert.equal((await api.request(path, { method, token, body })).status, status, path + JSON.stringify(body))
    assert.deepEqual(api.snapshot(), before)
  }
  const zero = await api.request('/document-types', { method: 'POST', token, body: { name: 'Al vencer', alertDays: 0 } })
  assert.equal(zero.body.alertDays, 0)
  for (const changes of [{ year: 2020.5 }, { year: 'abc' }, { mileage: 2.5 }, { mileage: 2147483648 }, { status: 'INVALIDO' }]) assert.throws(() => validateVehicle({ ...api.snapshot().vehicles[0], ...changes }))
})

test('alertas aplican umbrales generales y por tipo, y reconocen enero como próximo mes', () => {
  const now = new Date('2026-12-01T12:00:00')
  const doc = { expirationDate: '2026-12-11' }
  assert.equal(expirationStatus(doc, { alertDays: null }, now, { firstAlertDays: 5, secondAlertDays: 3, urgentDays: 1 }).label, 'Vigente')
  assert.equal(expirationStatus(doc, { alertDays: null }, now, { firstAlertDays: 20, secondAlertDays: 15, urgentDays: 1 }).tone, 'danger')
  assert.equal(expirationStatus(doc, { alertDays: null }, now, { firstAlertDays: 20, secondAlertDays: 5, urgentDays: 1 }).tone, 'warning')
  assert.equal(expirationStatus(doc, { alertDays: 20 }, now, { urgentDays: 10 }).label, 'Muy próximo')
  assert.equal(expirationStatus({ expirationDate: '2027-01-15' }, { alertDays: 0 }, now).label, 'Próximo mes')
})

test('dashboard detecta requisitos faltantes y los vencimientos incluyen responsable y unidad', () => {
  const store = seedDatabase()
  store.vehicleTypes[0].requiredDocumentTypeIds = ['dt-card']
  assert.ok(dashboard(store).incompleteVehicleIds.includes('vh-1'))
  const document = enrichDocument(store.documents[0], store)
  assert.equal(document.owner, 'Juan Pérez')
  assert.equal(document.vehicleUnit, '24')
  assert.ok(getExpirations(store, { q: '24' }).some(d => d.id === 'doc-1'))
})
