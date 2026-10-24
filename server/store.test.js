import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { addAudit } from './domain.js'
import { readStore, writeStore } from './store.js'

// Run the repository's actual SQL against an isolated relational database. This
// adapter only binds tagged-template parameters and maps driver value types; it
// does not simulate persistence behavior. The MySQL migration remains the
// source of the relational table layout.
function isolatedDatabase(snapshotName = '0000_snapshot.json') {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  const snapshot = JSON.parse(readFileSync(new URL(`../drizzle/migrations/meta/${snapshotName}`, import.meta.url), 'utf8'))
  const quote = (name) => `"${name.replaceAll('"', '""')}"`
  for (const table of Object.values(snapshot.tables)) {
    const definitions = Object.values(table.columns).map((column) => {
      const type = ['integer', 'boolean'].includes(column.type) ? 'INTEGER' : 'TEXT'
      const fallback = /^\(?now\(\)\)?$/.test(String(column.default)) ? '(CURRENT_TIMESTAMP)' : typeof column.default === 'boolean' ? Number(column.default) : typeof column.default === 'string' ? column.default : column.default
      return `${quote(column.name)} ${type}${column.primaryKey ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${fallback !== undefined ? ` DEFAULT ${fallback}` : ''}`
    })
    for (const primary of Object.values(table.compositePrimaryKeys || {})) definitions.push(`PRIMARY KEY (${primary.columns.map(quote).join(', ')})`)
    for (const unique of Object.values(table.uniqueConstraints)) definitions.push(`UNIQUE (${unique.columns.map(quote).join(', ')})`)
    for (const reference of Object.values(table.foreignKeys)) definitions.push(`FOREIGN KEY (${reference.columnsFrom.map(quote).join(', ')}) REFERENCES ${quote(reference.tableTo)} (${reference.columnsTo.map(quote).join(', ')}) ON DELETE ${reference.onDelete}`)
    database.exec(`CREATE TABLE ${quote(table.name)} (${definitions.join(', ')})`)
  }
  const encode = (value) => value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? Number(value) : value && typeof value === 'object' ? JSON.stringify(value) : value
  const decode = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value === null ? null : ['active', 'read', 'requiresExpiration'].includes(key) ? Boolean(value) : ['data', 'requiredDocumentTypeIds', 'emailAlerts', 'parts'].includes(key) ? JSON.parse(value) : /At$/.test(key) || ['issueDate', 'expirationDate'].includes(key) ? new Date(value) : value,
  ]))
  const client = (strings, ...values) => {
    if (typeof strings === 'string') return { identifier: strings }
    if (!Array.isArray(strings)) return { fields: strings }
    const bindings = []
    let statement = strings[0]
    for (let index = 0; index < values.length; index++) {
      const value = values[index]
      if (value?.identifier) statement += quote(value.identifier)
      else if (value?.fields) {
        const entries = Object.entries(value.fields)
        if (/\bset\s*$/i.test(statement)) statement += entries.map(([key, item]) => { bindings.push(encode(item)); return `${quote(key)} = ?` }).join(', ')
        else {
          statement += `(${entries.map(([key]) => quote(key)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`
          bindings.push(...entries.map(([, item]) => encode(item)))
        }
      } else { statement += '?'; bindings.push(encode(value)) }
      statement += strings[index + 1]
    }
    const prepared = database.prepare(statement)
    return Promise.resolve(prepared.columns().length ? prepared.all(...bindings).map(decode) : (prepared.run(...bindings), []))
  }
  client.json = value => value
  client.begin = async (callback) => {
    database.exec('BEGIN')
    try { const result = await callback(client); database.exec('COMMIT'); return result }
    catch (error) { database.exec('ROLLBACK'); throw error }
  }
  return { database, client }
}

function fixture() {
  const employee = (id) => ({ id, name: id, username: id, email: `${id}@example.com`, role: 'Administrador', active: true, passwordHash: 'hash', passwordSalt: 'salt' })
  return {
    employees: [employee('admin'), employee('ana')], accessRequests: [],
    vehicleTypes: [{ id: 'vt', name: 'Camión', active: true }],
    documentTypes: [{ id: 'dt', name: 'RTO', requiresExpiration: true, alertDays: null, active: true }],
    vehicles: [{ id: 'v', unit: '1', plate: 'AA000AA', typeId: 'vt', brand: 'Test', model: 'Truck', status: 'Activo' }],
    documents: [{ id: 'd', vehicleId: 'v', typeId: 'dt', expirationDate: '2026-11-01', notes: 'Texto original', active: true }],
    notifications: [], audit: [], settings: { firstAlertDays: 45, secondAlertDays: 15, urgentDays: 7 },
  }
}

