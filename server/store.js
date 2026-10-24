import 'dotenv/config'
import mysql from 'mysql2/promise'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, scryptSync, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = dirname(fileURLToPath(import.meta.url))
export const uploadsDir = join(serverDir, 'uploads')
const connectionString = process.env.DATABASE_URL
let sqlClient
const operation = new AsyncLocalStorage()
const STORE_LOCK = 'mycarmanagement:store'

function isTaggedClient(client) {
  return typeof client === 'function'
}

function mysqlConfig(urlValue) {
  if (!urlValue) throw new Error('DATABASE_URL es obligatorio para usar MyCarManagement')
  const url = new URL(urlValue)
  if (!['mysql:', 'mysql2:'].includes(url.protocol)) throw new Error('DATABASE_URL debe usar el formato mysql://usuario:contrasena@host:3306/base')
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: false,
  }
}

function sql() {
  if (!sqlClient) sqlClient = mysql.createPool(mysqlConfig(connectionString))
  return sqlClient
}

function encodeTaggedValue(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return Number(value)
  if (value && typeof value === 'object') return JSON.stringify(value)
  return value
}

// The small tagged-template branch keeps the store tests' isolated SQL adapter
// working, while the normal path uses mysql2 prepared statements.
async function execute(client, statement, values = []) {
  if (isTaggedClient(client)) {
    const strings = statement.split('?')
    strings.raw = strings
    return client(strings, ...values.map(encodeTaggedValue))
  }
  const [rows] = await client.execute(statement, values)
  return rows
}

async function inTransaction(client, work) {
  if (typeof client.beginTransaction === 'function') {
    await client.beginTransaction()
    try {
      const result = await work()
      await client.commit()
      return result
    } catch (error) {
      await client.rollback()
      throw error
    }
  }
  if (typeof client.begin === 'function') return client.begin(() => work())
  return work()
}

// The lock is held by the same MySQL connection as the read/write operation
// and works across API processes.
export async function withStoreTransaction(work) {
  if (operation.getStore()) return work()
  const client = await sql().getConnection()
  let lockAcquired = false
  try {
    const lockResult = await execute(client, 'SELECT GET_LOCK(?, 60) AS acquired', [STORE_LOCK])
    lockAcquired = Number(lockResult?.[0]?.acquired) === 1
    if (!lockAcquired) throw new Error('No se pudo obtener el bloqueo de la base de datos')
    return await operation.run({ client, baseline: null }, work)
  } finally {
    if (lockAcquired) await execute(client, 'SELECT RELEASE_LOCK(?) AS released', [STORE_LOCK]).catch(() => {})
    client.release()
  }
}

export async function closeStore() {
  if (sqlClient) await sqlClient.end()
  sqlClient = undefined
}

const databaseStatusToApp = { ACTIVO: 'Activo', EN_MANTENIMIENTO: 'En mantenimiento', FUERA_DE_SERVICIO: 'Fuera de servicio', VENDIDO: 'Vendido', BAJA: 'Baja' }
const appStatusToDatabase = Object.fromEntries(Object.entries(databaseStatusToApp).map(([key, value]) => [value, key]))
const dateValue = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value
const timestampValue = (value) => value ? new Date(value) : new Date()
const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function mapDatabaseStore(rows) {
  const { employees, accessRequests, vehicleTypes, documentTypes, vehicles, documents, documentFiles, notifications, audits, settings, parts = [], repairs = [], sessions = [] } = rows
  const filesByDocument = Object.fromEntries(documentFiles.map((file) => [file.documentId, { fileId: file.id, fileName: file.fileName, filePath: file.storageKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes }]))
  return {
    employees: employees.map((employee) => ({ ...employee, role: employee.role === 'ADMINISTRADOR' ? 'Administrador' : 'Empleado' })),
    accessRequests,
    sessions,
    vehicleTypes: vehicleTypes.map((type) => ({ ...type, requiredDocumentTypeIds: parseJson(type.requiredDocumentTypeIds, []) })),
    documentTypes,
    vehicles: vehicles.map((vehicle) => ({ ...vehicle, status: databaseStatusToApp[vehicle.status] || vehicle.status })),
    documents: documents.map((document) => ({ ...document, ...filesByDocument[document.id], issueDate: dateValue(document.issueDate), expirationDate: dateValue(document.expirationDate), notes: document.observations || '' })),
    notifications,
    audit: audits.map((audit) => ({ ...audit, data: parseJson(audit.data) })),
    settings: settings[0] ? { ...settings[0], emailAlerts: parseJson(settings[0].emailAlerts, {}) } : { firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7, companyName: 'MyCarManagement', timezone: 'America/Argentina/Buenos_Aires', emailAlerts: {} },
    parts,
    repairs: repairs.map((repair) => ({ ...repair, parts: parseJson(repair.parts, []) })),
  }
}

