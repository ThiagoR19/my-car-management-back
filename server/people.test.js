import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { createApiServer } from './server.js'
import { buildEmailReport } from './email.js'
import { dashboard, getExpirations } from './domain.js'

const personData = (overrides = {}) => ({ firstName: 'Ana', lastName: 'García', identificationType: 'DNI', identificationNumber: '30123456', email: 'ana@example.test', phone: '+54 11 1234 5678', birthDate: '1990-05-12', address: 'San Martín 123', city: 'Buenos Aires', province: 'Buenos Aires', nationality: 'Argentina', notes: '', active: true, ...overrides })

function fixture(overrides = {}) {
  const token = 'people-test-session'
  let store = {
    employees: [{ id: 'employee', name: 'Operación', role: 'Empleado', active: true }],
    sessions: [{ id: createHash('sha256').update(token).digest('hex'), employeeId: 'employee', expiresAt: '2099-01-01T00:00:00Z' }],
    accessRequests: [], people: [],
    vehicleTypes: [{ id: 'truck', name: 'Camión', active: true }],
    documentTypes: [{ id: 'license', name: 'Licencia de conducir', requiresExpiration: true, active: true }, { id: 'identity', name: 'Identidad', requiresExpiration: false, active: true }],
    vehicles: [{ id: 'vehicle', unit: '24', plate: 'AB123CD', typeId: 'truck', brand: 'Marca', model: 'Modelo', status: 'Activo', mileage: 0, driver: '' }],
    documents: [], audit: [], notifications: [],
    settings: { companyName: 'Flota', firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7, timezone: 'America/Argentina/Buenos_Aires' },
    ...overrides,
  }
  const server = createApiServer({ corsOrigins: '*', readStore: async () => structuredClone(store), writeStore: async (next) => { store = structuredClone(next) } })
  function request(path, { method = 'GET', body, authenticated = true } = {}) {
    return new Promise((resolve) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method, url: `/api${path}`, headers: { host: 'localhost', ...(body !== undefined && { 'content-type': 'application/json' }), ...(authenticated && { authorization: `Bearer ${token}` }) } })
      const headers = {}
      let status
      const res = {
        setHeader(name, value) { headers[name] = value },
        getHeader(name) { return headers[name] },
        writeHead(code, nextHeaders) { status = code; Object.assign(headers, nextHeaders) },
        end(raw) {
          const text = String(raw ?? '')
          resolve({ status, headers, body: headers['Content-Type']?.includes('application/json') ? JSON.parse(text) : text })
        },
      }
      server.emit('request', req, res)
    })
  }
  return { request, snapshot: () => structuredClone(store) }
}

test('Personas requiere sesión y permite crear, buscar, editar y dar de baja con datos esenciales', async () => {
  const api = fixture()
  assert.equal((await api.request('/people', { authenticated: false })).status, 401)
  const created = await api.request('/people', { method: 'POST', body: personData() })
  assert.equal(created.status, 201)
  const id = created.body.id
  assert.equal(created.body.name, 'Ana García')
  assert.equal(created.body.documentCount, 0)
  assert.equal(created.body.birthDate, '1990-05-12')
  assert.deepEqual(created.body.vehicles, [])
  assert.equal((await api.request('/people?q=30123456')).body.total, 1)
  assert.equal((await api.request('/people?q=no-existe')).body.total, 0)
  assert.equal((await api.request(`/people/${id}`, { method: 'PUT', body: { phone: '999', notes: 'Actualizado' } })).body.phone, '999')
  assert.equal((await api.request(`/people/${id}`, { method: 'DELETE' })).body.active, false)
  assert.equal((await api.request('/people?active=true')).body.total, 0)
  assert.equal((await api.request('/people?active=false')).body.total, 1)
  assert.equal((await api.request(`/people/${id}`, { method: 'PUT', body: { active: true } })).body.active, true)
  assert.equal(api.snapshot().audit.filter((item) => item.entity === 'person').length, 4)
})

test('rechaza identificación duplicada, fechas imposibles, email inválido y campos obligatorios vacíos', async () => {
  const api = fixture()
  for (const change of [{ firstName: '' }, { lastName: '' }, { identificationNumber: '' }, { birthDate: '2026-02-30' }, { birthDate: '2999-01-01' }, { email: 'invalido' }, { active: 'true' }, { firstName: 'a'.repeat(256) }]) {
    const result = await api.request('/people', { method: 'POST', body: personData(change) })
    assert.equal(result.status, 400, JSON.stringify(change))
  }
  assert.equal(api.snapshot().people.length, 0)
  assert.equal((await api.request('/people', { method: 'POST', body: personData() })).status, 201)
  assert.equal((await api.request('/people', { method: 'POST', body: personData({ identificationType: 'dni' }) })).status, 409)
  assert.equal((await api.request('/people', { method: 'POST', body: personData({ identificationType: 'Pasaporte' }) })).status, 201)
  const second = api.snapshot().people[1]
  assert.equal((await api.request(`/people/${second.id}`, { method: 'PUT', body: { identificationType: 'DNI' } })).status, 409)
})

