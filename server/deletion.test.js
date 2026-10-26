import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createApiServer } from './server.js'
import { uploadsDir } from './store.js'

function fixture(overrides = {}) {
  const token = 'delete-test-session'
  let failWrites = false
  let store = {
    employees: [{ id: 'employee', name: 'Operación', role: 'Empleado', active: true }],
    sessions: [{ id: createHash('sha256').update(token).digest('hex'), employeeId: 'employee', expiresAt: '2099-01-01T00:00:00Z' }],
    people: [{ id: 'person', firstName: 'Ana', lastName: 'García', identificationType: 'DNI', identificationNumber: '30123456', active: true }],
    vehicleTypes: [{ id: 'truck', name: 'Camión', active: true }],
    documentTypes: [{ id: 'license', name: 'Licencia', requiresExpiration: true, active: true }],
    vehicles: [{ id: 'vehicle', unit: '24', plate: 'AB123CD', typeId: 'truck', brand: 'Marca', model: 'Modelo', status: 'Activo', mileage: 0, personId: 'person', driver: 'Responsable anterior' }],
    documents: [], parts: [{ id: 'part', name: 'Aceite', stock: 6, unit: 'unidad' }], repairs: [], notifications: [], audit: [],
    settings: { timezone: 'America/Argentina/Buenos_Aires' },
    ...overrides,
  }
  const server = createApiServer({
    corsOrigins: '*', readStore: async () => structuredClone(store),
    writeStore: async (next) => {
      if (failWrites) throw new Error('Fallo de persistencia de prueba')
      store = structuredClone(next)
    },
  })
  function request(path, { method = 'GET', authenticated = true } = {}) {
    return new Promise((resolve) => {
      const req = Readable.from([])
      Object.assign(req, { method, url: `/api${path}`, headers: { host: 'localhost', ...(authenticated && { authorization: `Bearer ${token}` }) } })
      const headers = {}
      let status
      server.emit('request', req, {
        setHeader(name, value) { headers[name] = value },
        getHeader(name) { return headers[name] },
        writeHead(code, values) { status = code; Object.assign(headers, values) },
        end(raw) { resolve({ status, body: JSON.parse(String(raw)) }) },
      })
    })
  }
  return { request, snapshot: () => structuredClone(store), failWrites: () => { failWrites = true } }
}

function file(t, outside = false) {
  mkdirSync(uploadsDir, { recursive: true })
  const filePath = join(outside ? tmpdir() : uploadsDir, `delete-test-${randomUUID()}.pdf`)
  writeFileSync(filePath, '%PDF-1.4\n')
  t.after(() => { if (existsSync(filePath)) unlinkSync(filePath) })
  return filePath
}

test('eliminar personas y vehículos exige sesión y rechaza identificadores inexistentes', async () => {
  const api = fixture()
  const before = api.snapshot()
  for (const resource of ['people', 'vehicles']) {
    assert.equal((await api.request(`/${resource}/missing`, { method: 'DELETE' })).status, 404)
    assert.equal((await api.request(`/${resource}/${resource === 'people' ? 'person' : 'vehicle'}`, { method: 'DELETE', authenticated: false })).status, 401)
  }
  assert.deepEqual(api.snapshot(), before)
})

test('eliminar una persona borra todas sus versiones y adjuntos y desasigna sus vehículos conservándolos', async (t) => {
  const attachment = file(t)
  const historyAttachment = file(t)
  const vehicleAttachment = file(t)
  const documents = [
    { id: 'personal-old', personId: 'person', typeId: 'license', active: false, filePath: historyAttachment },
    { id: 'personal', personId: 'person', typeId: 'license', active: true, expirationDate: '2000-01-01', filePath: attachment },
    { id: 'vehicular', vehicleId: 'vehicle', typeId: 'license', active: true, expirationDate: '2000-01-01', filePath: vehicleAttachment },
  ]
  const api = fixture({ documents, notifications: [{ id: 'notification-personal', documentId: 'personal' }, { id: 'manual-personal', documentId: 'personal-old' }, { id: 'keep', documentId: 'vehicular' }] })
  const before = api.snapshot()
  assert.deepEqual(await api.request('/people/person', { method: 'DELETE' }), { status: 200, body: { ok: true } })
  assert.equal((await api.request('/people/person')).status, 404)
  assert.deepEqual((await api.request('/people')).body.items, [])
  assert.equal((await api.request('/documents/personal')).status, 404)
  assert.equal((await api.request('/files/personal')).status, 404)
  const vehicle = (await api.request('/vehicles/vehicle')).body
  assert.equal(vehicle.personId, null)
  assert.equal(vehicle.driver, '')
  assert.equal(vehicle.personName, '')
  assert.deepEqual(api.snapshot().documents, [documents[2]])
  assert.deepEqual(api.snapshot().notifications, [{ id: 'keep', documentId: 'vehicular' }])
  assert.deepEqual(api.snapshot().parts, before.parts)
  assert.equal((await api.request('/expirations')).body.items.length, 1)
  assert.equal((await api.request('/dashboard')).body.overduePersonCount, 0)
  assert.equal(existsSync(attachment), false)
  assert.equal(existsSync(historyAttachment), false)
  assert.equal(existsSync(vehicleAttachment), true)
  assert.ok(api.snapshot().audit.some((item) => item.action === 'deleted' && item.entity === 'person' && item.data.name === 'Ana García'))
  assert.equal((await api.request('/people/person', { method: 'DELETE' })).status, 404)
})

