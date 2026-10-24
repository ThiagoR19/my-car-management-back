import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from './server.js'
import { passwordRecord } from './store.js'
import { describeAudit } from './domain.js'

const adminPassword = 'admin-parts-1234'
const adminCredentials = passwordRecord(adminPassword)

async function fixture(t, { parts = [], audit = [] } = {}) {
  let store = {
    employees: [
      { id: 'emp-admin', name: 'Juan Administrador', username: 'admin', email: 'admin@parts.local', role: 'Administrador', active: true, ...adminCredentials },
      { id: 'emp-worker', name: 'Carlos Empleado', username: 'carlos', email: 'carlos@parts.local', role: 'Empleado', active: true, ...passwordRecord('worker1234') },
    ],
    accessRequests: [],
    vehicleTypes: [],
    documentTypes: [],
    vehicles: [],
    documents: [],
    audit: [...audit],
    notifications: [],
    parts: [...parts],
    settings: { companyName: 'Test Fleet', firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7 },
  }

  const server = createApiServer({
    readStore: async () => structuredClone(store),
    writeStore: async (nextStore) => {
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
      headers: {
        ...(body && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body && { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }

  async function adminToken() {
    const response = await request('/auth/login', {
      method: 'POST',
      body: { identifier: 'admin', password: adminPassword },
    })
    assert.equal(response.status, 200)
    return response.body.token
  }

  return {
    request,
    adminToken,
    snapshot: () => structuredClone(store),
  }
}

test('Stock rechaza fracciones, infinitos, mínimos negativos y desbordes sin guardar cambios', async (t) => {
  const f = await fixture(t, { parts: [{ id: 'p1', name: 'Filtro', stock: 2147483647, minStock: 0, unit: 'unidad', category: 'Filtros' }] })
  const token = await f.adminToken()
  for (const stock of [0.5, 'Infinity', 2147483648, -1]) {
    assert.equal((await f.request('/parts', { method: 'POST', body: { name: 'Otro', stock }, token })).status, 400)
    assert.equal((await f.request('/parts/p1', { method: 'PUT', body: { stock }, token })).status, 400)
  }
  assert.equal((await f.request('/parts', { method: 'POST', body: { name: 'Filtro', stock: 1 }, token })).status, 400)
  assert.equal((await f.request('/parts', { method: 'POST', body: { name: 'Otro', stock: 1, minStock: -1 }, token })).status, 400)
  assert.equal(f.snapshot().parts.length, 1)
  assert.equal(f.snapshot().parts[0].stock, 2147483647)
})

test('Categoría anterior se normaliza sin perder el mínimo cero', async (t) => {
  const f = await fixture(t)
  const token = await f.adminToken()
  const result = await f.request('/parts', { method: 'POST', body: { name: 'Batería', stock: 1, minStock: 0, category: 'Encendido' }, token })
  assert.equal(result.status, 201)
  assert.equal(result.body.item.category, 'Sistema eléctrico')
  assert.equal(result.body.item.minStock, 0)
})

test('Stock de refacciones: Crear refacción nueva registra auditoría con actor', async (t) => {
  const f = await fixture(t)
  const token = await f.adminToken()

  const res = await f.request('/parts', {
    method: 'POST',
    body: { name: 'Aceite Sintético 5W-30', stock: 15, unit: 'unidad', category: 'Lubricantes' },
    token,
  })

  assert.equal(res.status, 201)
  assert.equal(res.body.action, 'created')
  assert.equal(res.body.item.name, 'Aceite Sintético 5W-30')
  assert.equal(res.body.item.stock, 15)
  assert.equal(res.body.item.unit, 'unidad')

  const snap = f.snapshot()
  assert.equal(snap.parts.length, 1)

  // Auditoría obligatoria
  assert.equal(snap.audit.length, 1)
  const audit = snap.audit[0]
  assert.equal(audit.action, 'created')
  assert.equal(audit.entity, 'part')
  assert.equal(audit.employeeId, 'emp-admin')
  assert.equal(audit.employeeName, 'Juan Administrador')
  assert.equal(audit.data.name, 'Aceite Sintético 5W-30')
  assert.equal(audit.data.stock, 15)

  const desc = describeAudit(audit, snap)
  assert.match(desc, /Juan Administrador creó la refacción “Aceite Sintético 5W-30”/)
})

test('Stock de refacciones: Añadir stock a un repuesto existente suma stock y audita', async (t) => {
  const initialPart = {
    id: 'prt-bujia',
    name: 'Bujías de encendido',
    stock: 10,
    unit: 'packs',
    minStock: 5,
    category: 'Encendido',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const f = await fixture(t, { parts: [initialPart] })
  const token = await f.adminToken()

  // Añadir 8 packs a "Bujías de encendido"
  const res = await f.request('/parts', {
    method: 'POST',
    body: { name: 'Bujías de encendido', stock: 8, unit: 'packs' },
    token,
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.action, 'stock_added')
  assert.equal(res.body.item.stock, 18)
  assert.equal(res.body.previousStock, 10)
  assert.equal(res.body.currentStock, 18)
  assert.equal(res.body.addedQuantity, 8)

  const snap = f.snapshot()
  const part = snap.parts.find((p) => p.id === 'prt-bujia')
  assert.equal(part.stock, 18)

  // Auditoría obligatoria
  assert.equal(snap.audit.length, 1)
  const audit = snap.audit[0]
  assert.equal(audit.action, 'stock_added')
  assert.equal(audit.entity, 'part')
  assert.equal(audit.employeeId, 'emp-admin')
  assert.equal(audit.employeeName, 'Juan Administrador')
  assert.equal(audit.data.previousStock, 10)
  assert.equal(audit.data.currentStock, 18)
  assert.equal(audit.data.addedQuantity, 8)

  const desc = describeAudit(audit, snap)
  assert.match(desc, /Juan Administrador añadió stock a la refacción “Bujías de encendido”: \+8 packs \(10 → 18\)/)
})

test('Stock de refacciones: Modificar stock sobrescribe el valor y audita con actor y motivo', async (t) => {
  const initialPart = {
    id: 'prt-filtro',
    name: 'Filtro de aceite',
    stock: 20,
    unit: 'unidad',
    minStock: 5,
    category: 'Filtros',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const f = await fixture(t, { parts: [initialPart] })
  const token = await f.adminToken()

  // Modificar stock a 7 unidades directamente (ej. conteo de inventario)
  const res = await f.request('/parts/prt-filtro', {
    method: 'PUT',
    body: { stock: 7, reason: 'Ajuste físico de stock' },
    token,
  })

  assert.equal(res.status, 200)
  assert.equal(res.body.action, 'stock_modified')
  assert.equal(res.body.previousStock, 20)
  assert.equal(res.body.currentStock, 7)
  assert.equal(res.body.item.stock, 7)

  const snap = f.snapshot()
  const part = snap.parts.find((p) => p.id === 'prt-filtro')
  assert.equal(part.stock, 7)

  // Auditoría obligatoria
  assert.equal(snap.audit.length, 1)
  const audit = snap.audit[0]
  assert.equal(audit.action, 'stock_modified')
  assert.equal(audit.entity, 'part')
  assert.equal(audit.employeeId, 'emp-admin')
  assert.equal(audit.employeeName, 'Juan Administrador')
  assert.equal(audit.data.previousStock, 20)
  assert.equal(audit.data.currentStock, 7)
  assert.equal(audit.data.reason, 'Ajuste físico de stock')

  const desc = describeAudit(audit, snap)
  assert.match(desc, /Juan Administrador modificó el stock de la refacción “Filtro de aceite”: 20 → 7 unidad/)
})

test('Stock de refacciones: Listar y eliminar refacciones', async (t) => {
  const initialPart = {
    id: 'prt-pastillas',
    name: 'Pastillas de freno',
    stock: 6,
    unit: 'packs',
    minStock: 4,
    category: 'Frenos',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const f = await fixture(t, { parts: [initialPart] })
  const token = await f.adminToken()

  const listRes = await f.request('/parts', { token })
  assert.equal(listRes.status, 200)
  assert.equal(listRes.body.items.length, 1)

  const delRes = await f.request('/parts/prt-pastillas', { method: 'DELETE', token })
  assert.equal(delRes.status, 200)

  const snap = f.snapshot()
  assert.equal(snap.parts.length, 0)
  assert.equal(snap.audit[0].action, 'deleted')
  assert.equal(snap.audit[0].entity, 'part')
})