test('asigna, reasigna y desasigna una persona sin perder datos del vehículo y valida referencias', async () => {
  const api = fixture({ people: [{ id: 'p1', ...personData() }, { id: 'p2', ...personData({ firstName: 'Luis', identificationNumber: '40123456' }) }, { id: 'inactive', ...personData({ active: false }) }] })
  assert.equal((await api.request('/vehicles/vehicle', { method: 'PUT', body: { personId: 'missing' } })).status, 400)
  assert.equal((await api.request('/vehicles/vehicle', { method: 'PUT', body: { personId: 'inactive' } })).status, 400)
  const assigned = await api.request('/vehicles/vehicle', { method: 'PUT', body: { personId: 'p1' } })
  assert.equal(assigned.status, 200)
  assert.equal(assigned.body.driver, 'Ana García')
  assert.equal(assigned.body.plate, 'AB123CD')
  assert.equal((await api.request('/people/p1')).body.vehicleCount, 1)
  assert.equal((await api.request('/vehicles/vehicle', { method: 'PUT', body: { personId: 'p2' } })).body.personName, 'Luis García')
  await api.request('/people/p2', { method: 'PUT', body: { firstName: 'Lucía' } })
  assert.equal((await api.request('/vehicles/vehicle')).body.driver, 'Lucía García')
  assert.equal((await api.request('/people/p1')).body.vehicleCount, 0)
  assert.equal((await api.request('/people/p2')).body.vehicles[0].id, 'vehicle')
  assert.equal((await api.request('/vehicles/vehicle', { method: 'PUT', body: { personId: null } })).body.personId, null)
  assert.equal((await api.request('/people/p2')).body.vehicleCount, 0)
  assert.ok(api.snapshot().audit.filter((item) => item.entity === 'vehicle').every((item) => item.data.changedFields.includes('personId')))
})

test('conserva una asignación previa al inactivar la persona y bloquea reutilizarla en otro vehículo', async () => {
  const vehicle = { id: 'vehicle', unit: '24', plate: 'AB123CD', typeId: 'truck', brand: 'Marca', model: 'Modelo', status: 'Activo', mileage: 0, personId: 'inactive' }
  const api = fixture({ people: [{ id: 'inactive', ...personData({ active: false }) }], vehicles: [vehicle, { ...vehicle, id: 'other', plate: 'AB456CD', personId: null }] })
  assert.equal((await api.request('/vehicles/vehicle', { method: 'PUT', body: { notes: 'Mantenimiento' } })).status, 200)
  assert.equal((await api.request('/vehicles/other', { method: 'PUT', body: { id: 'vehicle', personId: 'inactive' } })).status, 400)
  assert.equal((await api.request('/vehicles', { method: 'POST', body: { ...vehicle, plate: 'AB789CD' } })).status, 400)
  assert.equal((await api.request('/vehicles/vehicle', { method: 'PUT', body: { personId: null } })).status, 200)
})

