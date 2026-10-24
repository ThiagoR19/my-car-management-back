import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync, timingSafeEqual, randomUUID, createHash } from 'node:crypto'
import { addAudit, dashboard, describeAudit, enrichDocument, getExpirations, isVehicleDocumentationIncomplete, todayIso } from './domain.js'
import { passwordRecord, readStore, uploadsDir, writeStore, withStoreTransaction } from './store.js'
import { csvEscape, parseCsv, validateDocument, validateSettings, validateVehicle, validateDocumentType, validateBooleans, integer, invalid, ValidationError } from './validation.js'
import { recordRepair, vehicleHistory } from './maintenance.js'
import { buildEmailReport, createMailer, deliverEmail, emailConfig, logSmtpError, runScheduledEmail, sendTestEmail, smtpErrorMessage, validateEmailConfig } from './email.js'

const port = Number(process.env.PORT || 3000)
const tokenHash = (token) => createHash('sha256').update(token).digest('hex')

function send(res, status, payload, headers = {}) {
  const isText = typeof payload === 'string'
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers })
  res.end(isText ? payload : JSON.stringify(payload))
}

function error(res, status, message) {
  send(res, status, { error: message })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 3_000_000) throw new Error('El cuerpo de la solicitud supera el límite de 3 MB')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw) } catch { invalid('El JSON no es válido') }
  }
  return { raw }
}

function publicEmployee(employee) {
  if (!employee) return null
  const safe = { ...employee }
  delete safe.passwordHash
  delete safe.passwordSalt
  return safe
}

function publicAccessRequest(request) {
  if (!request) return null
  const safe = { ...request }
  delete safe.passwordHash
  delete safe.passwordSalt
  return safe
}

function authenticate(req, store, now) {
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const session = store.sessions.find((item) => item.id === tokenHash(token) && new Date(item.expiresAt).getTime() > now())
  const employeeId = session?.employeeId
  const employee = employeeId ? store.employees.find((employee) => employee.id === employeeId && employee.active === true) : null
  return employee
}

function revokeSessions(store, employeeId, keepToken) {
  store.sessions = store.sessions.filter((session) => session.employeeId !== employeeId || session.id === tokenHash(keepToken || ''))
}

