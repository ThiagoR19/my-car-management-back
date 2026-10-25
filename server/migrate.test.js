import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateDatabase, migrationErrorMessage, runMigrationCommand } from './migrate.js'

const databaseUrl = 'mysql://test:password@localhost/base'

function database({ applied = [{ hash: 'legacy-hash', created_at: 1792800337921 }], existing = [], lock = 1, missingHistory = false } = {}) {
  const calls = []
  const client = {
    async execute(sql) {
      calls.push(sql)
      if (sql.includes('__drizzle_migrations')) {
        if (missingHistory) throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' })
        return [applied]
      }
      if (sql.includes('information_schema')) return [existing]
      if (sql.includes('GET_LOCK')) return [[{ acquired: lock }]]
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]]
      throw new Error('Consulta inesperada')
    },
    async end() { calls.push('CLOSE') },
  }
  return { calls, client, createConnection: async () => client }
}

test('--check consulta la migración incremental pendiente sin modificar la base', async () => {
  const adapter = database()
  let applied = false
  const result = await migrateDatabase({ databaseUrl, checkOnly: true, createConnection: adapter.createConnection, applyMigrations: () => { applied = true }, log: () => {} })
  assert.deepEqual(result, { pending: 1, applied: 0 })
  assert.equal(applied, false)
  assert.ok(adapter.calls.filter(call => call !== 'CLOSE').every(call => call.startsWith('SELECT ')))
  assert.equal(adapter.calls.some(call => call.includes('GET_LOCK')), false)
  assert.equal(adapter.calls.at(-1), 'CLOSE')
})

test('acepta el registro inicial antiguo y mantiene el bloqueo en la conexión de migración', async () => {
  const adapter = database()
  let applied = false
  const result = await migrateDatabase({ databaseUrl, createConnection: adapter.createConnection, applyMigrations: async client => {
    assert.equal(client, adapter.client)
    assert.match(adapter.calls.at(-1), /GET_LOCK/)
    applied = true
  }, log: () => {} })
  assert.deepEqual(result, { pending: 1, applied: 1 })
  assert.equal(applied, true)
  assert.match(adapter.calls.at(-2), /RELEASE_LOCK/)
  assert.equal(adapter.calls.at(-1), 'CLOSE')
})

test('un esquema existente sin historial se detiene antes de ejecutar DDL', async () => {
  const adapter = database({ missingHistory: true, existing: [{ table_name: 'vehicles' }] })
  await assert.rejects(migrateDatabase({ databaseUrl, createConnection: adapter.createConnection, applyMigrations: () => assert.fail('No debe migrar'), log: () => {} }), { code: 'MIGRATION_HISTORY' })
  assert.ok(adapter.calls.filter(call => call !== 'CLOSE').every(call => call.startsWith('SELECT ')))
})

test('una base vacía puede ejecutar las dos migraciones y una actualizada no repite DDL', async () => {
  const fresh = database({ applied: [] })
  const freshResult = await migrateDatabase({ databaseUrl, checkOnly: true, createConnection: fresh.createConnection, log: () => {} })
  assert.equal(freshResult.pending, 2)
  const current = database({ applied: [{ hash: 'current', created_at: 1792886737921 }] })
  const result = await migrateDatabase({ databaseUrl, createConnection: current.createConnection, applyMigrations: () => assert.fail('No debe migrar'), log: () => {} })
  assert.deepEqual(result, { pending: 0, applied: 0 })
  assert.equal(current.calls.some(call => call.includes('GET_LOCK')), false)
})

test('un fallo al migrar libera la conexión y muestra orientación sin credenciales ni stack', async () => {
  const adapter = database()
  const messages = []
  const failure = Object.assign(new Error('mysql://admin:secret-password@private-host/base'), { code: 'ER_ACCESS_DENIED_ERROR' })
  const result = await runMigrationCommand({ args: [], databaseUrl, createConnection: adapter.createConnection, applyMigrations: async () => { throw new Error('Failed SQL with secret', { cause: failure }) }, log: () => {}, errorLog: message => messages.push(message) })
  assert.equal(result, 1)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /usuario y la contraseña/)
  assert.doesNotMatch(messages[0], /secret|private-host|mysql:\/\/|Error:|at /)
  assert.match(adapter.calls.at(-2), /RELEASE_LOCK/)
  assert.equal(adapter.calls.at(-1), 'CLOSE')
})

test('los errores de DNS y configuración son legibles y no imprimen los errores originales', async () => {
  assert.match(migrationErrorMessage(Object.assign(new Error('host y credenciales'), { code: 'ENOTFOUND' })), /host de DATABASE_URL/)
  const messages = []
  const result = await runMigrationCommand({ args: ['--check'], databaseUrl: '', createConnection: () => assert.fail('No debe conectar'), errorLog: message => messages.push(message) })
  assert.equal(result, 1)
  assert.match(messages[0], /Configurá DATABASE_URL/)
})

test('un argumento mal escrito no activa una migración por accidente', async () => {
  const messages = []
  const result = await runMigrationCommand({ args: ['--checks'], createConnection: () => assert.fail('No debe conectar'), errorLog: message => messages.push(message) })
  assert.equal(result, 1)
  assert.match(messages[0], /Opción desconocida/)
})
