import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from './server.js'
import { seedDatabase } from './test-fixtures.js'

const seed = seedDatabase()

async function fixture(t, changeStore = () => {}) {
  let store = structuredClone(seed)
  changeStore(store)
  const server = createApiServer({ readStore: async () => structuredClone(store), writeStore: async (next) => { store = structuredClone(next) } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  async function request(path, { token, body, method = 'GET' } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const login = async (identifier = 'admin', password = 'admin1234') => (await request('/auth/login', { method: 'POST', body: { identifier, password } })).body.token
  return { request, login, snapshot: () => structuredClone(store) }
}

const repair = (changes = {}) => ({ vehicleId: 'vh-1', date: '2026-10-19', description: 'Cambio de aceite y filtro', mileage: 185000, parts: [{ partId: 'prt-1', quantity: 4 }, { partId: 'prt-3', quantity: 1 }], ...changes })

test('la reparación descuenta todos los repuestos, registra al responsable y aparece en la ficha', async (t) => {
  const f = await fixture(t)
  const token = await f.login()
  const result = await f.request('/repairs', { method: 'POST', token, body: repair({ notes: 'Service preventivo' }) })
  assert.equal(result.status, 201)
  assert.equal(result.body.employeeName, 'Juan Pérez')
  assert.equal(f.snapshot().parts.find((part) => part.id === 'prt-1').stock, 20)
  assert.equal(f.snapshot().parts.find((part) => part.id === 'prt-3').stock, 17)
  assert.equal(f.snapshot().vehicles[0].mileage, 185000)
  assert.equal(new Set(f.snapshot().audit.map((item) => item.id)).size, 3)
  const history = await f.request('/vehicles/vh-1/history', { token })
  const event = history.body.items.find((item) => item.id === result.body.id)
  assert.equal(event.description, repair().description)
  assert.equal(event.notes, 'Service preventivo')
  assert.equal(event.parts[0].quantity, 4)
  const audit = await f.request('/audit', { token })
  assert.match(audit.body.items[0].description, /reparación de AB123CD/)
})

test('errores de validación o stock rechazan toda la reparación sin cambios parciales', async (t) => {
  const f = await fixture(t)
  const token = await f.login()
  for (const body of [
    repair({ vehicleId: 'inexistente' }), repair({ description: '  ' }), repair({ date: '2026-02-30' }),
    repair({ date: '' }), repair({ mileage: -1 }), repair({ mileage: 1.5 }), repair({ parts: [] }),
    repair({ parts: [{ partId: 'prt-1', quantity: 1 }, { partId: 'prt-3', quantity: 1000 }] }),
    repair({ parts: [{ partId: 'borrado', quantity: 1 }] }), repair({ parts: [{ partId: 'prt-1', quantity: 0 }] }),
    repair({ parts: [{ partId: 'prt-1', quantity: 0.5 }] }), repair({ parts: [null] }),
  ]) {
    const before = f.snapshot()
    const response = await f.request('/repairs', { token, method: 'POST', body })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.deepEqual(f.snapshot(), before)
  }
})

test('repuestos repetidos se agrupan y no permiten consumir más existencias de las disponibles', async (t) => {
  const f = await fixture(t)
  const token = await f.login()
  const excess = await f.request('/repairs', { token, method: 'POST', body: repair({ parts: [{ partId: 'prt-1', quantity: 13 }, { partId: 'prt-1', quantity: 13 }] }) })
  assert.equal(excess.status, 400)
  assert.equal(f.snapshot().parts[0].stock, 24)
  const valid = await f.request('/repairs', { token, method: 'POST', body: repair({ parts: [{ partId: 'prt-1', quantity: 12 }, { partId: 'prt-1', quantity: 12 }] }) })
  assert.equal(valid.status, 201)
  assert.equal(valid.body.parts.length, 1)
  assert.equal(valid.body.parts[0].quantity, 24)
  assert.equal(f.snapshot().parts[0].stock, 0)
})

test('dos reparaciones simultáneas no pueden gastar el mismo stock', async (t) => {
  const f = await fixture(t)
  const token = await f.login()
  const results = await Promise.all([1, 2].map(() => f.request('/repairs', { token, method: 'POST', body: repair({ parts: [{ partId: 'prt-1', quantity: 20 }] }) })))
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 400])
  assert.equal(f.snapshot().repairs.length, 1)
  assert.equal(f.snapshot().parts[0].stock, 4)
})

test('la consulta requiere sesión y el registro conserva los permisos del inventario', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('/repairs')).status, 401)
  assert.equal((await f.request('/vehicles/vh-1/history')).status, 401)
  const token = await f.login('ana', 'manager1234')
  assert.equal((await f.request('/repairs', { token })).status, 200)
  assert.equal((await f.request('/vehicles/vh-1/history', { token })).status, 200)
  assert.equal((await f.request('/repairs', { token, method: 'POST', body: repair() })).status, 403)
  assert.equal(f.snapshot().repairs.length, 0)
})

