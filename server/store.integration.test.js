import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'

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