export const passwordRecord = (password) => {
  const salt = randomBytes(16).toString('hex')
  return { passwordSalt: salt, passwordHash: scryptSync(password, salt, 64).toString('hex') }
}

export function ensureStore() {
  mkdirSync(uploadsDir, { recursive: true })
}

export async function readStore(clientOverride) {
  ensureStore()
  if (clientOverride) return operation.run({ client: clientOverride, baseline: null }, () => readStore())
  if (!operation.getStore()) return withStoreTransaction(() => readStore())
  const client = operation.getStore().client
  const [employees, accessRequests, vehicleTypes, documentTypes, vehicles, documents, documentFiles, notifications, audits, settings, parts, repairs, sessions] = await Promise.all([
    execute(client, 'SELECT id, name, username, email, password_hash AS passwordHash, password_salt AS passwordSalt, role, active, created_at AS createdAt, updated_at AS updatedAt FROM employees ORDER BY created_at'),
    execute(client, 'SELECT id, name, username, email, password_hash AS passwordHash, password_salt AS passwordSalt, created_at AS createdAt FROM access_requests ORDER BY created_at'),
    execute(client, 'SELECT id, name, active, required_document_type_ids AS requiredDocumentTypeIds, created_at AS createdAt, updated_at AS updatedAt FROM vehicle_types ORDER BY name'),
    execute(client, 'SELECT id, name, description, requires_expiration AS requiresExpiration, usual_duration_days AS usualDurationDays, alert_days AS alertDays, active, created_at AS createdAt, updated_at AS updatedAt FROM document_types ORDER BY name'),
    execute(client, 'SELECT id, plate, unit, type_id AS typeId, brand, model, year, chassis, engine, color, status, mileage, branch, driver, notes, created_at AS createdAt, updated_at AS updatedAt FROM vehicles ORDER BY unit'),
    execute(client, 'SELECT id, vehicle_id AS vehicleId, type_id AS typeId, number, issue_date AS issueDate, expiration_date AS expirationDate, observations, active, version, previous_id AS previousId, root_id AS rootId, created_at AS createdAt, updated_at AS updatedAt FROM vehicle_documents ORDER BY expiration_date IS NULL, expiration_date'),
    execute(client, 'SELECT id, document_id AS documentId, file_name AS fileName, mime_type AS mimeType, storage_key AS storageKey, size_bytes AS sizeBytes, created_at AS createdAt FROM document_files ORDER BY created_at'),
    execute(client, 'SELECT id, title, description, type, `read`, document_id AS documentId, created_at AS createdAt FROM notifications ORDER BY created_at DESC'),
    execute(client, 'SELECT id, employee_id AS employeeId, employee_name AS employeeName, employee_email AS employeeEmail, action, entity, entity_id AS entityId, data, created_at AS createdAt FROM audits ORDER BY created_at DESC, id DESC'),
    execute(client, 'SELECT first_alert_days AS firstAlertDays, second_alert_days AS secondAlertDays, urgent_days AS urgentDays, company_name AS companyName, timezone, email_alerts AS emailAlerts FROM app_settings LIMIT 1'),
    execute(client, 'SELECT id, name, stock, unit, min_stock AS minStock, category, created_at AS createdAt, updated_at AS updatedAt FROM parts ORDER BY name'),
    execute(client, 'SELECT id, vehicle_id AS vehicleId, description, date, mileage, notes, parts, employee_id AS employeeId, employee_name AS employeeName, created_at AS createdAt FROM vehicle_repairs ORDER BY date DESC, created_at DESC'),
    execute(client, 'SELECT token_hash AS id, employee_id AS employeeId, expires_at AS expiresAt, created_at AS createdAt FROM sessions'),
  ])
  const store = mapDatabaseStore({ employees, accessRequests, vehicleTypes, documentTypes, vehicles, documents, documentFiles, notifications, audits, settings, parts, repairs, sessions })
  operation.getStore().baseline = structuredClone(store)
  operation.getStore().settingsExists = settings.length > 0
  return store
}