test('los documentos personales reutilizan tipos y renovación, conservan historial y bloquean cambios de titular', async () => {
  const api = fixture({ people: [{ id: 'p1', ...personData() }, { id: 'p2', ...personData({ identificationNumber: '40123456' }) }] })
  for (const body of [{ typeId: 'license' }, { typeId: 'missing', expirationDate: '2030-01-01' }, { typeId: 'license', expirationDate: '2030-02-30' }, { typeId: 'identity', vehicleId: 'vehicle' }]) {
    assert.equal((await api.request('/people/p1/documents', { method: 'POST', body })).status, 400)
  }
  const created = await api.request('/people/p1/documents', { method: 'POST', body: { typeId: 'license', number: 'LIC-1', issueDate: '2026-01-01', expirationDate: '2027-01-01' } })
  assert.equal(created.status, 201)
  const document = created.body
  assert.equal(document.personId, 'p1')
  assert.equal(document.vehicleId, undefined)
  assert.equal(document.personName, 'Ana García')
  assert.equal(document.ownerType, 'person')
  assert.equal((await api.request('/people/p1')).body.documentCount, 1)
  for (const [method, path, body] of [['PUT', `/documents/${document.id}`, { personId: 'p2' }], ['PUT', `/documents/${document.id}`, { vehicleId: 'vehicle' }], ['POST', `/documents/${document.id}/renew`, { personId: 'p2', expirationDate: '2028-01-01' }]]) {
    assert.equal((await api.request(path, { method, body })).status, 400)
  }
  const options = { method: 'POST', body: { issueDate: '2027-01-01', expirationDate: '2028-01-01' } }
  const renewals = await Promise.all([api.request(`/documents/${document.id}/renew`, options), api.request(`/documents/${document.id}/renew`, options)])
  assert.deepEqual(renewals.map((result) => result.status).sort(), [201, 409])
  const renewed = renewals.find((result) => result.status === 201).body
  assert.equal(renewed.personId, 'p1')
  assert.equal(renewed.previousId, document.id)
  assert.equal(renewed.rootId, document.id)
  assert.equal(renewed.version, 2)
  assert.equal((await api.request(`/documents/${document.id}`, { method: 'PUT', body: { notes: 'Corrección histórica', active: true } })).body.active, false)
  assert.equal((await api.request('/people/p1/documents')).body.items.length, 2)
  assert.equal((await api.request('/people/p1')).body.documents[0].id, renewed.id)
  assert.equal((await api.request(`/documents/${renewed.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await api.request('/people/p1')).body.documentCount, 0)
  const identity = await api.request('/people/p1/documents', { method: 'POST', body: { typeId: 'identity', expirationDate: '2030-01-01' } })
  assert.equal(identity.body.expirationDate, null)
})

test('adjunta y descarga archivos personales con autenticación y conserva adjunto al renovar', async (t) => {
  const api = fixture({ people: [{ id: 'p1', ...personData() }] })
  const created = await api.request('/people/p1/documents', { method: 'POST', body: { typeId: 'identity' } })
  const id = created.body.id
  const upload = await api.request(`/documents/${id}/file`, { method: 'POST', body: { fileName: 'identificacion.pdf', mimeType: 'application/pdf', fileBase64: Buffer.from('%PDF-test').toString('base64') } })
  assert.equal(upload.status, 200)
  t.after(() => unlinkSync(api.snapshot().documents.find((item) => item.id === id).filePath))
  assert.equal((await api.request(`/files/${id}`, { authenticated: false })).status, 401)
  assert.equal((await api.request(`/files/${id}`)).body, '%PDF-test')
  const renewed = await api.request(`/documents/${id}/renew`, { method: 'POST', body: { expirationDate: null } })
  assert.equal(renewed.status, 201)
  assert.equal(renewed.body.filePath, undefined)
  assert.equal((await api.request(`/files/${id}`)).body, '%PDF-test')
})

test('Tipos de documentos protege los tipos usados por personas y aplica su configuración compartida', async () => {
  const api = fixture({ employees: [{ id: 'employee', name: 'Administración', role: 'Administrador', active: true }], people: [{ id: 'p1', ...personData() }], documents: [{ id: 'personal', personId: 'p1', typeId: 'identity', expirationDate: null, active: true }] })
  assert.equal((await api.request('/document-types/identity', { method: 'DELETE' })).status, 409)
  assert.equal((await api.request('/document-types/identity', { method: 'PUT', body: { requiresExpiration: true } })).status, 409)
  assert.equal((await api.request('/document-types/license', { method: 'PUT', body: { active: false } })).status, 200)
  assert.equal((await api.request('/people/p1/documents', { method: 'POST', body: { typeId: 'license', expirationDate: '2030-01-01' } })).status, 400)
  await api.request('/document-types/identity', { method: 'PUT', body: { name: 'Documento de identidad' } })
  assert.equal((await api.request('/people/p1')).body.documents[0].typeName, 'Documento de identidad')
})

test('vencimientos, panel, notificaciones y correo incluyen personas activas y distinguen vehículos', async () => {
  const api = fixture({
    people: [{ id: 'p1', ...personData() }, { id: 'inactive', ...personData({ active: false }) }],
    documents: [{ id: 'personal', personId: 'p1', typeId: 'license', expirationDate: '2000-01-01', active: true }, { id: 'inactive-doc', personId: 'inactive', typeId: 'license', expirationDate: '2000-01-01', active: true }, { id: 'vehicular', vehicleId: 'vehicle', typeId: 'license', expirationDate: '2000-01-01', active: true }],
  })
  const expirations = await api.request('/expirations?q=30123456')
  assert.equal(expirations.body.items.length, 1)
  assert.equal(expirations.body.items[0].personId, 'p1')
  assert.equal((await api.request('/expirations?ownerType=vehicle')).body.items.length, 1)
  const result = (await api.request('/dashboard')).body
  assert.equal(result.overdueDocuments, 2)
  assert.equal(result.overdueVehicleCount, 1)
  assert.equal(result.overduePersonCount, 1)
  const notifications = (await api.request('/notifications')).body.items
  assert.equal(notifications.length, 2)
  assert.ok(notifications.some((item) => item.description.includes('Ana García')))
  assert.match(buildEmailReport(api.snapshot(), { subject: 'Informe', notes: '' }).text, /Ana García · DNI 30123456/)
  assert.match((await api.request('/export/expirations.csv')).body, /Ana García/)
  const before = api.snapshot()
  assert.equal(getExpirations(before, { personId: 'p1' }).length, 1)
  assert.equal(dashboard(before).overduePersonCount, 1)
  await api.request('/people/p1', { method: 'DELETE' })
  assert.equal((await api.request('/expirations?ownerType=person')).body.items.length, 0)
  assert.equal((await api.request('/people/p1/documents', { method: 'POST', body: { typeId: 'identity' } })).status, 400)
})