function verifyPassword(password, employee) {
  if (!employee?.passwordHash || !employee.passwordSalt) return false
  const actual = Buffer.from(scryptSync(password, employee.passwordSalt, 64).toString('hex'), 'hex')
  const expected = Buffer.from(employee.passwordHash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function requireAdmin(res, actor) {
  if (actor?.role !== 'Administrador') {
    error(res, 403, 'Se requiere rol Administrador')
    return false
  }
  return true
}

function typeName(store, typeId) {
  return store.vehicleTypes.find((type) => type.id === typeId)?.name || typeId
}

function isLastActiveAdmin(store, employee) {
  return employee.role === 'Administrador' && employee.active === true && !store.employees.some((item) => item.id !== employee.id && item.role === 'Administrador' && item.active === true)
}

function requiredDocumentTypes(body, store, previous = []) {
  const ids = body.requiredDocumentTypeIds ?? previous
  if (!Array.isArray(ids) || ids.some((id) => !store.documentTypes.some((type) => type.id === id && (type.active !== false || previous.includes(id))))) invalid('Los tipos de documentos obligatorios no son válidos')
  return [...new Set(ids)]
}

function validateRole(body) {
  if (body.role !== undefined && !['Administrador', 'Empleado'].includes(body.role)) invalid('El rol no es válido')
}

function vehicleView(vehicle, store) {
  const documents = store.documents.filter((doc) => doc.vehicleId === vehicle.id && doc.active !== false).map((doc) => enrichDocument(doc, store))
  const next = documents.filter((doc) => doc.daysRemaining !== null).sort((a, b) => a.daysRemaining - b.daysRemaining)[0]
  return { ...vehicle, type: typeName(store, vehicle.typeId), documents, documentCount: documents.length, documentationIncomplete: vehicle.status === 'Activo' && isVehicleDocumentationIncomplete(vehicle, store), nextExpiration: next || null }
}

function upsertNotifications(store) {
  const expirations = getExpirations(store, {})
  const previous = new Map(store.notifications.map((item) => [item.id, item]))
  const generated = expirations.filter((item) => item.statusTone === 'danger').map((item) => {
    const id = `notification-${item.id}`
    const existing = previous.get(id)
    return { id, type: item.status === 'Vencido' ? 'danger' : 'warning', title: `${item.typeName} ${item.status === 'Vencido' ? 'vencido' : 'próximo a vencer'}`, description: `${item.vehiclePlate} · ${item.formattedExpirationDate}`, documentId: item.id, read: existing?.read === true, createdAt: existing?.createdAt || new Date().toISOString() }
  })
  const manual = store.notifications.filter((item) => !item.id.startsWith('notification-'))
  store.notifications = [...generated, ...manual]
  return store.notifications
}

function csvResponse(res, rows, filename) {
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n')
  send(res, 200, `${csv}\n`, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` })
}

async function handle(req, res, context = { readStore, writeStore, now: Date.now, sessionTtlMs: 43200000 }, providedBody) {
  const { readStore, writeStore, now, sessionTtlMs } = context
  if (req.method === 'OPTIONS') return send(res, 204, '')
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const api = parts[0] === 'api'
  if (!api) return error(res, 404, 'Ruta no encontrada')
  const body = providedBody ?? (['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {})
  const store = await readStore()
  store.parts = store.parts || []
  store.repairs = store.repairs || []
  store.sessions = store.sessions || []
  store.accessRequests = store.accessRequests || []

  if (req.method === 'GET' && parts[1] === 'health') return send(res, 200, { ok: true, service: 'mycarmanagement-api', persistence: 'mysql' })
  if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'login') {
    const identifier = String(body.identifier || body.username || body.email || '').toLowerCase().trim()
    const employee = store.employees.find((item) => item.username?.toLowerCase() === identifier || item.email.toLowerCase() === identifier)
    if (!employee) {
      const pendingRequest = store.accessRequests.find((item) => item.username?.toLowerCase() === identifier || item.email?.toLowerCase() === identifier)
      if (pendingRequest) return error(res, 403, 'Tu cuenta no tiene acceso al sistema todavía. Un administrador debe activarla antes de que puedas ingresar')
      return error(res, 401, 'Usuario, email o contraseña incorrectos')
    }
    if (employee.active !== true) return error(res, 403, 'Tu cuenta no tiene acceso al sistema todavía. Un administrador debe activarla antes de que puedas ingresar')
    if (!verifyPassword(String(body.password || ''), employee)) return error(res, 401, 'Usuario, email o contraseña incorrectos')
    const token = randomUUID()
    const expiresAt = new Date(now() + sessionTtlMs).toISOString()
    store.sessions = store.sessions.filter((session) => new Date(session.expiresAt).getTime() > now())
    store.sessions.push({ id: tokenHash(token), employeeId: employee.id, expiresAt, createdAt: new Date(now()).toISOString() })
    await writeStore(store)
    return send(res, 200, { token, expiresAt, employee: publicEmployee(employee) })
  }
  if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'register') {
    const name = String(body.name || '').trim()
    const username = String(body.username || '').trim().toLowerCase()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const passwordConfirmation = String(body.passwordConfirmation || body.repeatPassword || '')
    if (!name) return error(res, 400, 'El nombre es obligatorio')
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return error(res, 400, 'El nombre de usuario debe tener entre 3 y 30 caracteres y usar solo letras, números, punto, guion o guion bajo')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, 'El email no es válido')
    if (password.length < 8) return error(res, 400, 'La contraseña debe tener al menos 8 caracteres')
    if (password !== passwordConfirmation) return error(res, 400, 'Las contraseñas no coinciden')
    const employeeByUsername = store.employees.find((item) => item.username?.toLowerCase() === username)
    const employeeByEmail = store.employees.find((item) => item.email?.toLowerCase() === email)
    if (store.accessRequests.some((item) => item.username?.toLowerCase() === username)) return error(res, 409, 'El nombre de usuario ya existe')
    if (store.accessRequests.some((item) => item.email?.toLowerCase() === email)) return error(res, 409, 'El email ya existe')
    if (employeeByUsername || employeeByEmail) {
      if (!employeeByUsername || employeeByUsername.id !== employeeByEmail?.id) return error(res, 409, 'El usuario y el email deben coincidir con el empleado agregado por el administrador')
      const employee = employeeByUsername
      if (employee.passwordHash || employee.passwordSalt) return error(res, 409, 'La cuenta ya está registrada. Iniciá sesión con tus credenciales')
      Object.assign(employee, { name, ...passwordRecord(password), updatedAt: new Date().toISOString() })
      await writeStore(store)
      const pendingApproval = employee.active !== true
      return send(res, 201, { pendingApproval, employee: publicEmployee(employee), message: pendingApproval ? 'Cuenta creada. Un administrador debe activar tu acceso antes de que puedas ingresar.' : 'Cuenta creada. Ya podés iniciar sesión con tus credenciales.' })
    }
    const created = { id: `request-${randomUUID()}`, name, username, email, createdAt: new Date().toISOString(), ...passwordRecord(password) }
    store.accessRequests.push(created)
    await writeStore(store)
    return send(res, 201, { pendingApproval: true, request: publicAccessRequest(created), message: 'Solicitud enviada. Un administrador debe agregar tu cuenta antes de que puedas ingresar.' })
  }
  if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'logout') {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    store.sessions = store.sessions.filter((session) => session.id !== tokenHash(token))
    await writeStore(store)
    return send(res, 200, { ok: true })
  }

  const actor = authenticate(req, store, now)
  if (!actor) return error(res, 401, 'Sesión requerida')

  if (req.method === 'GET' && parts[1] === 'auth' && parts[2] === 'me') return send(res, 200, { employee: publicEmployee(actor) })
  if (req.method === 'PUT' && parts[1] === 'auth' && parts[2] === 'me') {
    const name = String(body.name ?? actor.name).trim()
    const email = String(body.email ?? actor.email).trim().toLowerCase()
    const currentPassword = String(body.currentPassword || '')
    const password = String(body.password || '')
    const passwordConfirmation = String(body.passwordConfirmation || '')
    const nameChanged = name !== actor.name
    const emailChanged = email !== actor.email
    if (!name) return error(res, 400, 'El nombre es obligatorio')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, 'El email no es válido')
    if (store.employees.some((employee) => employee.id !== actor.id && employee.email?.toLowerCase() === email) || store.accessRequests.some((request) => request.email?.toLowerCase() === email)) return error(res, 409, 'El email ya existe')
    if (password || passwordConfirmation || currentPassword) {
      if (!password) return error(res, 400, 'La nueva contraseña es obligatoria')
      if (password.length < 8) return error(res, 400, 'La contraseña debe tener al menos 8 caracteres')
      if (password !== passwordConfirmation) return error(res, 400, 'Las contraseñas no coinciden')
      if (!verifyPassword(currentPassword, actor)) return error(res, 401, 'La contraseña actual es incorrecta')
      Object.assign(actor, passwordRecord(password))
      revokeSessions(store, actor.id, String(req.headers.authorization || '').replace(/^Bearer /, ''))
    }
    Object.assign(actor, { name, email, updatedAt: new Date().toISOString() })
    addAudit(store, actor, 'updated', 'profile', actor.id, { nameChanged, emailChanged, passwordChanged: Boolean(password), changedFields: [nameChanged && 'name', emailChanged && 'email', password && 'password'].filter(Boolean) })
    await writeStore(store)
    return send(res, 200, { employee: publicEmployee(actor) })
  }
  if (req.method === 'GET' && parts[1] === 'dashboard') return send(res, 200, { ...dashboard(store), companyName: store.settings.companyName })

  if (parts[1] === 'email-alerts') {
    if (!requireAdmin(res, actor)) return
    const config = emailConfig(store.settings)
    const mailer = context.mailer || createMailer()
    if (req.method === 'GET' && !parts[2]) return send(res, 200, { config, timezone: store.settings.timezone || 'America/Argentina/Buenos_Aires', smtp: mailer.status(), testRecipient: actor.email || '', preview: buildEmailReport(store, config) })
    if (req.method === 'PUT' && !parts[2]) {
      const next = validateEmailConfig(body, config)
      if (next.active && !mailer.status().configured) return error(res, 400, 'Configurá el servidor SMTP antes de activar los envíos')
      store.settings.emailAlerts = next
      addAudit(store, actor, 'updated', 'email_alerts', 'global', { active: next.active, recipients: next.recipients.length, frequency: next.triggerFrequency })
      await writeStore(store)
      return send(res, 200, { config: next })
    }
    if (req.method === 'POST' && parts[2] === 'preview') {
      const next = validateEmailConfig(body, config)
      return send(res, 200, buildEmailReport(store, next))
    }
    if (req.method === 'POST' && parts[2] === 'verify') {
      if (!mailer.status().configured) return error(res, 503, 'Configurá el servidor SMTP antes de verificar')
      try { await mailer.verify(); return send(res, 200, { message: 'Conexión SMTP verificada' }) } catch (caught) { logSmtpError('verificación', caught); return error(res, 502, smtpErrorMessage(caught)) }
    }
    if (req.method === 'POST' && parts[2] === 'test') {
      if (!mailer.status().configured) return error(res, 503, 'Configurá el servidor SMTP antes de enviar')
      // La prueba usa el asunto y el mensaje editados aunque todavía no se hayan guardado.
      const next = validateEmailConfig({ ...body, active: false }, config)
      const result = await sendTestEmail({ store, config: next, mailer, recipient: body.testRecipient ?? actor.email })
      addAudit(store, actor, 'sent_test', 'email_alerts', 'global', { recipient: result.recipient })
      await writeStore(store)
      return send(res, 200, { message: `Correo de prueba aceptado para ${result.recipient}`, ...result })
    }
    if (req.method === 'POST' && parts[2] === 'send') {
      const next = validateEmailConfig(body, config)
      if (!mailer.status().configured) return error(res, 503, 'Configurá el servidor SMTP antes de enviar')
      const result = await deliverEmail({ store, config: next, mailer, writeStore })
      addAudit(store, actor, 'sent', 'email_alerts', 'global', { status: result.lastStatus, recipients: next.recipients.length })
      await writeStore(store)
      return send(res, result.lastStatus === 'failed' ? 502 : 200, { config: result, ...(result.lastError ? { error: result.lastError } : {}) })
    }
  }

  if (parts[1] === 'repairs' && !parts[2]) {
    if (req.method === 'GET') return send(res, 200, { items: store.repairs.map((repair) => ({ ...repair, plate: store.vehicles.find((vehicle) => vehicle.id === repair.vehicleId)?.plate })).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt))) })
    if (req.method === 'POST') {
      if (!requireAdmin(res, actor)) return
      const repair = recordRepair(store, actor, body)
      await writeStore(store)
      return send(res, 201, repair)
    }
  }
  if (req.method === 'GET' && parts[1] === 'vehicles' && parts[2] && parts[3] === 'history' && !parts[4]) {
    const vehicle = store.vehicles.find((item) => item.id === parts[2])
    if (!vehicle) return error(res, 404, 'Vehículo no encontrado')
    return send(res, 200, { items: vehicleHistory(store, vehicle) })
  }

  if (req.method === 'GET' && parts[1] === 'vehicles' && !parts[2]) {
    const q = url.searchParams.get('q')?.toLowerCase() || ''
    const typeId = url.searchParams.get('typeId') || ''
    const status = url.searchParams.get('status') || ''
    const vehicles = store.vehicles.filter((vehicle) => (!q || `${vehicle.plate} ${vehicle.unit} ${vehicle.brand} ${vehicle.model}`.toLowerCase().includes(q)) && (!typeId || vehicle.typeId === typeId) && (!status || vehicle.status === status)).map((vehicle) => vehicleView(vehicle, store))
    return send(res, 200, { items: vehicles, total: vehicles.length })
  }
  if (req.method === 'POST' && parts[1] === 'vehicles' && !parts[2]) {
    const vehicle = validateVehicle(body, store)
    if (store.vehicleTypes.find((type) => type.id === vehicle.typeId)?.active === false) return error(res, 400, 'El tipo de vehículo está inactivo')
    if (store.vehicles.some((item) => item.plate === vehicle.plate)) return error(res, 409, 'La patente ya existe')
    const created = { id: `vh-${randomUUID()}`, ...vehicle, type: typeName(store, vehicle.typeId), createdAt: new Date().toISOString() }
    store.vehicles.push(created)
    addAudit(store, actor, 'created', 'vehicle', created.id, { plate: created.plate, unit: created.unit, typeId: created.typeId, brand: created.brand, model: created.model })
    await writeStore(store)
    return send(res, 201, vehicleView(created, store))
  }
  if (parts[1] === 'vehicles' && parts[2] && parts[3] === 'documents') {
    const vehicle = store.vehicles.find((item) => item.id === parts[2])
    if (!vehicle) return error(res, 404, 'Vehículo no encontrado')
    if (req.method === 'GET') return send(res, 200, { items: store.documents.filter((doc) => doc.vehicleId === vehicle.id).map((doc) => enrichDocument(doc, store)) })
    if (req.method === 'POST') {
      const document = validateDocument({ ...body, vehicleId: vehicle.id, active: true }, store)
      if (store.documentTypes.find((type) => type.id === document.typeId)?.active === false) return error(res, 400, 'El tipo de documento está inactivo')
      const id = `doc-${randomUUID()}`
      const created = { id, rootId: id, ...document, version: 1, createdAt: new Date().toISOString() }
      store.documents.push(created)
      addAudit(store, actor, 'created', 'document', created.id, { vehicleId: vehicle.id, typeId: created.typeId, number: created.number, expirationDate: created.expirationDate })
      await writeStore(store)
      return send(res, 201, enrichDocument(created, store))
    }
  }
  if (parts[1] === 'vehicles' && parts[2] && !parts[3]) {
    const index = store.vehicles.findIndex((item) => item.id === parts[2])
    if (index < 0) return error(res, 404, 'Vehículo no encontrado')
    if (req.method === 'GET') return send(res, 200, vehicleView(store.vehicles[index], store))
    if (req.method === 'PUT') {
      const vehicle = validateVehicle({ ...store.vehicles[index], ...body }, store)
      if (store.vehicles.some((item, itemIndex) => itemIndex !== index && item.plate === vehicle.plate)) return error(res, 409, 'La patente ya existe')
      const previous = store.vehicles[index]
      const changedFields = ['unit', 'plate', 'typeId', 'brand', 'model', 'year', 'status'].filter((field) => previous[field] !== vehicle[field])
      const previousValues = Object.fromEntries(changedFields.map((field) => [field, previous[field]]))
      const currentValues = Object.fromEntries(changedFields.map((field) => [field, vehicle[field]]))
      store.vehicles[index] = { ...store.vehicles[index], ...vehicle, type: typeName(store, vehicle.typeId), updatedAt: new Date().toISOString() }
      addAudit(store, actor, 'updated', 'vehicle', parts[2], { plate: vehicle.plate, changedFields, previousValues, currentValues })
      await writeStore(store)
      return send(res, 200, vehicleView(store.vehicles[index], store))
    }
    if (req.method === 'DELETE') {
      const previousStatus = store.vehicles[index].status
      store.vehicles[index].status = 'Baja'
      store.vehicles[index].updatedAt = new Date().toISOString()
      addAudit(store, actor, 'deactivated', 'vehicle', parts[2], { previousStatus, status: 'Baja' })
      await writeStore(store)
      return send(res, 200, vehicleView(store.vehicles[index], store))
    }
  }

  if (req.method === 'GET' && parts[1] === 'expirations') {
    const scope = parts[2] || ''
    return send(res, 200, { items: getExpirations(store, { q: url.searchParams.get('q'), status: url.searchParams.get('status'), documentTypeId: url.searchParams.get('documentTypeId'), scope, days: url.searchParams.get('days') }) })
  }
  if (req.method === 'GET' && parts[1] === 'calendar') return send(res, 200, { items: getExpirations(store, { q: url.searchParams.get('q') }) })

  if (parts[1] === 'documents' && parts[2] && parts[3] === 'renew' && req.method === 'POST') {
    const previous = store.documents.find((item) => item.id === parts[2])
    if (!previous) return error(res, 404, 'Documento no encontrado')
    if (previous.active === false || store.documents.some((item) => item.previousId === previous.id)) return error(res, 409, 'Este documento ya fue renovado o dado de baja. Actualizá la lista antes de continuar')
    if (body.typeId !== undefined && body.typeId !== previous.typeId) return error(res, 400, 'No se puede cambiar el tipo al renovar')
    if (body.vehicleId !== undefined && body.vehicleId !== previous.vehicleId) return error(res, 400, 'No se puede cambiar el vehículo al renovar')
    const document = validateDocument({ vehicleId: previous.vehicleId, typeId: body.typeId ?? previous.typeId, issueDate: body.issueDate ?? todayIso(new Date(), store.settings.timezone), expirationDate: body.expirationDate, number: body.number ?? previous.number, notes: body.notes ?? '', active: true }, store)
    if (store.documentTypes.find((type) => type.id === document.typeId)?.active === false) return error(res, 400, 'El tipo de documento está inactivo')
    previous.active = false
    const renewed = { ...document, id: `doc-${randomUUID()}`, rootId: previous.rootId || previous.id, version: (previous.version || 1) + 1, previousId: previous.id, createdAt: new Date().toISOString() }
    store.documents.push(renewed)
    addAudit(store, actor, 'renewed', 'document', renewed.id, { previousId: previous.id, previousExpirationDate: previous.expirationDate, expirationDate: renewed.expirationDate, number: renewed.number })
    await writeStore(store)
    return send(res, 201, enrichDocument(renewed, store))
  }
  if (parts[1] === 'documents' && parts[2] && parts[3] === 'file' && req.method === 'POST') {
    const document = store.documents.find((item) => item.id === parts[2])
    if (!document) return error(res, 404, 'Documento no encontrado')
    const filename = String(body.fileName || 'documento.bin').replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = join(uploadsDir, `${document.id}-${filename}`)
    if (!body.fileBase64) return error(res, 400, 'El archivo es obligatorio')
    const fileBuffer = Buffer.from(String(body.fileBase64).replace(/^data:[^;]+;base64,/, ''), 'base64')
    writeFileSync(filePath, fileBuffer)
    document.fileName = filename
    document.filePath = filePath
    document.mimeType = String(body.mimeType || 'application/octet-stream')
    document.sizeBytes = fileBuffer.length
    addAudit(store, actor, 'attached_file', 'document', document.id, { fileName: filename })
    await writeStore(store)
    return send(res, 200, enrichDocument(document, store))
  }
  if (parts[1] === 'documents' && parts[2] && !parts[3]) {
    const index = store.documents.findIndex((item) => item.id === parts[2])
    if (index < 0) return error(res, 404, 'Documento no encontrado')
    if (req.method === 'GET') return send(res, 200, enrichDocument(store.documents[index], store))
    if (req.method === 'PUT') {
      const previous = store.documents[index]
      if ((body.vehicleId !== undefined && body.vehicleId !== previous.vehicleId) || (body.typeId !== undefined && body.typeId !== previous.typeId)) return error(res, 400, 'El vehículo y el tipo de una versión documental no pueden cambiarse')
      const updated = validateDocument({ ...previous, ...body, vehicleId: previous.vehicleId, active: previous.active !== false }, store)
      const changedFields = ['typeId', 'number', 'issueDate', 'expirationDate', 'notes'].filter((field) => previous[field] !== updated[field])
      const previousValues = Object.fromEntries(changedFields.map((field) => [field, previous[field]]))
      const currentValues = Object.fromEntries(changedFields.map((field) => [field, updated[field]]))
      store.documents[index] = { ...previous, ...updated, updatedAt: new Date().toISOString() }
      addAudit(store, actor, 'updated', 'document', parts[2], { changedFields, previousValues, currentValues })
      await writeStore(store)
      return send(res, 200, enrichDocument(store.documents[index], store))
    }
    if (req.method === 'DELETE') {
      store.documents[index].active = false
      addAudit(store, actor, 'deactivated', 'document', parts[2], { previousStatus: 'Activo', status: 'Inactivo' })
      await writeStore(store)
      return send(res, 200, { ok: true })
    }
  }
  if (req.method === 'GET' && parts[1] === 'files' && parts[2]) {
    const document = store.documents.find((item) => item.id === parts[2])
    if (!document?.filePath || !existsSync(document.filePath)) return error(res, 404, 'Archivo no encontrado')
    res.writeHead(200, { 'Content-Type': document.mimeType || 'application/octet-stream', 'Content-Disposition': `inline; filename="${document.fileName}"` })
    return res.end(readFileSync(document.filePath))
  }

  if (req.method === 'GET' && parts[1] === 'vehicle-types') return send(res, 200, { items: store.vehicleTypes })
  if (req.method === 'POST' && parts[1] === 'vehicle-types') {
    if (!requireAdmin(res, actor)) return
    const name = String(body.name || '').trim()
    if (!name) return error(res, 400, 'El nombre es obligatorio')
    if (store.vehicleTypes.some((type) => type.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return error(res, 409, 'El tipo de vehículo ya existe')
    validateBooleans(body, ['active'])
    const created = { id: `vt-${randomUUID()}`, name, active: body.active ?? true, requiredDocumentTypeIds: requiredDocumentTypes(body, store) }
    store.vehicleTypes.push(created)
    addAudit(store, actor, 'created', 'vehicle_type', created.id, { name })
    await writeStore(store)
    return send(res, 201, created)
  }
  if (req.method === 'PUT' && parts[1] === 'vehicle-types' && parts[2]) {
    if (!requireAdmin(res, actor)) return
    const item = store.vehicleTypes.find((type) => type.id === parts[2])
    if (!item) return error(res, 404, 'Tipo no encontrado')
    const previousName = item.name
    const name = String(body.name ?? item.name).trim()
    if (!name) return error(res, 400, 'El nombre es obligatorio')
    if (store.vehicleTypes.some((type) => type.id !== item.id && type.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return error(res, 409, 'El tipo de vehículo ya existe')
    validateBooleans(body, ['active'])
    const requirements = requiredDocumentTypes(body, store, item.requiredDocumentTypeIds)
    item.name = name
    item.active = body.active ?? item.active
    item.requiredDocumentTypeIds = requirements
    addAudit(store, actor, 'updated', 'vehicle_type', item.id, { previousName, name: item.name })
    await writeStore(store)
    return send(res, 200, item)
  }
  if (req.method === 'DELETE' && parts[1] === 'vehicle-types' && parts[2]) {
    if (!requireAdmin(res, actor)) return
    const index = store.vehicleTypes.findIndex((type) => type.id === parts[2])
    if (index < 0) return error(res, 404, 'Tipo de vehículo no encontrado')
    if (store.vehicles.some((vehicle) => vehicle.typeId === parts[2])) return error(res, 409, 'No se puede eliminar un tipo de vehículo que está siendo utilizado')
    const [removed] = store.vehicleTypes.splice(index, 1)
    addAudit(store, actor, 'deleted', 'vehicle_type', removed.id, { name: removed.name })
    await writeStore(store)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'GET' && parts[1] === 'document-types') return send(res, 200, { items: store.documentTypes })
  if (req.method === 'POST' && parts[1] === 'document-types') {
    if (!requireAdmin(res, actor)) return
    const created = { id: `dt-${randomUUID()}`, ...validateDocumentType(body) }
    if (store.documentTypes.some((type) => type.name.trim().toLowerCase() === created.name.toLowerCase())) return error(res, 409, 'El tipo de documento ya existe')
    store.documentTypes.push(created)
    addAudit(store, actor, 'created', 'document_type', created.id, { name: created.name, description: created.description, alertDays: created.alertDays })
    await writeStore(store)
    return send(res, 201, created)
  }
  if (req.method === 'PUT' && parts[1] === 'document-types' && parts[2]) {
    if (!requireAdmin(res, actor)) return
    const item = store.documentTypes.find((type) => type.id === parts[2])
    if (!item) return error(res, 404, 'Tipo no encontrado')
    const previous = { name: item.name, description: item.description, alertDays: item.alertDays, requiresExpiration: item.requiresExpiration }
    const changes = validateDocumentType({ ...item, ...body })
    if (store.documentTypes.some((type) => type.id !== item.id && type.name.trim().toLowerCase() === changes.name.toLowerCase())) return error(res, 409, 'El tipo de documento ya existe')
    if (changes.requiresExpiration && !item.requiresExpiration && store.documents.some((doc) => doc.typeId === item.id && doc.active !== false && !doc.expirationDate)) return error(res, 409, 'Completá los vencimientos de los documentos activos antes de exigirlos')
    Object.assign(item, changes)
    addAudit(store, actor, 'updated', 'document_type', item.id, { previous, name: item.name, description: item.description, alertDays: item.alertDays, requiresExpiration: item.requiresExpiration })
    await writeStore(store)
    return send(res, 200, item)
  }
  if (req.method === 'DELETE' && parts[1] === 'document-types' && parts[2]) {
    if (!requireAdmin(res, actor)) return
    const index = store.documentTypes.findIndex((type) => type.id === parts[2])
    if (index < 0) return error(res, 404, 'Tipo de documento no encontrado')
    if (store.documents.some((document) => document.typeId === parts[2])) return error(res, 409, 'No se puede eliminar un tipo de documento que está siendo utilizado')
    if (store.vehicleTypes.some((type) => type.requiredDocumentTypeIds?.includes(parts[2]))) return error(res, 409, 'El tipo de documento es obligatorio para un tipo de vehículo')
    const [removed] = store.documentTypes.splice(index, 1)
    addAudit(store, actor, 'deleted', 'document_type', removed.id, { name: removed.name })
    await writeStore(store)
    return send(res, 200, { ok: true })
  }

  if (req.method === 'GET' && parts[1] === 'notifications') {
    const notifications = upsertNotifications(store)
    await writeStore(store)
    return send(res, 200, { items: notifications })
  }
  if (req.method === 'PUT' && parts[1] === 'notifications' && parts[2]) {
    validateBooleans(body, ['read'])
    const notification = store.notifications.find((item) => item.id === parts[2])
    if (!notification) return error(res, 404, 'Notificación no encontrada')
    notification.read = body.read !== false
    await writeStore(store)
    return send(res, 200, notification)
  }
  if (req.method === 'GET' && parts[1] === 'audit') {
    if (!requireAdmin(res, actor)) return
    return send(res, 200, { items: store.audit.map((item) => ({ ...item, description: describeAudit(item, store) })) })
  }

  if (parts[1] === 'parts') {
    if (!requireAdmin(res, actor)) return
    if (req.method === 'GET' && !parts[2]) {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
      const category = String(url.searchParams.get('category') || '').trim()
      const items = store.parts.filter((item) => {
        const matchesQ = !q || `${item.name} ${item.category || ''}`.toLowerCase().includes(q)
        const matchesCat = !category || category === 'Todas' || item.category === category
        return matchesQ && matchesCat
      })
      return send(res, 200, { items })
    }
    if (req.method === 'POST' && !parts[2]) {
      const name = String(body.name || '').trim()
      if (!name) return error(res, 400, 'El nombre del repuesto es obligatorio')
      const rawStock = body.stock !== undefined ? body.stock : body.quantity
      const parsedStock = integer(rawStock, 'La cantidad', 1)
      if (rawStock === undefined || !Number.isSafeInteger(parsedStock) || parsedStock <= 0 || parsedStock > 2147483647) {
        return error(res, 400, 'La cantidad debe ser un entero mayor a cero y no superar 2147483647')
      }
      if (body.minStock !== undefined) integer(body.minStock, 'El stock mínimo')
      const existing = store.parts.find((item) => item.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        const previousStock = Number(existing.stock || 0)
        const currentStock = previousStock + parsedStock
        if (currentStock > 2147483647) return error(res, 400, 'El stock resultante supera el máximo permitido')
        existing.stock = currentStock
        if (body.unit) existing.unit = String(body.unit).trim()
        if (body.category) existing.category = body.category === 'Encendido' ? 'Sistema eléctrico' : String(body.category).trim()
        existing.updatedAt = new Date().toISOString()
        addAudit(store, actor, 'stock_added', 'part', existing.id, {
          name: existing.name,
          addedQuantity: parsedStock,
          previousStock,
          currentStock,
          unit: existing.unit,
        })
        await writeStore(store)
        return send(res, 200, { item: existing, action: 'stock_added', addedQuantity: parsedStock, previousStock, currentStock })
      } else {
        const created = {
          id: `prt-${randomUUID()}`,
          name,
          stock: parsedStock,
          unit: String(body.unit || 'unidad').trim(),
          minStock: Number(body.minStock ?? 5),
          category: body.category === 'Encendido' ? 'Sistema eléctrico' : String(body.category || 'General').trim(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        store.parts.push(created)
        addAudit(store, actor, 'created', 'part', created.id, {
          name: created.name,
          stock: created.stock,
          unit: created.unit,
          category: created.category,
        })
        await writeStore(store)
        return send(res, 201, { item: created, action: 'created' })
      }
    }
    if (parts[2] && req.method === 'PUT') {
      const part = store.parts.find((item) => item.id === parts[2])
      if (!part) return error(res, 404, 'Repuesto no encontrado')
      integer(body.stock, 'El stock')
      if (body.stock === undefined || !Number.isSafeInteger(Number(body.stock)) || Number(body.stock) < 0 || Number(body.stock) > 2147483647) {
        return error(res, 400, 'El stock debe ser un entero entre cero y 2147483647')
      }
      if (body.minStock !== undefined) integer(body.minStock, 'El stock mínimo')
      const nextName = String(body.name ?? part.name).trim()
      if (!nextName) return error(res, 400, 'El nombre del repuesto es obligatorio')
      if (store.parts.some((item) => item.id !== part.id && item.name.toLowerCase() === nextName.toLowerCase())) return error(res, 409, 'El nombre del repuesto ya existe')
      const previousStock = Number(part.stock || 0)
      const currentStock = Number(body.stock)
      part.stock = currentStock
      part.name = nextName
      if (body.unit) part.unit = String(body.unit).trim()
      if (body.category) part.category = body.category === 'Encendido' ? 'Sistema eléctrico' : String(body.category).trim()
      if (body.minStock !== undefined) part.minStock = Number(body.minStock)
      part.updatedAt = new Date().toISOString()
      addAudit(store, actor, 'stock_modified', 'part', part.id, {
        name: part.name,
        previousStock,
        currentStock,
        unit: part.unit,
        reason: String(body.reason || '').trim(),
      })
      await writeStore(store)
      return send(res, 200, { item: part, action: 'stock_modified', previousStock, currentStock })
    }
    if (parts[2] && req.method === 'DELETE') {
      const index = store.parts.findIndex((item) => item.id === parts[2])
      if (index < 0) return error(res, 404, 'Repuesto no encontrado')
      const [removed] = store.parts.splice(index, 1)
      addAudit(store, actor, 'deleted', 'part', removed.id, { name: removed.name, stock: removed.stock, unit: removed.unit })
      await writeStore(store)
      return send(res, 200, { ok: true })
    }
  }

  if (req.method === 'GET' && parts[1] === 'settings') {
    if (!requireAdmin(res, actor)) return
    return send(res, 200, store.settings)
  }
  if (req.method === 'PUT' && parts[1] === 'settings') {
    if (!requireAdmin(res, actor)) return
    if (body.companyName !== undefined && (typeof body.companyName !== 'string' || !body.companyName.trim())) return error(res, 400, 'El nombre de empresa es obligatorio')
    if (body.timezone !== undefined) {
      try {
        if (typeof body.timezone !== 'string' || !body.timezone.trim()) throw new Error('Zona vacía')
        new Intl.DateTimeFormat('es-AR', { timeZone: body.timezone }).format(new Date())
      } catch { return error(res, 400, 'La zona horaria no es válida') }
    }
    const previousSettings = { ...store.settings }
    store.settings = validateSettings(body, store.settings)
    addAudit(store, actor, 'updated', 'settings', 'global', { changedFields: Object.keys(body), previousValues: previousSettings, currentValues: store.settings })
    await writeStore(store)
    return send(res, 200, store.settings)
  }

  if (req.method === 'GET' && parts[1] === 'employees') {
    if (!requireAdmin(res, actor)) return
    return send(res, 200, { items: store.employees.map(publicEmployee), pendingRequests: store.accessRequests.map(publicAccessRequest) })
  }
  if (req.method === 'POST' && parts[1] === 'employees') {
    if (!requireAdmin(res, actor)) return
    validateRole(body)
    if (body.password !== undefined && typeof body.password !== 'string') return error(res, 400, 'La contraseña no es válida')
    const password = String(body.password || '')
    const email = String(body.email || '').trim().toLowerCase()
    const username = String(body.username || '').trim().toLowerCase()
    const pendingByUsername = store.accessRequests.find((request) => request.username?.toLowerCase() === username)
    const pendingByEmail = store.accessRequests.find((request) => request.email?.toLowerCase() === email)
    if (!username || !email) return error(res, 400, 'Nombre de usuario y email son obligatorios')
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return error(res, 400, 'El nombre de usuario no es válido')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, 'El email no es válido')
    if (body.active !== undefined && typeof body.active !== 'boolean') return error(res, 400, 'El estado de acceso debe ser verdadero o falso')
    if (password && password.length < 8) return error(res, 400, 'La contraseña debe tener al menos 8 caracteres')
    if (pendingByUsername && pendingByUsername.email !== email) return error(res, 409, 'El email no coincide con la solicitud pendiente')
    if (pendingByEmail && pendingByEmail.username?.toLowerCase() !== username) return error(res, 409, 'El nombre de usuario no coincide con la solicitud pendiente')
    const pendingRequest = pendingByUsername || pendingByEmail
    const credentials = pendingRequest
      ? { passwordHash: pendingRequest.passwordHash, passwordSalt: pendingRequest.passwordSalt }
      // Sin contraseña configurada, el empleado debe completar su registro antes de iniciar sesión.
      : password ? passwordRecord(password) : { passwordHash: '', passwordSalt: '' }
    const created = { id: `emp-${randomUUID()}`, name: pendingRequest?.name || username, username, email, role: body.role === 'Administrador' ? 'Administrador' : 'Empleado', active: body.active === undefined ? true : body.active === true, createdAt: new Date().toISOString(), ...credentials }
    if (store.employees.some((employee) => employee.email?.toLowerCase() === created.email)) return error(res, 409, 'El email ya existe')
    if (store.employees.some((employee) => employee.username?.toLowerCase() === created.username)) return error(res, 409, 'El nombre de usuario ya existe')
    store.employees.push(created)
    if (pendingRequest) store.accessRequests = store.accessRequests.filter((request) => request.id !== pendingRequest.id)
    addAudit(store, actor, 'created', 'employee', created.id, { name: created.name, email: created.email, username: created.username, role: created.role })
    await writeStore(store)
    return send(res, 201, publicEmployee(created))
  }
  if (req.method === 'PUT' && parts[1] === 'employees' && parts[2]) {
    if (!requireAdmin(res, actor)) return
    const employee = store.employees.find((item) => item.id === parts[2])
    if (!employee) return error(res, 404, 'Empleado no encontrado')
    validateRole(body)
    if (body.password !== undefined && (typeof body.password !== 'string' || (body.password && body.password.length < 8))) return error(res, 400, 'La contraseña debe tener al menos 8 caracteres')
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return error(res, 400, 'El nombre es obligatorio')
    if (body.active !== undefined && typeof body.active !== 'boolean') return error(res, 400, 'El estado de acceso debe ser verdadero o falso')
    const nextActive = body.active === undefined ? employee.active : body.active === true
    const nextRole = body.role ?? employee.role
    if (isLastActiveAdmin(store, employee) && (!nextActive || nextRole !== 'Administrador')) return error(res, 409, 'Debe quedar al menos un administrador con acceso habilitado')
    if (employee.id === actor.id && !nextActive) return error(res, 400, 'No podés desactivar tu propio acceso')
    if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 8)) return error(res, 400, 'La contraseña debe tener al menos 8 caracteres')
    const previousActive = employee.active
    Object.assign(employee, { name: String(body.name ?? employee.name).trim() || employee.name, role: nextRole, active: nextActive, updatedAt: new Date().toISOString() })
    if (previousActive !== employee.active) addAudit(store, actor, employee.active ? 'access_enabled' : 'access_disabled', 'employee', employee.id, { name: employee.name, email: employee.email, username: employee.username, role: employee.role, active: employee.active })
    else if (body.name !== undefined || body.role !== undefined || body.password) addAudit(store, actor, 'updated', 'employee', employee.id, { name: employee.name, email: employee.email, username: employee.username, role: employee.role, active: employee.active })
    if (body.password) Object.assign(employee, passwordRecord(String(body.password)))
    if (body.password || employee.active !== true) revokeSessions(store, employee.id)
    await writeStore(store)
    return send(res, 200, publicEmployee(employee))
  }
  if (req.method === 'DELETE' && parts[1] === 'employees' && parts[2]) {
    if (!requireAdmin(res, actor)) return
    const index = store.employees.findIndex((employee) => employee.id === parts[2])
    if (index < 0) return error(res, 404, 'Empleado no encontrado')
    if (isLastActiveAdmin(store, store.employees[index])) return error(res, 409, 'Debe quedar al menos un administrador con acceso habilitado')
    if (parts[2] === actor.id) return error(res, 400, 'No podés eliminar tu propio acceso')
    const [removed] = store.employees.splice(index, 1)
    revokeSessions(store, removed.id)
    addAudit(store, actor, 'deleted', 'employee', removed.id, { name: removed.name, email: removed.email, username: removed.username, role: removed.role })
    await writeStore(store)
    return send(res, 200, { ok: true })
  }

  if (req.method === 'POST' && parts[1] === 'import' && parts[2] === 'vehicles') {
    if (!requireAdmin(res, actor)) return
    const rows = parseCsv(body.csv || body.raw)
    const requiredHeaders = [['patente', 'plate'], ['unidad', 'unit'], ['tipo', 'type'], ['marca', 'brand'], ['modelo', 'model']]
    const missingHeaders = requiredHeaders.filter((aliases) => !aliases.some((header) => rows.headers.includes(header))).map((aliases) => aliases[0])
    if (missingHeaders.length) return error(res, 400, `Faltan columnas obligatorias en el CSV: ${missingHeaders.join(', ')}`)
    if (!rows.length) return error(res, 400, 'El CSV debe incluir al menos una fila de vehículos')
    const created = []
    const errors = []
    rows.forEach((row) => {
      try {
        if (row.csvError) throw new ValidationError(row.csvError)
        const typeLabel = String(row.tipo || row.type || '').trim()
        const type = store.vehicleTypes.find((item) => item.name.toLowerCase() === typeLabel.toLowerCase())
        if (!type) throw new ValidationError(`Tipo de vehículo no reconocido: ${typeLabel || '(vacío)'}`)
        if (type.active === false) throw new ValidationError(`Tipo de vehículo inactivo: ${type.name}`)
        const vehicle = validateVehicle({ unit: row.unidad || row.unit, plate: row.patente || row.plate, typeId: type.id, brand: row.marca || row.brand, model: row.modelo || row.model, year: row.año || row.year, status: row.estado || row.status || 'Activo', chassis: row.chasis || row.chassis, engine: row.motor || row.engine, color: row.color, mileage: row.kilometraje || row.mileage, branch: row.sucursal || row.branch, driver: row.conductor || row.driver, notes: row.observaciones || row.notes }, store)
        if (store.vehicles.some((item) => item.plate === vehicle.plate)) throw new Error('Patente duplicada')
        const item = { id: `vh-${randomUUID()}`, ...vehicle, type: type.name, createdAt: new Date().toISOString() }
        store.vehicles.push(item)
        created.push(item)
      } catch (itemError) { errors.push({ row: row.csvLine ?? row.lineNumber, error: itemError.message }) }
    })
    addAudit(store, actor, 'imported', 'vehicles', 'bulk', { created: created.length, errors: errors.length })
    await writeStore(store)
    return send(res, 201, { created: created.length, errors })
  }
  if (req.method === 'GET' && parts[1] === 'export' && parts[2] === 'vehicles.csv') {
    return csvResponse(res, [['Patente', 'Unidad', 'Tipo', 'Marca', 'Modelo', 'Año', 'Estado', 'Chasis', 'Motor', 'Color', 'Kilometraje', 'Sucursal', 'Conductor', 'Observaciones'], ...store.vehicles.map((vehicle) => [vehicle.plate, vehicle.unit, typeName(store, vehicle.typeId), vehicle.brand, vehicle.model, vehicle.year, vehicle.status, vehicle.chassis, vehicle.engine, vehicle.color, vehicle.mileage, vehicle.branch, vehicle.driver, vehicle.notes])], 'vehiculos.csv')
  }
  if (req.method === 'GET' && parts[1] === 'export' && parts[2] === 'expirations.csv') {
    return csvResponse(res, [['Patente', 'Vehículo', 'Documento', 'Vencimiento', 'Días restantes', 'Estado'], ...getExpirations(store, {}).map((item) => [item.vehiclePlate, item.vehicleName, item.typeName, item.formattedExpirationDate, item.daysRemaining, item.status])], 'vencimientos.csv')
  }
  return error(res, 404, 'Ruta no encontrada')
}

export function createApiServer({ readStore: loadStore = readStore, writeStore: saveStore = writeStore, mailer = createMailer(), emailScheduler = false, now = Date.now, sessionTtlMs = 43200000, withTransaction = loadStore === readStore ? withStoreTransaction : (work) => work() } = {}) {
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) throw new Error('La duración de sesión debe ser un entero positivo')
  const context = { readStore: loadStore, writeStore: saveStore, mailer, now, sessionTtlMs }
  let mutations = Promise.resolve()
  async function dispatch(req, res) {
    // El preflight CORS no depende de la base: si MySQL falla, el navegador debe ver el error real y no uno de CORS.
    if (req.method === 'OPTIONS') return send(res, 204, '')
    const hasBody = ['POST', 'PUT', 'DELETE'].includes(req.method)
    const parts = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // GET notifications también guarda el estado al generar avisos.
    const mutates = hasBody || (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'notifications')
    const body = hasBody ? await readBody(req) : {}
    if (!mutates) return withTransaction(() => handle(req, res, context, body))
    // Cada escritura usa un estado actualizado: una solicitud demorada no puede revertir una baja de acceso.
    const response = mutations.then(() => withTransaction(() => handle(req, res, context, body)))
    mutations = response.catch(() => {})
    return response
  }
  const apiServer = createServer((req, res) => dispatch(req, res).catch((caught) => error(res, caught.statusCode || (caught instanceof SyntaxError || caught.message?.includes('obligatorio') || caught.message?.includes('válido') ? 400 : 500), caught.message || 'Error interno')))
  // El programador comparte la cola de escrituras de la API y nunca guarda una copia vieja.
  let scheduledPending = false
  const tick = () => {
    if (scheduledPending || !mailer.status().configured) return
    scheduledPending = true
    const run = mutations.then(() => withTransaction(() => runScheduledEmail({ readStore: loadStore, writeStore: saveStore, mailer })))
    mutations = run.catch((caught) => console.error(`No se pudo procesar la programación de emails: ${caught?.message || 'error desconocido'}. Revisá la conexión y que el esquema MySQL esté importado.`)).finally(() => { scheduledPending = false })
  }
  let timer
  if (emailScheduler) apiServer.on('listening', () => { tick(); timer = setInterval(tick, 30000); timer.unref() })
  apiServer.on('close', () => clearInterval(timer))
  return apiServer
}

const server = createApiServer({ emailScheduler: true })
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, () => console.log(`MyCarManagement API listening on http://localhost:${port}`))
}

export { handle, server }