// Solo las entidades modificadas generan SQL. Nunca se borra y reconstruye la base.
function tables(data) {
  return [
    ['employees', data.employees, e => ({ id: e.id, name: e.name, username: e.username, email: e.email, password_hash: e.passwordHash, password_salt: e.passwordSalt, role: e.role === 'Administrador' ? 'ADMINISTRADOR' : 'EMPLEADO', active: e.active === true, created_at: timestampValue(e.createdAt), updated_at: timestampValue(e.updatedAt) })],
    ['access_requests', data.accessRequests || [], r => ({ id: r.id, name: r.name, username: r.username, email: r.email, password_hash: r.passwordHash, password_salt: r.passwordSalt, created_at: timestampValue(r.createdAt) })],
    ['vehicle_types', data.vehicleTypes, t => ({ id: t.id, name: t.name, active: t.active !== false, required_document_type_ids: t.requiredDocumentTypeIds || [], created_at: timestampValue(t.createdAt), updated_at: timestampValue(t.updatedAt) }), ['required_document_type_ids']],
    ['document_types', data.documentTypes, t => ({ id: t.id, name: t.name, description: t.description || '', requires_expiration: t.requiresExpiration !== false, usual_duration_days: t.usualDurationDays ?? null, alert_days: t.alertDays ?? null, active: t.active !== false, created_at: timestampValue(t.createdAt), updated_at: timestampValue(t.updatedAt) })],
    ['vehicles', data.vehicles, v => ({ id: v.id, plate: v.plate, unit: v.unit, type_id: v.typeId, brand: v.brand, model: v.model, year: v.year ?? null, chassis: v.chassis || '', engine: v.engine || '', color: v.color || '', status: appStatusToDatabase[v.status], mileage: v.mileage ?? 0, branch: v.branch || '', driver: v.driver || '', notes: v.notes || '', created_at: timestampValue(v.createdAt), updated_at: timestampValue(v.updatedAt) })],
    ['vehicle_documents', data.documents, d => ({ id: d.id, vehicle_id: d.vehicleId, type_id: d.typeId, number: d.number || '', issue_date: d.issueDate ? timestampValue(d.issueDate) : null, expiration_date: d.expirationDate ? timestampValue(d.expirationDate) : null, observations: d.notes || '', active: d.active !== false, version: d.version || 1, previous_id: d.previousId || null, root_id: d.rootId || d.id, created_at: timestampValue(d.createdAt), updated_at: timestampValue(d.updatedAt) })],
    ['document_files', data.documents.filter(d => d.fileName && d.filePath).map(d => ({ id: d.fileId || 'file-' + d.id, documentId: d.id, fileName: d.fileName, mimeType: d.mimeType, filePath: d.filePath, sizeBytes: d.sizeBytes, createdAt: d.createdAt })), f => ({ id: f.id, document_id: f.documentId, file_name: f.fileName, mime_type: f.mimeType || 'application/octet-stream', storage_key: f.filePath, size_bytes: f.sizeBytes || 0, created_at: timestampValue(f.createdAt) })],
    ['notifications', data.notifications || [], n => ({ id: n.id, title: n.title, description: n.description, type: n.type, read: n.read === true, document_id: n.documentId || null, created_at: timestampValue(n.createdAt) })],
    ['audits', (data.audit || []).map(a => ({ ...a, employeeId: data.employees.some(e => e.id === a.employeeId) ? a.employeeId : null })), a => ({ id: a.id, employee_id: a.employeeId, employee_name: a.employeeName || 'Sistema', employee_email: a.employeeEmail ?? null, action: a.action, entity: a.entity, entity_id: a.entityId, data: a.data || {}, created_at: timestampValue(a.createdAt) }), ['data']],
    ['app_settings', [{ id: 1, ...data.settings }], s => ({ id: 1, first_alert_days: s.firstAlertDays ?? 30, second_alert_days: s.secondAlertDays ?? 15, urgent_days: s.urgentDays ?? 7, company_name: s.companyName || 'MyCarManagement', timezone: s.timezone || 'America/Argentina/Buenos_Aires', email_alerts: s.emailAlerts || {} }), ['email_alerts']],
    ['parts', data.parts || [], p => ({ id: p.id, name: p.name, stock: p.stock, unit: p.unit || 'unidad', min_stock: p.minStock ?? 5, category: p.category || 'General', created_at: timestampValue(p.createdAt), updated_at: timestampValue(p.updatedAt) })],
    ['vehicle_repairs', data.repairs || [], r => ({ id: r.id, vehicle_id: r.vehicleId, description: r.description, date: r.date, mileage: r.mileage ?? null, notes: r.notes || '', parts: r.parts, employee_id: r.employeeId, employee_name: r.employeeName, created_at: timestampValue(r.createdAt) }), ['parts']],
    ['sessions', data.sessions || [], s => ({ token_hash: s.id, employee_id: s.employeeId, expires_at: timestampValue(s.expiresAt), created_at: timestampValue(s.createdAt) }), [], 'token_hash'],
  ]
}