test('el historial conserva repuestos eliminados, documentos renovados y eventos anteriores a los últimos cien', async (t) => {
  const f = await fixture(t, (store) => {
    store.audit = Array.from({ length: 110 }, (_, index) => ({ id: `old-${index}`, action: 'updated', entity: 'vehicle', entityId: 'vh-1', employeeName: 'Juan', data: { changedFields: ['brand'] }, createdAt: '2026-01-20T12:00:00Z' }))
  })
  const token = await f.login()
  const created = await f.request('/repairs', { token, method: 'POST', body: repair() })
  await f.request('/parts/prt-1', { token, method: 'DELETE' })
  await f.request('/documents/doc-1/renew', { token, method: 'POST', body: { expirationDate: '2027-10-19' } })
  // La ficha se recorre por páginas con el cursor; juntas contienen todo el historial sin repetir eventos.
  const history = []
  let cursor = null
  let pages = 0
  do {
    const page = (await f.request(`/vehicles/vh-1/history${cursor ? `?cursor=${cursor}` : ''}`, { token })).body
    assert.ok(page.items.length <= 20)
    history.push(...page.items)
    cursor = page.nextCursor
    pages++
  } while (cursor)
  assert.ok(pages > 5)
  assert.equal(new Set(history.map((item) => item.id)).size, history.length)
  assert.equal(history.filter((item) => item.id.startsWith('old-')).length, 110)
  assert.equal(history.find((item) => item.id === created.body.id).parts[0].name, 'Aceite Sintético 5W-30')
  const eventTimes = history.map((item) => {
    const value = item.date || item.createdAt
    return value ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).getTime() : 0
  })
  assert.deepEqual(eventTimes, [...eventTimes].sort((a, b) => b - a))
  assert.ok(history.some((item) => item.action === 'renewed'))
  assert.ok(history.some((item) => item.id === 'registered-doc-1'))
  assert.equal((await f.request('/vehicles/vh-2/history', { token })).body.items.some((item) => item.kind === 'repair'), false)
  assert.equal((await f.request('/vehicles/desconocido/history', { token })).status, 404)
})

test('el kilometraje de reparaciones anteriores no retrocede el odómetro y los vehículos de baja conservan su historial', async (t) => {
  const f = await fixture(t)
  const token = await f.login()
  assert.equal((await f.request('/repairs', { token, method: 'POST', body: repair({ mileage: 100 }) })).status, 201)
  assert.equal(f.snapshot().vehicles[0].mileage, 184320)
  await f.request('/vehicles/vh-1', { token, method: 'PUT', body: { status: 'Baja' } })
  assert.equal((await f.request('/repairs', { token, method: 'POST', body: repair() })).status, 400)
  assert.ok((await f.request('/vehicles/vh-1/history', { token })).body.items.some((item) => item.kind === 'repair'))
})

