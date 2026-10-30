import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { listAudits, listVehicleAudits } from './store.js'

// Opt-in: this verifies that the configured MySQL server accepts the same
// connection style used by the application. It never creates or drops user
// tables, so it is safe to point at a development database.
test('MySQL: la conexión y el bloqueo distribuido están disponibles', { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async t => {
  const client = mysql.createPool({ uri: process.env.TEST_DATABASE_URL, waitForConnections: true, connectionLimit: 1 })
  t.after(() => client.end())
  const [version] = await client.query('SELECT VERSION() AS version')
  assert.ok(version[0].version)
  const [lock] = await client.query('SELECT GET_LOCK(?, 1) AS acquired', ['mycarmanagement:integration-test'])
  assert.equal(Number(lock[0].acquired), 1)
  await client.query('SELECT RELEASE_LOCK(?)', ['mycarmanagement:integration-test'])
})

// Opt-in y de solo lectura: ejecuta las consultas paginadas del historial en el MySQL/MariaDB real
// (requiere la base migrada) y comprueba que el orden por fecha usa el índice de la migración 0002.
test('MySQL: el historial paginado y el de cada vehículo funcionan en el servidor real', { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async t => {
  const connection = await mysql.createConnection({ uri: process.env.TEST_DATABASE_URL })
  t.after(() => connection.end())
  const page = await listAudits({ page: 1, pageSize: 5 }, connection)
  assert.ok(Number.isInteger(page.total) && page.items.length <= 5)
  assert.equal(page.totalPages, Math.max(1, Math.ceil(page.total / 5)))
  const search = await listAudits({ page: 1, pageSize: 5, search: '50%_x', entities: ['vehicle'], actions: ['renewed'] }, connection)
  assert.ok(Number.isInteger(search.total))
  const vehiclePage = await listVehicleAudits('integration-check', ['integration-doc'], { before: { time: Date.now(), mode: 'id', id: 'zzz' }, limit: 21 }, connection)
  assert.ok(Array.isArray(vehiclePage.items) && Number.isInteger(vehiclePage.total) && Array.isArray(vehiclePage.covered))
  const [indexes] = await connection.query("SHOW INDEX FROM audits WHERE Key_name IN ('audits_created_at_id_idx', 'audits_entity_entity_id_idx')")
  assert.deepEqual([...new Set(indexes.map(index => index.Key_name))].sort(), ['audits_created_at_id_idx', 'audits_entity_entity_id_idx'])
})
