import 'dotenv/config'
import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mysqlConfig } from './store.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle/migrations/', import.meta.url))
const storeLock = 'mycarmanagement:store'

function migrationFailure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function migrationErrorMessage(error) {
  const codes = new Set()
  const seen = new Set()
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current)
    codes.add(current.code)
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) return 'No se pudo encontrar el servidor MySQL. Revisá el host de DATABASE_URL en backend/.env.'
  if (codes.has('ECONNREFUSED') || codes.has('ETIMEDOUT') || codes.has('EHOSTUNREACH')) return 'No se pudo conectar con MySQL. Revisá el servidor, el puerto y el acceso de red de DATABASE_URL.'
  if (codes.has('ER_ACCESS_DENIED_ERROR')) return 'MySQL rechazó el acceso. Revisá el usuario y la contraseña de DATABASE_URL.'
  if (codes.has('ER_BAD_DB_ERROR')) return 'La base MySQL indicada no existe. Revisá el nombre de la base en DATABASE_URL.'
  if (codes.has('ERR_INVALID_URL') || codes.has('MIGRATION_CONFIG')) return 'Configurá DATABASE_URL en backend/.env con el formato mysql://usuario:contrasena@host:3306/base.'
  if (codes.has('MIGRATION_HISTORY')) return 'La base tiene tablas existentes pero no registra su migración inicial. Revisá __drizzle_migrations antes de continuar; no se modificó el esquema.'
  if (codes.has('MIGRATION_AHEAD')) return 'La base registra una migración más reciente que esta versión de la aplicación. Actualizá el backend antes de migrar.'
  if (codes.has('MIGRATION_LOCK')) return 'No se pudo obtener el bloqueo de la base. Volvé a intentar cuando termine la operación en curso.'
  if (codes.has('MIGRATION_ARGS')) return 'Opción desconocida. Usá npm run db:migrate o npm run db:migrate -- --check.'
  if (codes.has('ER_TABLEACCESS_DENIED_ERROR') || codes.has('ER_DBACCESS_DENIED_ERROR')) return 'El usuario MySQL no tiene los permisos necesarios para consultar o actualizar el esquema.'
  if ([...codes].some(code => typeof code === 'string' && /CERT|TLS|SSL/.test(code))) return 'No se pudo verificar la conexión TLS con MySQL. Revisá la configuración SSL y DATABASE_CA_CERT.'
  return 'No se pudo completar la migración. Revisá la disponibilidad de MySQL, los permisos y el esquema antes de volver a ejecutarla.'
}

export async function migrateDatabase({ checkOnly = false, databaseUrl = process.env.DATABASE_URL, createConnection = mysql.createConnection, applyMigrations = client => migrate(drizzle(client), { migrationsFolder }), log = console.log } = {}) {
  const migrations = readMigrationFiles({ migrationsFolder })
  let config
  try {
    config = mysqlConfig(databaseUrl)
    delete config.waitForConnections
    delete config.connectionLimit
  } catch {
    throw migrationFailure('MIGRATION_CONFIG')
  }
  // One connection keeps the API's store lock held throughout the schema update.
  const client = await createConnection({ ...config, connectTimeout: 15000 })
  let locked = false
  try {
    let applied = []
    try { [applied] = await client.execute('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at') }
    catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error }
    if (!applied.length) {
      const [existing] = await client.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('vehicles', 'employees', 'document_types', 'people')")
      if (existing.length) throw migrationFailure('MIGRATION_HISTORY')
    }
    const latest = Math.max(0, ...applied.map(row => Number(row.created_at)))
    if (latest > migrations.at(-1).folderMillis) throw migrationFailure('MIGRATION_AHEAD')
    const pending = migrations.filter(item => item.folderMillis > latest)
    log(`Migraciones pendientes: ${pending.length}`)
    if (!checkOnly && pending.length) {
      const [result] = await client.execute('SELECT GET_LOCK(?, 60) AS acquired', [storeLock])
      locked = Number(result[0]?.acquired) === 1
      if (!locked) throw migrationFailure('MIGRATION_LOCK')
      await applyMigrations(client)
      log('Base de datos actualizada correctamente')
    }
    return { pending: pending.length, applied: checkOnly ? 0 : pending.length }
  } finally {
    if (locked) await client.execute('SELECT RELEASE_LOCK(?)', [storeLock]).catch(() => {})
    await client.end()
  }
}

export async function runMigrationCommand({ args = process.argv.slice(2), errorLog = console.error, ...options } = {}) {
  try {
    if (args.some(arg => arg !== '--check')) throw migrationFailure('MIGRATION_ARGS')
    await migrateDatabase({ ...options, checkOnly: args.includes('--check') })
    return 0
  } catch (error) {
    // Driver errors can contain credentials or SQL; only controlled guidance is printed.
    errorLog(migrationErrorMessage(error))
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runMigrationCommand()
