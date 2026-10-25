import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const migrationsFolder = new URL('../drizzle/migrations/', import.meta.url)
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationsFolder), 'utf8'))
const snapshot = idx => JSON.parse(readFileSync(new URL(`meta/${String(idx).padStart(4, '0')}_snapshot.json`, migrationsFolder), 'utf8'))

test('la cadena de migraciones está registrada como MySQL', () => {
  assert.equal(journal.dialect, 'mysql')
  assert.equal(journal.entries.length, 2)
  const entry = journal.entries[0]
  assert.equal(entry.idx, 0)
  assert.equal(entry.tag, '0000_initial_mysql')
  assert.equal(journal.entries[1].tag, '0001_people')
  assert.equal(snapshot(1).prevId, snapshot(0).id)
  assert.deepEqual(readdirSync(migrationsFolder).filter(name => name.endsWith('.sql')), ['0000_initial_mysql.sql', '0001_people.sql'])
  assert.deepEqual(readdirSync(new URL('meta/', migrationsFolder)).filter(name => name.endsWith('_snapshot.json')), ['0000_snapshot.json', '0001_snapshot.json'])
})

test('la migración no contiene sintaxis de PostgreSQL', () => {
  const sql = readFileSync(new URL('0000_initial_mysql.sql', migrationsFolder), 'utf8')
  assert.doesNotMatch(sql, /postgres|jsonb|pg_advisory|ON CONFLICT|::text|timestamp with time zone/i)
  assert.match(sql, /GENERATED ALWAYS AS/)
})

test('el snapshot final contiene todas las tablas de la aplicación', () => {
  const latest = snapshot(journal.entries.at(-1).idx)
  assert.equal(latest.dialect, 'mysql')
  assert.deepEqual(Object.keys(latest.tables).sort(), [
    'access_requests', 'app_settings', 'audits', 'document_files', 'document_types',
    'employees', 'notifications', 'parts', 'people', 'person_document_files', 'person_documents', 'sessions', 'vehicle_documents',
    'vehicle_repairs', 'vehicle_types', 'vehicles',
  ])
})

test('la ampliación agrega personas sin borrar datos ni cambiar la migración inicial', () => {
  const sql = readFileSync(new URL('0001_people.sql', migrationsFolder), 'utf8')
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|postgres|jsonb|ON CONFLICT/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `people`/)
  assert.match(sql, /UNIQUE \(`identification_type`, `identification_number`\)/)
  assert.match(sql, /ALTER TABLE `vehicles` ADD COLUMN `person_id`/)
  assert.match(sql, /person_documents_active_root_unique/)
  const latest = snapshot(1)
  assert.equal(latest.tables.person_documents.foreignKeys.person_documents_person_id_people_id_fk.tableTo, 'people')
  assert.equal(latest.tables.person_document_files.foreignKeys.person_document_files_document_id_person_documents_id_fk.tableTo, 'person_documents')
  assert.equal(latest.tables.vehicles.foreignKeys.vehicles_person_id_people_id_fk.onDelete, 'set null')
})

test('el SQL incremental coincide con las columnas y referencias del snapshot', () => {
  const sql = readFileSync(new URL('0001_people.sql', migrationsFolder), 'utf8')
  const latest = snapshot(1)
  for (const name of ['people', 'person_documents', 'person_document_files']) {
    const definition = sql.split(`CREATE TABLE IF NOT EXISTS \`${name}\` (`)[1].split('\n);')[0]
    const columns = [...definition.matchAll(/^\s*`([^`]+)`\s+/gm)].map(match => match[1]).sort()
    assert.deepEqual(columns, Object.keys(latest.tables[name].columns).sort())
    for (const fk of Object.values(latest.tables[name].foreignKeys)) {
      assert.ok(sql.includes(`ADD CONSTRAINT \`${fk.name}\` FOREIGN KEY (\`${fk.columnsFrom[0]}\`) REFERENCES \`${fk.tableTo}\` (\`${fk.columnsTo[0]}\`)`))
    }
  }
  const previous = snapshot(0)
  for (const [name, table] of Object.entries(previous.tables)) {
    const current = structuredClone(latest.tables[name])
    if (name === 'vehicles') {
      delete current.columns.person_id
      delete current.foreignKeys.vehicles_person_id_people_id_fk
    }
    assert.deepEqual(current, table, `La tabla existente ${name} conserva su definición`)
  }
})
