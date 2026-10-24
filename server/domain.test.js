import test from 'node:test'
import assert from 'node:assert/strict'
import { addAudit, dashboard, describeAudit, expirationStatus, daysUntil, getExpirations, isVehicleDocumentationIncomplete, parseDate, todayIso } from './domain.js'

test('calcula estados automáticos de vencimiento', () => {
  const now = new Date('2026-10-03T12:00:00')
  assert.equal(daysUntil('2026-10-02', now), -1)
  assert.equal(expirationStatus({ expirationDate: '2026-10-02' }, { alertDays: 30 }, now).label, 'Vencido')
  assert.equal(expirationStatus({ expirationDate: '2026-10-08' }, { alertDays: 30 }, now).label, 'Muy próximo')
  assert.equal(expirationStatus({ expirationDate: '2026-10-22' }, { alertDays: 30 }, now).label, 'Próximo')
})

test('prioriza vencimientos por urgencia y filtra scopes', () => {
  const store = { vehicles: [{ id: 'v1', plate: 'AA000AA', brand: 'Test', model: 'Truck', status: 'Activo' }], documentTypes: [{ id: 't1', name: 'RTO', alertDays: 30 }], documents: [{ id: 'd1', vehicleId: 'v1', typeId: 't1', expirationDate: '2026-10-02', active: true }, { id: 'd2', vehicleId: 'v1', typeId: 't1', expirationDate: '2026-11-01', active: true }] }
  const result = getExpirations(store, {}, new Date('2026-10-03T12:00:00'))
  assert.equal(result[0].status, 'Vencido')
  assert.equal(getExpirations(store, { scope: 'next-month' }, new Date('2026-10-03T12:00:00')).length, 1)
})

test('describe movimientos con los campos modificados', () => {
  const store = { vehicles: [{ id: 'v1', unit: '24', plate: 'AA000AA', brand: 'Test', model: 'Truck' }], documents: [], vehicleTypes: [], documentTypes: [] }
  assert.equal(describeAudit({ employeeName: 'Ana', action: 'updated', entity: 'vehicle', entityId: 'v1', data: { changedFields: ['plate', 'status'] } }, store), 'Ana actualizó vehículo #24 · AA000AA · Test Truck: patente, estado')
  assert.equal(describeAudit({ employeeName: 'Ana', action: 'updated', entity: 'profile', entityId: 'emp-1', data: { nameChanged: true, emailChanged: true, passwordChanged: false } }, store), 'Ana actualizó perfil de usuario: nombre, email')
})

test('describe cambios de acceso de empleados', () => {
  const store = { employees: [], vehicles: [], documents: [], vehicleTypes: [], documentTypes: [] }
  const enabled = { employeeName: 'Ana', action: 'access_enabled', entity: 'employee', entityId: 'emp-1', data: { email: 'persona@empresa.com' } }
  const disabled = { employeeName: 'Ana', action: 'access_disabled', entity: 'employee', entityId: 'emp-1', data: { email: 'persona@empresa.com' } }
  assert.equal(describeAudit(enabled, store), 'Ana habilitó el acceso a empleado persona@empresa.com')
  assert.equal(describeAudit(disabled, store), 'Ana deshabilitó el acceso a empleado persona@empresa.com')
})

const expirationStore = (date, settings = {}) => ({
  vehicles: [{ id: 'v1', plate: 'AA000AA', brand: 'Test', model: 'Truck', status: 'Activo' }],
  vehicleTypes: [], documentTypes: [{ id: 't1', name: 'RTO', requiresExpiration: true, alertDays: null }],
  documents: [{ id: 'd1', vehicleId: 'v1', typeId: 't1', expirationDate: date, active: true }], settings,
})

test('el resumen mensual coincide con el filtro aunque el documento esté en alerta o cambie el año', () => {
  for (const [current, expiration] of [['2026-10-22T12:00:00Z', '2026-11-01'], ['2026-12-22T12:00:00Z', '2027-01-31']]) {
    const store = expirationStore(expiration)
    const now = new Date(current)
    assert.equal(dashboard(store, now).nextMonth, 1)
    assert.equal(dashboard(store, now).nextMonth, getExpirations(store, { scope: 'next-month' }, now).length)
  }
})

test('las tres alertas globales y el override por tipo tienen umbrales coherentes', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  const settings = { firstAlertDays: 60, secondAlertDays: 20, urgentDays: 10 }
  const status = (date, type = { alertDays: null }) => expirationStatus({ expirationDate: date }, type, now, settings)
  assert.equal(status('2026-11-15').alertStage, 'first')
  assert.equal(status('2026-10-16').alertStage, 'second')
  assert.equal(status('2026-10-11').alertStage, 'urgent')
  assert.equal(status('2026-11-15', { alertDays: 30 }).alertStage, 'none')
  assert.equal(status('2026-10-05', { alertDays: 0 }).alertStage, 'none')
  const store = expirationStore('2026-11-15', settings)
  assert.equal(getExpirations(store, {}, now)[0].alertStage, 'first')
  store.settings.firstAlertDays = 30
  assert.equal(getExpirations(store, {}, now)[0].alertStage, 'none')
})

