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
function isolatedDatabase(snapshotName = '0001_snapshot.json', { rawBooleans = false, mysqlDateOffset } = {}) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  const snapshot = JSON.parse(readFileSync(new URL(`../drizzle/migrations/meta/${snapshotName}`, import.meta.url), 'utf8'))
  const quote = (name) => `"${name.replaceAll('"', '""')}"`
  for (const table of Object.values(snapshot.tables)) {
    const definitions = Object.values(table.columns).map((column) => {
      const type = ['int', 'integer', 'boolean'].includes(column.type) ? 'INTEGER' : 'TEXT'
      const fallback = /^\(?now\(\)\)?$/.test(String(column.default)) ? '(CURRENT_TIMESTAMP)' : typeof column.default === 'boolean' ? Number(column.default) : typeof column.default === 'string' ? column.default : column.default
      if (column.generated) return `${quote(column.name)} ${type} GENERATED ALWAYS AS (CASE WHEN active = 1 THEN root_id ELSE NULL END) STORED`
      return `${quote(column.name)} ${type}${column.primaryKey ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${fallback !== undefined ? ` DEFAULT ${fallback}` : ''}`
    })
    for (const primary of Object.values(table.compositePrimaryKeys || {})) definitions.push(`PRIMARY KEY (${primary.columns.map(quote).join(', ')})`)
    for (const unique of Object.values(table.uniqueConstraints)) definitions.push(`UNIQUE (${unique.columns.map(quote).join(', ')})`)
    for (const index of Object.values(table.indexes || {})) if (index.isUnique) definitions.push(`UNIQUE (${index.columns.map(quote).join(', ')})`)
    for (const reference of Object.values(table.foreignKeys)) definitions.push(`FOREIGN KEY (${reference.columnsFrom.map(quote).join(', ')}) REFERENCES ${quote(reference.tableTo)} (${reference.columnsTo.map(quote).join(', ')}) ON DELETE ${reference.onDelete}`)
    database.exec(`CREATE TABLE ${quote(table.name)} (${definitions.join(', ')})`)
  }
  const encode = (value) => value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? Number(value) : value && typeof value === 'object' ? JSON.stringify(value) : value
  const decode = (row, columns) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value === null ? null : mysqlDateOffset && columns.some(column => column.name === key && column.table === 'people' && column.column === 'birth_date') ? new Date(`${value}T00:00:00${mysqlDateOffset}`) : !rawBooleans && ['active', 'read', 'requiresExpiration'].includes(key) ? Boolean(value) : ['data', 'requiredDocumentTypeIds', 'emailAlerts', 'parts'].includes(key) ? JSON.parse(value) : /At$/.test(key) || ['issueDate', 'expirationDate'].includes(key) ? new Date(value) : value,
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
    return Promise.resolve(prepared.columns().length ? prepared.all(...bindings).map(row => decode(row, prepared.columns())) : (prepared.run(...bindings), []))
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

test('los booleanos que MySQL devuelve como 0/1 se leen como true/false', async (t) => {
  // mysql2 entrega BOOLEAN (TINYINT(1)) como número; el login exige employee.active === true.
  const { database, client } = isolatedDatabase(undefined, { rawBooleans: true })
  t.after(() => database.close())
  const initial = fixture()
  initial.employees[1].active = false
  initial.notifications = [{ id: 'n', title: 'Aviso', description: '', type: 'info', read: true }]
  await writeStore(initial, client)
  const loaded = await readStore(client)
  assert.deepEqual(loaded.employees.map((employee) => employee.active), [true, false])
  assert.equal(loaded.vehicleTypes[0].active, true)
  assert.equal(loaded.documentTypes[0].active, true)
  assert.equal(loaded.documentTypes[0].requiresExpiration, true)
  assert.equal(loaded.documents[0].active, true)
  assert.equal(loaded.notifications[0].read, true)
  loaded.employees[0].name = 'Admin renombrado'
  await writeStore(loaded, client)
  assert.equal((await readStore(client)).employees[0].active, true)
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
  assert.equal(mysqlConfig('mysql://user:pass@public-host/base', '', { forceTls: true }).ssl.rejectUnauthorized, true)
})

test('persiste personas, asignaciones y archivos sin mezclar documentos de vehículos', async (t) => {
  const { database, client } = isolatedDatabase(undefined, { rawBooleans: true })
  t.after(() => database.close())
  const initial = fixture()
  initial.people = [{ id: 'p', firstName: 'Ana', lastName: 'Pérez', identificationType: 'DNI', identificationNumber: '30111222', birthDate: '1990-06-15', email: 'ana@example.com', phone: '1122334455', address: 'San Martín 100', city: 'Rosario', province: 'Santa Fe', nationality: 'Argentina', notes: 'Conductora', active: true }]
  initial.vehicles[0].personId = 'p'
  initial.documents.push({ id: 'pd', personId: 'p', typeId: 'dt', number: 'LIC-1', issueDate: '2026-01-01', expirationDate: '2027-01-01', notes: 'Licencia', active: true, version: 1, fileId: 'pf', fileName: 'licencia.pdf', filePath: 'licencia-storage.pdf', mimeType: 'application/pdf', sizeBytes: 100 })
  await writeStore(initial, client)
  let loaded = await readStore(client)
  assert.equal(loaded.people[0].firstName, 'Ana')
  assert.equal(loaded.people[0].birthDate, '1990-06-15')
  assert.equal(loaded.people[0].active, true)
  assert.equal(loaded.vehicles[0].personId, 'p')
  const personalDocument = loaded.documents.find(doc => doc.id === 'pd')
  assert.equal(personalDocument.personId, 'p')
  assert.equal(personalDocument.vehicleId, undefined)
  assert.equal(personalDocument.fileName, 'licencia.pdf')
  assert.equal(personalDocument.sizeBytes, 100)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vehicle_documents').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM person_documents').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_files').get().count, 0)
  loaded.vehicles[0].personId = null
  loaded.people[0].active = false
  loaded.people[0].notes = ''
  await writeStore(loaded, client)
  loaded = await readStore(client)
  assert.equal(loaded.vehicles[0].personId, null)
  assert.equal(loaded.people[0].active, false)
  assert.equal(loaded.people[0].notes, '')
})