test('eliminar un vehículo elimina documentos, reparaciones y avisos sin reponer stock ni eliminar su persona', async (t) => {
  const attachment = file(t)
  const personalAttachment = file(t)
  const documents = [
    { id: 'vehicular', vehicleId: 'vehicle', typeId: 'license', active: true, expirationDate: '2000-01-01', filePath: attachment },
    { id: 'old', vehicleId: 'vehicle', typeId: 'license', active: false },
    { id: 'personal', personId: 'person', typeId: 'license', active: true, expirationDate: '2000-01-01', filePath: personalAttachment },
  ]
  const api = fixture({
    documents,
    repairs: [{ id: 'repair', vehicleId: 'vehicle', parts: [{ partId: 'part', quantity: 4 }] }],
    notifications: [{ id: 'notification-vehicular', documentId: 'vehicular' }, { id: 'keep', documentId: 'personal' }],
  })
  const before = api.snapshot()
  assert.deepEqual(await api.request('/vehicles/vehicle', { method: 'DELETE' }), { status: 200, body: { ok: true } })
  assert.equal((await api.request('/vehicles/vehicle')).status, 404)
  assert.equal((await api.request('/vehicles/vehicle/history')).status, 404)
  assert.deepEqual((await api.request('/vehicles')).body.items, [])
  assert.deepEqual((await api.request('/repairs')).body.items, [])
  assert.deepEqual(api.snapshot().documents, [documents[2]])
  assert.deepEqual(api.snapshot().people, before.people)
  assert.deepEqual(api.snapshot().parts, before.parts)
  assert.deepEqual(api.snapshot().notifications, [{ id: 'keep', documentId: 'personal' }])
  assert.equal((await api.request('/people/person')).body.vehicleCount, 0)
  assert.equal((await api.request('/dashboard')).body.activeVehicles, 0)
  assert.equal(existsSync(attachment), false)
  assert.equal(existsSync(personalAttachment), true)
  assert.ok(api.snapshot().audit.some((item) => item.action === 'deleted' && item.entity === 'vehicle' && item.data.plate === 'AB123CD' && item.data.repairCount === 1))
})

test('la limpieza conserva archivos compartidos y archivos fuera del directorio de uploads', async (t) => {
  const shared = file(t)
  const outside = file(t, true)
  const api = fixture({ documents: [
    { id: 'personal', personId: 'person', typeId: 'license', filePath: shared },
    { id: 'external', personId: 'person', typeId: 'license', filePath: outside },
    { id: 'vehicular', vehicleId: 'vehicle', typeId: 'license', filePath: shared },
  ] })
  assert.equal((await api.request('/people/person', { method: 'DELETE' })).status, 200)
  assert.equal(existsSync(shared), true)
  assert.equal(existsSync(outside), true)
})

test('una falla de persistencia conserva el titular, documentos y archivos para reintentar', async (t) => {
  for (const [resource, ownerKey, ownerId] of [['people', 'personId', 'person'], ['vehicles', 'vehicleId', 'vehicle']]) {
    const attachment = file(t)
    const api = fixture({ documents: [{ id: 'document', [ownerKey]: ownerId, typeId: 'license', filePath: attachment }] })
    const before = api.snapshot()
    api.failWrites()
    assert.equal((await api.request(`/${resource}/${ownerId}`, { method: 'DELETE' })).status, 500)
    assert.deepEqual(api.snapshot(), before)
    assert.equal(existsSync(attachment), true)
  }
})