test('usa el día calendario de la zona configurada al cambiar de día y de mes', () => {
  const now = new Date('2026-11-01T01:00:00Z')
  assert.equal(todayIso(now, 'America/Argentina/Buenos_Aires'), '2026-10-31')
  assert.equal(todayIso(now, 'Asia/Tokyo'), '2026-11-01')
  assert.equal(todayIso(now, 'Zona legacy inválida'), '2026-10-31')
  assert.equal(daysUntil('2026-10-31', now, 'America/Argentina/Buenos_Aires'), 0)
  assert.equal(daysUntil('2026-10-31', now, 'Asia/Tokyo'), -1)
  const store = expirationStore('2026-11-01', { timezone: 'America/Argentina/Buenos_Aires' })
  assert.equal(dashboard(store, now).nextMonth, 1)
  store.settings.timezone = 'Asia/Tokyo'
  assert.equal(dashboard(store, now).thisMonth, 1)
  assert.equal(dashboard(store, now).today, '2026-11-01')
})

test('cuenta documentación incompleta solo cuando falta documentación o fecha requerida real', () => {
  const store = expirationStore(null)
  assert.equal(isVehicleDocumentationIncomplete(store.vehicles[0], store), true)
  assert.equal(dashboard(store).incompleteVehicles, 1)
  store.documents[0].expirationDate = '2026-02-30'
  assert.equal(parseDate('30/02/2026'), null)
  assert.equal(isVehicleDocumentationIncomplete(store.vehicles[0], store), true)
  store.documentTypes[0].requiresExpiration = false
  store.documents[0].expirationDate = null
  assert.equal(dashboard(store).incompleteVehicles, 0)
})

test('los indicadores distinguen cantidad de documentos de cantidad de vehículos afectados', () => {
  const store = expirationStore('2026-10-01')
  store.documents.push({ ...store.documents[0], id: 'd2' })
  const result = dashboard(store, new Date('2026-10-22T12:00:00Z'))
  assert.equal(result.overdueDocuments, 2)
  assert.equal(result.overdueVehicleCount, 1)
  assert.equal(result.generatedAt, '2026-10-22T12:00:00.000Z')
})

test('auditoría captura autor y genera ids únicos aun dentro del mismo milisegundo', () => {
  const store = { audit: [] }
  const actor = { id: 'a', name: 'Ana', email: 'ana@example.com' }
  for (let index = 0; index < 100; index++) addAudit(store, actor, 'created', 'vehicle', 'v1')
  actor.name = 'Nombre nuevo'
  assert.equal(new Set(store.audit.map((item) => item.id)).size, 100)
  assert.equal(store.audit[0].employeeName, 'Ana')
  assert.equal(store.audit[0].employeeEmail, 'ana@example.com')
})

test('rechaza fechas imposibles y conserva días de calendario de la zona configurada', () => {
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(parseDate('31/04/2026'), null)
  assert.equal(todayIso(new Date('2026-10-19T00:00:00-03:00')), '2026-10-19')
  assert.equal(daysUntil('2026-11-02', new Date('2026-10-31T23:30:00-03:00')), 2)
})

test('dashboard cuenta todo el próximo mes aunque sea urgente o cambie el año', () => {
  const store = { vehicles: [{ id: 'v1', status: 'Activo' }], vehicleTypes: [], documentTypes: [{ id: 't1', alertDays: 30 }], documents: [{ id: 'd1', vehicleId: 'v1', typeId: 't1', expirationDate: '2027-01-02' }, { id: 'd2', vehicleId: 'v1', typeId: 't1', expirationDate: '2027-01-25' }] }
  assert.equal(dashboard(store, new Date('2026-12-30T12:00:00')).nextMonth, 2)
})

test('los requisitos por tipo y las fechas requeridas se combinan al detectar documentación incompleta', () => {
  const store = expirationStore('2026-12-01')
  store.vehicles[0].typeId = 'vt1'
  store.vehicleTypes.push({ id: 'vt1', requiredDocumentTypeIds: ['card'] })
  store.documentTypes.push({ id: 'card', requiresExpiration: false })
  assert.equal(isVehicleDocumentationIncomplete(store.vehicles[0], store), true)
  store.documents.push({ id: 'd2', vehicleId: 'v1', typeId: 'card', expirationDate: null })
  assert.equal(isVehicleDocumentationIncomplete(store.vehicles[0], store), false)
  store.documents[0].expirationDate = '2026-02-30'
  assert.equal(isVehicleDocumentationIncomplete(store.vehicles[0], store), true)
})

test('los tipos sin vencimiento ignoran fechas antiguas al armar alertas', () => {
  const store = expirationStore('2000-01-01')
  store.documentTypes[0].requiresExpiration = false
  assert.equal(expirationStatus(store.documents[0], store.documentTypes[0]).label, 'Sin vencimiento')
  assert.equal(getExpirations(store).length, 0)
})
