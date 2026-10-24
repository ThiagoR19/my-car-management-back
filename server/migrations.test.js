import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const migrationsFolder = new URL('../drizzle/migrations/', import.meta.url)
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationsFolder), 'utf8'))
const snapshot = idx => JSON.parse(readFileSync(new URL(`meta/${String(idx).padStart(4, '0')}_snapshot.json`, migrationsFolder), 'utf8'))

test('la cadena de migraciones está registrada como MySQL', () => {
  assert.equal(journal.dialect, 'mysql')
  assert.equal(journal.entries.length, 1)
  const entry = journal.entries[0]
  assert.equal(entry.idx, 0)
  assert.equal(entry.tag, '0000_initial_mysql')
  assert.deepEqual(readdirSync(migrationsFolder).filter(name => name.endsWith('.sql')), ['0000_initial_mysql.sql'])
  assert.deepEqual(readdirSync(new URL('meta/', migrationsFolder)).filter(name => name.endsWith('_snapshot.json')), ['0000_snapshot.json'])
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
    'employees', 'notifications', 'parts', 'sessions', 'vehicle_documents',
    'vehicle_repairs', 'vehicle_types', 'vehicles',
  ])
})