test('la fecha de nacimiento conserva el día al leer y editar en distintas zonas del servidor', async () => {
  for (const mysqlDateOffset of ['+09:00', '-03:00']) {
    const { database, client } = isolatedDatabase(undefined, { mysqlDateOffset })
    try {
      const initial = fixture()
      initial.people = [{ id: 'p', firstName: 'Ana', lastName: 'Pérez', identificationType: 'DNI', identificationNumber: '30111222', birthDate: '1990-06-15', active: true }]
      await writeStore(initial, client)
      const [nativeDate] = await client`SELECT birth_date AS birthDate FROM people`
      assert.ok(nativeDate.birthDate instanceof Date)
      if (mysqlDateOffset === '+09:00') assert.equal(nativeDate.birthDate.toISOString().slice(0, 10), '1990-06-14')
      const loaded = await readStore(client)
      assert.equal(loaded.people[0].birthDate, '1990-06-15')
      loaded.people[0].phone = '123456'
      await writeStore(loaded, client)
      assert.equal((await readStore(client)).people[0].birthDate, '1990-06-15')
    } finally { database.close() }
  }
})

test('la renovación personal conserva el archivo histórico y limita la cadena a una versión activa', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  const initial = fixture()
  initial.people = [{ id: 'p', firstName: 'Ana', lastName: 'Pérez', identificationType: 'DNI', identificationNumber: '30111222', active: true }]
  initial.documents.push({ id: 'pd', personId: 'p', typeId: 'dt', expirationDate: '2026-01-01', active: true, version: 1, fileName: 'anterior.pdf', filePath: 'anterior.pdf' })
  await writeStore(initial, client)
  let loaded = await readStore(client)
  const previous = loaded.documents.find(doc => doc.id === 'pd')
  previous.active = false
  loaded.documents.push({ id: 'pd2', rootId: 'pd', previousId: 'pd', personId: 'p', typeId: 'dt', expirationDate: '2027-01-01', active: true, version: 2 })
  await writeStore(loaded, client)
  loaded = await readStore(client)
  assert.equal(loaded.documents.find(doc => doc.id === 'pd').fileName, 'anterior.pdf')
  assert.equal(loaded.documents.find(doc => doc.id === 'pd2').fileName, undefined)
  assert.equal(loaded.documents.find(doc => doc.id === 'pd2').version, 2)
  loaded.documents.push({ id: 'pd3', rootId: 'pd', personId: 'p', typeId: 'dt', active: true })
  await assert.rejects(writeStore(loaded, client), /UNIQUE/)
  assert.equal((await readStore(client)).documents.filter(doc => doc.personId === 'p').length, 2)
})

test('rechaza identificaciones duplicadas y asignaciones inexistentes con reversión completa', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  const initial = fixture()
  initial.people = [{ id: 'p', firstName: 'Ana', lastName: 'Pérez', identificationType: 'DNI', identificationNumber: '30111222', active: true }]
  await writeStore(initial, client)
  let loaded = await readStore(client)
  loaded.people.push({ ...loaded.people[0], id: 'p2' })
  await assert.rejects(writeStore(loaded, client), /UNIQUE/)
  loaded = await readStore(client)
  loaded.vehicles[0].personId = 'missing'
  loaded.people[0].firstName = 'No guardar'
  await assert.rejects(writeStore(loaded, client), /FOREIGN KEY/)
  assert.equal((await readStore(client)).people[0].firstName, 'Ana')
})

test('reemplazar o quitar un adjunto personal actualiza solo su registro de archivo', async (t) => {
  const { database, client } = isolatedDatabase()
  t.after(() => database.close())
  const initial = fixture()
  initial.people = [{ id: 'p', firstName: 'Ana', lastName: 'Pérez', identificationType: 'DNI', identificationNumber: '30111222', active: true }]
  initial.documents.push({ id: 'pd', personId: 'p', typeId: 'dt', active: true, fileName: 'anterior.pdf', filePath: 'anterior.pdf' })
  await writeStore(initial, client)
  let loaded = await readStore(client)
  Object.assign(loaded.documents.find(doc => doc.id === 'pd'), { fileName: 'actual.pdf', filePath: 'actual.pdf', sizeBytes: 200 })
  await writeStore(loaded, client)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM person_document_files').get().count, 1)
  loaded = await readStore(client)
  assert.equal(loaded.documents.find(doc => doc.id === 'pd').fileName, 'actual.pdf')
  for (const field of ['fileId', 'fileName', 'filePath', 'mimeType', 'sizeBytes']) delete loaded.documents.find(doc => doc.id === 'pd')[field]
  await writeStore(loaded, client)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM person_document_files').get().count, 0)
  assert.equal((await readStore(client)).documents.length, 2)
})