test('conserva más de 100 auditorías, incluso cuando un guardado no incluye todo el historial', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  const initial = fixture()
  for (let index = 0; index < 150; index++) addAudit(initial, initial.employees[1], 'created', 'vehicle', 'v')
  await writeStore(initial, client)
  const loaded = await readStore(client)
  assert.equal(loaded.audit.length, 150)
  loaded.audit = loaded.audit.slice(0, 1)
  addAudit(loaded, loaded.employees[0], 'updated', 'vehicle', 'v')
  await writeStore(loaded, client)
  assert.equal((await readStore(client)).audit.length, 151)
})

test('el autor histórico permanece al renombrar o eliminar al empleado', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  const initial = fixture()
  addAudit(initial, initial.employees[1], 'created', 'vehicle', 'v')
  await writeStore(initial, client)
  let loaded = await readStore(client)
  loaded.employees[1].name = 'Otro nombre'
  loaded.audit[0].employeeName = 'Intento de modificar el historial'
  await writeStore(loaded, client)
  loaded = await readStore(client)
  assert.equal(loaded.audit[0].employeeName, 'ana')
  loaded.employees = loaded.employees.filter((employee) => employee.id !== 'ana')
  await writeStore(loaded, client)
  const historical = (await readStore(client)).audit[0]
  assert.equal(historical.employeeName, 'ana')
  assert.equal(historical.employeeEmail, 'ana@example.com')
  assert.equal(historical.employeeId, null)
})

test('vaciar observaciones se conserva al recargar y null hereda alerta global', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  await writeStore(fixture(), client)
  const loaded = await readStore(client)
  assert.equal(loaded.documents[0].notes, 'Texto original')
  loaded.documents[0].notes = ''
  await writeStore(loaded, client)
  const reloaded = await readStore(client)
  assert.equal(reloaded.documents[0].notes, '')
  assert.equal(reloaded.documentTypes[0].alertDays, null)
})

test('una escritura que viola integridad revierte todos los cambios', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  await writeStore(fixture(), client)
  const loaded = await readStore(client)
  loaded.employees[0].name = 'No debe persistir'
  loaded.vehicles[0].typeId = 'tipo-inexistente'
  await assert.rejects(writeStore(loaded, client), /FOREIGN KEY/)
  assert.equal((await readStore(client)).employees[0].name, 'admin')
})

test('la migración MySQL incluye las tablas y restricciones de la aplicación', (t) => {
  const { database } = isolatedDatabase()
  t.after(() => database.close())
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)
  assert.ok(tables.includes('employees'))
  assert.ok(tables.includes('vehicle_documents'))
  assert.ok(tables.includes('vehicle_repairs'))
  assert.ok(tables.includes('sessions'))
  assert.match(readFileSync(new URL('../drizzle/migrations/0000_initial_mysql.sql', import.meta.url), 'utf8'), /GENERATED ALWAYS AS/)
})

test('mysqlConfig activa TLS solo cuando la URL o la CA lo piden', async () => {
  const { mysqlConfig } = await import('./store.js')
  const plain = mysqlConfig('mysql://user:p%40ss@localhost:3306/base', '')
  assert.equal(plain.ssl, undefined)
  assert.equal(plain.password, 'p@ss')
  assert.equal(plain.database, 'base')
  const required = mysqlConfig('mysql://user:pass@mysql-x.aivencloud.com:12345/defaultdb?ssl-mode=REQUIRED', '')
  assert.deepEqual(required.ssl, { rejectUnauthorized: true, minVersion: 'TLSv1.2' })
  assert.equal(required.database, 'defaultdb')
  assert.equal(required.port, 12345)
  const withCa = mysqlConfig('mysql://user:pass@host/base', '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----')
  assert.equal(withCa.ssl.ca, '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----')
  assert.equal(withCa.ssl.rejectUnauthorized, true)
})