export async function writeStore(data, clientOverride) {
  if (clientOverride) return operation.run({ client: clientOverride, baseline: null }, async () => {
    await readStore()
    return writeStore(data)
  })
  const scope = operation.getStore()
  if (!scope?.baseline) throw new Error('La escritura requiere una lectura dentro de withStoreTransaction')
  const previous = tables(scope.baseline)
  if (!scope.settingsExists) previous.find(([name]) => name === 'app_settings')[1] = []
  const next = tables(data)
  const transaction = scope.client

  await inTransaction(transaction, async () => {
    for (let i = 0; i < next.length; i++) {
      const [table, records, map, jsonFields = [], key = 'id'] = next[i]
      const old = new Map(previous[i][1].map(row => [row.id, row]))
      const changed = records.filter(row => JSON.stringify(old.get(row.id)) !== JSON.stringify(row))
      changed.sort((a, b) => Number(old.has(b.id)) - Number(old.has(a.id)))
      for (const record of changed) {
        const row = map(record)
        for (const field of jsonFields) row[field] = JSON.stringify(row[field])
        const columns = Object.keys(row)
        const placeholders = columns.map(() => '?').join(', ')
        const values = columns.map(column => row[column])
        if (table === 'audits') {
          const duplicateHandling = isTaggedClient(transaction) ? 'INSERT OR IGNORE' : 'INSERT'
          const suffix = isTaggedClient(transaction) ? '' : ' ON DUPLICATE KEY UPDATE id = id'
          await execute(transaction, `${duplicateHandling} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})${suffix}`, values)
          continue
        }
        if (old.has(record.id)) {
          const fields = columns.filter(column => column !== key)
          await execute(transaction, `UPDATE ${table} SET ${fields.map(column => `${column} = ?`).join(', ')} WHERE ${key} = ?`, [...fields.map(column => row[column]), record.id])
        } else await execute(transaction, `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, values)
      }
    }
    for (let i = next.length - 1; i >= 0; i--) {
      const [table, records, , , key = 'id'] = next[i]
      if (table === 'audits') continue
      const ids = new Set(records.map(row => row.id))
      for (const old of previous[i][1]) if (!ids.has(old.id)) await execute(transaction, `DELETE FROM ${table} WHERE ${key} = ?`, [old.id])
    }
  })
  scope.baseline = structuredClone(data)
  scope.settingsExists = true
  return data
}

export { randomUUID }