test('la clasificación admite filtrar, renombrar y validar tipos sin perder las asignaciones', async (t) => {
  const f = await fixture(t)
  const token = await f.login()
  const response = await f.request('/vehicles?typeId=vt-truck', { token })
  assert.equal(response.body.items.length, 3)
  assert.ok(response.body.items.every((vehicle) => vehicle.typeId === 'vt-truck'))
  assert.equal((await f.request('/vehicle-types', { token, method: 'POST', body: { name: ' camión ' } })).status, 409)
  assert.equal((await f.request('/vehicle-types/vt-truck', { token, method: 'PUT', body: { name: 'Camión pesado' } })).status, 200)
  assert.equal((await f.request('/vehicles/vh-1', { token })).body.type, 'Camión pesado')
  assert.equal((await f.request('/vehicle-types/vt-truck', { token, method: 'DELETE' })).status, 409)
  assert.equal((await f.request('/vehicles/vh-1', { token, method: 'PUT', body: { typeId: 'tipo-inexistente' } })).status, 400)
})

test('la ficha paginada por cursor no repite ni saltea eventos con horas empatadas', async (t) => {
  const sameSecond = '2026-10-20T15:30:00.000Z'
  const f = await fixture(t, (store) => {
    // Muchos eventos en el mismo segundo (MySQL guarda segundos), intercalados con reparaciones y altas.
    store.audit = [
      ...Array.from({ length: 120 }, (_, index) => ({ id: `tie-${String(index).padStart(3, '0')}`, action: 'updated', entity: 'vehicle', entityId: 'vh-1', employeeName: 'Juan', data: { changedFields: ['mileage'] }, createdAt: sameSecond })),
      ...Array.from({ length: 30 }, (_, index) => ({ id: `doc-event-${index}`, action: 'attached_file', entity: 'document', entityId: 'doc-2', employeeName: 'Ana', data: { fileName: `f${index}.pdf` }, createdAt: new Date(Date.UTC(2026, 9, 1 + index, 9)).toISOString() })),
      { id: 'other-vehicle', action: 'updated', entity: 'vehicle', entityId: 'vh-2', employeeName: 'Juan', data: {}, createdAt: sameSecond },
    ]
    store.repairs = [
      { id: 'rep-a', vehicleId: 'vh-1', description: 'Frenos', date: '2026-10-20', createdAt: '2026-10-20T15:30:00.000Z', employeeName: 'Juan', parts: [] },
      { id: 'rep-b', vehicleId: 'vh-1', description: 'Aceite', date: '2026-10-05', createdAt: '2026-10-05T10:00:00.000Z', employeeName: 'Juan', parts: [] },
    ]
  })
  const token = await f.login()
  const pages = []
  let cursor = null
  do {
    const response = await f.request(`/vehicles/vh-1/history?limit=7${cursor ? `&cursor=${cursor}` : ''}`, { token })
    assert.equal(response.status, 200)
    pages.push(response.body)
    cursor = response.body.nextCursor
  } while (cursor)
  const items = pages.flatMap((page) => page.items)
  const ids = items.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, 'ningún evento se repite')
  // 120 + 30 eventos del vehículo, 2 reparaciones y las altas de la unidad y de sus documentos sin evento registrado.
  assert.equal(items.length, pages[0].total)
  assert.ok(ids.includes('tie-000') && ids.includes('tie-119') && ids.includes('rep-a') && ids.includes('rep-b') && ids.includes('registered-vh-1'))
  assert.ok(!ids.includes('other-vehicle'))
  assert.ok(pages.slice(0, -1).every((page) => page.items.length === 7 && page.hasMore))
  assert.equal(pages.at(-1).hasMore, false)
  const times = items.map((item) => new Date(item.date && item.date.length === 10 ? `${item.date}T12:00:00Z` : item.date || item.createdAt).getTime())
  assert.deepEqual(times, [...times].sort((a, b) => b - a))

  assert.equal((await f.request('/vehicles/vh-1/history?cursor=no-es-un-cursor', { token })).status, 400)
  assert.equal((await f.request('/vehicles/vh-1/history?limit=5000', { token })).body.items.length, 100)
  assert.equal((await f.request('/vehicles/vh-1/history', { token })).body.items.length, 20)
})
