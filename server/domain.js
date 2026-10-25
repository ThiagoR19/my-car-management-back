import { randomUUID } from 'node:crypto'

export const DAY = 24 * 60 * 60 * 1000
export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires'
const calendarFormatters = new Map()

function calendarFormatter(timezone = DEFAULT_TIMEZONE) {
  if (!calendarFormatters.has(timezone)) {
    try { calendarFormatters.set(timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })) }
    catch { return calendarFormatter(DEFAULT_TIMEZONE) }
  }
  return calendarFormatters.get(timezone)
}

export function todayIso(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(calendarFormatter(timezone).formatToParts(now).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function parseDate(value) {
  if (!value) return null
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const local = /^\d{2}\/\d{2}\/\d{4}$/.test(value)
  if (!iso && !local) return null
  const [year, month, day] = (iso ? value.split('-') : value.split('/').reverse()).map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

export function daysUntil(value, now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const target = parseDate(value)
  if (!target) return null
  const current = parseDate(todayIso(now, timezone))
  // Calendar dates have no time zone or DST offset.
  return (Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - Date.UTC(current.getFullYear(), current.getMonth(), current.getDate())) / DAY
}

export function expirationStatus(document, documentType, now = new Date(), settings = {}) {
  if (documentType?.requiresExpiration === false || !document.expirationDate) return { label: 'Sin vencimiento', tone: 'muted', daysRemaining: null, alertStage: 'none' }
  const daysRemaining = daysUntil(document.expirationDate, now, settings.timezone)
  if (daysRemaining === null) return { label: 'Fecha inválida', tone: 'danger', daysRemaining, alertStage: 'invalid' }
  const first = Number(documentType?.alertDays ?? settings.firstAlertDays ?? 30)
  const second = Math.min(Number(settings.secondAlertDays ?? 15), first)
  const urgent = Math.min(Number(settings.urgentDays ?? 7), second)
  if (daysRemaining < 0) return { label: 'Vencido', tone: 'danger', daysRemaining, alertStage: 'overdue' }
  if (daysRemaining <= urgent) return { label: 'Muy próximo', tone: 'danger', daysRemaining, alertStage: 'urgent' }
  if (daysRemaining <= second) return { label: 'Próximo', tone: 'danger', daysRemaining, alertStage: 'second' }
  if (daysRemaining <= first) return { label: 'Próximo', tone: 'warning', daysRemaining, alertStage: 'first' }
  const current = parseDate(todayIso(now, settings.timezone))
  const target = parseDate(document.expirationDate)
  const next = new Date(current.getFullYear(), current.getMonth() + 1, 1)
  if (target.getFullYear() === next.getFullYear() && target.getMonth() === next.getMonth()) return { label: 'Próximo mes', tone: 'info', daysRemaining, alertStage: 'none' }
  return { label: 'Vigente', tone: 'success', daysRemaining, alertStage: 'none' }
}

export function formatDate(value) {
  const date = parseDate(value)
  if (!date) return '—'
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function enrichDocument(document, store, now = new Date()) {
  const vehicle = store.vehicles.find((item) => item.id === document.vehicleId)
  const person = store.people?.find((item) => item.id === document.personId)
  const assignedPerson = store.people?.find((item) => item.id === vehicle?.personId)
  const personName = person ? `${person.firstName} ${person.lastName}` : ''
  const ownerType = document.personId ? 'person' : 'vehicle'
  const type = store.documentTypes.find((item) => item.id === document.typeId)
  const computed = expirationStatus(document, type, now, store.settings)
  return { ...document, typeName: type?.name ?? 'Otro', ownerType, personName, personIdentification: person ? `${person.identificationType} ${person.identificationNumber}` : '', ownerLabel: personName || vehicle?.plate || '—', vehiclePlate: vehicle?.plate ?? '—', vehicleUnit: vehicle?.unit ?? '', owner: personName || (assignedPerson ? `${assignedPerson.firstName} ${assignedPerson.lastName}` : vehicle?.driver) || 'Sin asignar', vehicleName: vehicle ? `${vehicle.brand} ${vehicle.model}` : '—', status: computed.label, statusTone: computed.tone, alertStage: computed.alertStage, daysRemaining: computed.daysRemaining, formattedExpirationDate: computed.daysRemaining === null ? '—' : formatDate(document.expirationDate) }
}

export function getExpirations(store, query = {}, now = new Date()) {
  const current = parseDate(todayIso(now, store.settings?.timezone))
  const rows = store.documents.filter((doc) => doc.active !== false && parseDate(doc.expirationDate)).map((doc) => enrichDocument(doc, store, now)).filter((doc) => {
    if (doc.daysRemaining === null) return false
    const vehicle = store.vehicles.find((item) => item.id === doc.vehicleId)
    const person = store.people?.find((item) => item.id === doc.personId)
    if (doc.personId ? !person || person.active === false : !vehicle || vehicle.status === 'Baja') return false
    if (query.vehicleId && doc.vehicleId !== query.vehicleId) return false
    if (query.personId && doc.personId !== query.personId) return false
    if (query.ownerType && doc.ownerType !== query.ownerType) return false
    if (query.status && doc.status !== query.status) return false
    if (query.documentTypeId && doc.typeId !== query.documentTypeId) return false
    const term = String(query.q ?? '').trim().toLowerCase()
    if (term && !`${vehicle?.plate || ''} ${vehicle?.unit || ''} ${vehicle?.brand || ''} ${vehicle?.model || ''} ${doc.personName} ${doc.personIdentification} ${doc.typeName}`.toLowerCase().includes(term)) return false
    if (query.scope === 'overdue' && doc.daysRemaining >= 0) return false
    if (query.scope === 'this-month' && !(parseDate(doc.expirationDate).getFullYear() === current.getFullYear() && parseDate(doc.expirationDate).getMonth() === current.getMonth())) return false
    if (query.scope === 'next-month') {
      const next = new Date(current.getFullYear(), current.getMonth() + 1, 1)
      if (!(parseDate(doc.expirationDate).getFullYear() === next.getFullYear() && parseDate(doc.expirationDate).getMonth() === next.getMonth())) return false
    }
    if (query.scope === 'upcoming' && (doc.daysRemaining < 0 || doc.daysRemaining > Number(query.days ?? 30))) return false
    return true
  })
  return rows.sort((a, b) => (a.daysRemaining ?? 99999) - (b.daysRemaining ?? 99999))
}

export function addAudit(store, actor, action, entity, entityId, data = {}) {
  store.audit.unshift({ id: `aud-${randomUUID()}`, employeeId: actor?.id ?? null, employeeName: actor?.name ?? 'Sistema', employeeEmail: actor?.email ?? null, action, entity, entityId, data, createdAt: new Date().toISOString() })
}

function auditSubject(item, store) {
  const data = item.data || {}
  if (item.entity === 'person') {
    const person = store.people?.find((candidate) => candidate.id === item.entityId)
    return `persona ${person ? `${person.firstName} ${person.lastName}` : data.name || item.entityId}`
  }
  if (item.entity === 'vehicle' || item.entity === 'vehicles') {
    const vehicle = store.vehicles.find((candidate) => candidate.id === item.entityId)
    if (vehicle) return `vehículo #${vehicle.unit} · ${vehicle.plate} · ${vehicle.brand} ${vehicle.model}`
    return data.plate ? `vehículo ${data.plate}` : 'vehículos'
  }
  if (item.entity === 'document') {
    const document = store.documents.find((candidate) => candidate.id === item.entityId)
    if (document) {
      const enriched = enrichDocument(document, store)
      return enriched.personId ? `${enriched.typeName} de ${enriched.personName}` : `${enriched.typeName} del vehículo ${enriched.vehiclePlate}`
    }
    return data.typeName || data.typeId || 'documento'
  }
  if (item.entity === 'vehicle_type') return `tipo de vehículo “${store.vehicleTypes.find((type) => type.id === item.entityId)?.name || data.name || item.entityId}”`
  if (item.entity === 'document_type') return `tipo de documento “${store.documentTypes.find((type) => type.id === item.entityId)?.name || data.name || item.entityId}”`
  if (item.entity === 'part' || item.entity === 'spare_part') {
    const part = (store.parts || []).find((candidate) => candidate.id === item.entityId)
    return `refacción “${part?.name || data.name || item.entityId}”`
  }
  if (item.entity === 'employee') return `empleado ${data.email || item.entityId}`
  if (item.entity === 'profile') return 'perfil de usuario'
  if (item.entity === 'settings') return 'configuración general'
  return item.entityId || item.entity || 'registro'
}

export function describeAudit(item, store) {
  const data = item.data || {}
  if (item.entity === 'repair') return `${item.employeeName || 'Sistema'} registró una reparación de ${data.plate}: ${data.description}`
  if (item.action === 'stock_consumed') return `${item.employeeName || 'Sistema'} utilizó ${data.quantity} ${data.unit} de ${data.name} en la reparación de ${data.plate} (${data.previousStock} → ${data.currentStock})`
  const subject = auditSubject(item, store)
  const expiration = data.expirationDate ? ` hasta el ${formatDate(data.expirationDate)}` : ''
  const actionText = {
    created: 'creó',
    updated: 'actualizó',
    renewed: 'renovó',
    deleted: 'eliminó',
    deactivated: 'dio de baja',
    access_enabled: 'habilitó el acceso a',
    access_disabled: 'deshabilitó el acceso a',
    attached_file: 'adjuntó un archivo a',
    stock_added: 'añadió stock a',
    stock_modified: 'modificó el stock de',
  }[item.action]
  if (item.entity === 'part' || item.entity === 'spare_part') {
    if (item.action === 'created') return `${item.employeeName || 'Sistema'} creó la refacción “${data.name || item.entityId}” con ${data.stock ?? 0} ${data.unit || 'unidades'}`
    if (item.action === 'stock_added') return `${item.employeeName || 'Sistema'} añadió stock a la refacción “${data.name || item.entityId}”: +${data.addedQuantity} ${data.unit || 'unidades'} (${data.previousStock} → ${data.currentStock})`
    if (item.action === 'stock_modified') return `${item.employeeName || 'Sistema'} modificó el stock de la refacción “${data.name || item.entityId}”: ${data.previousStock} → ${data.currentStock} ${data.unit || 'unidades'}`
    if (item.action === 'deleted') return `${item.employeeName || 'Sistema'} eliminó la refacción “${data.name || item.entityId}”`
  }
  if (item.entity === 'email_alerts') {
    const actor = item.employeeName || 'Sistema'
    if (item.action === 'sent') return `${actor} envió el informe de vencimientos a ${data.recipients ?? 0} destinatarios (${{ sent: 'aceptado', partial: 'aceptado parcialmente', failed: 'falló' }[data.status] || data.status})`
    if (item.action === 'sent_test') return `${actor} envió un correo de prueba a ${data.recipient}`
    return `${actor} actualizó la configuración de emails${data.active === undefined ? '' : ` (${data.active ? 'envíos activos' : 'envíos pausados'})`}`
  }
  if (item.action === 'imported') return `${item.employeeName || 'Sistema'} importó ${data.created || 0} vehículos${data.errors ? ` (${data.errors} con errores)` : ''}`
  if (item.action === 'updated' && item.entity === 'settings') {
    const fields = data.changedFields?.map((field) => ({ firstAlertDays: 'primera alerta', secondAlertDays: 'segunda alerta', urgentDays: 'días urgentes', companyName: 'nombre de empresa', timezone: 'zona horaria' }[field] || field)) || []
    return `${item.employeeName || 'Sistema'} actualizó la configuración general${fields.length ? `: ${fields.join(', ')}` : ''}`
  }
  if (item.action === 'updated' && item.entity === 'profile') {
    const fields = [data.nameChanged && 'nombre', data.emailChanged && 'email', data.passwordChanged && 'contraseña'].filter(Boolean)
    return `${item.employeeName || 'Sistema'} actualizó ${subject}${fields.length ? `: ${fields.join(', ')}` : ''}`
  }
  if (item.action === 'updated' && data.changedFields?.length) {
    const fieldLabels = { unit: 'unidad', plate: 'patente', typeId: 'tipo', brand: 'marca', model: 'modelo', year: 'año', status: 'estado', number: 'número', issueDate: 'fecha de emisión', expirationDate: 'fecha de vencimiento', notes: 'observaciones', personId: 'persona asignada', firstName: 'nombre', lastName: 'apellido', identificationType: 'tipo de identificación', identificationNumber: 'número de identificación', birthDate: 'fecha de nacimiento', email: 'email', phone: 'teléfono', address: 'domicilio', city: 'localidad', province: 'provincia', nationality: 'nacionalidad', active: 'estado' }
    const fields = data.changedFields.map((field) => fieldLabels[field] || field).join(', ')
    return `${item.employeeName || 'Sistema'} actualizó ${subject}: ${fields}`
  }
  if (item.action === 'updated' && item.entity === 'vehicle_type') {
    const detail = data.previousName && data.name && data.previousName !== data.name ? `: nombre de “${data.previousName}” a “${data.name}”` : ''
    return `${item.employeeName || 'Sistema'} actualizó ${subject}${detail}`
  }
  if (item.action === 'updated' && item.entity === 'document_type') {
    const previous = data.previous || {}
    const changed = ['name', 'description', 'alertDays', 'requiresExpiration'].filter((field) => previous[field] !== undefined && data[field] !== undefined && previous[field] !== data[field])
    const labels = { name: 'nombre', description: 'descripción', alertDays: 'días de alerta', requiresExpiration: 'requiere vencimiento' }
    return `${item.employeeName || 'Sistema'} actualizó ${subject}${changed.length ? `: ${changed.map((field) => labels[field]).join(', ')}` : ''}`
  }
  if (item.action === 'renewed') return `${item.employeeName || 'Sistema'} renovó ${subject}${expiration}`
  if (item.action === 'attached_file') return `${item.employeeName || 'Sistema'} adjuntó “${data.fileName || 'un archivo'}” a ${subject}`
  if (actionText) return `${item.employeeName || 'Sistema'} ${actionText} ${subject}`
  return `${item.employeeName || 'Sistema'} realizó una acción sobre ${subject}`
}

export function isVehicleDocumentationIncomplete(vehicle, store) {
  const documents = store.documents.filter((doc) => doc.vehicleId === vehicle.id && doc.active !== false)
  const required = store.vehicleTypes?.find((type) => type.id === vehicle.typeId)?.requiredDocumentTypeIds || []
  return !documents.length || required.some((typeId) => !documents.some((doc) => doc.typeId === typeId)) || documents.some((doc) => store.documentTypes.find((type) => type.id === doc.typeId)?.requiresExpiration !== false && !parseDate(doc.expirationDate))
}

export function dashboard(store, now = new Date()) {
  const expirations = getExpirations(store, {}, now)
  const activeVehicles = store.vehicles.filter((vehicle) => vehicle.status === 'Activo')
  const incompleteVehicles = activeVehicles.filter((vehicle) => isVehicleDocumentationIncomplete(vehicle, store))
  const requestedTimezone = store.settings?.timezone || DEFAULT_TIMEZONE
  calendarFormatter(requestedTimezone)
  const timezone = calendarFormatters.has(requestedTimezone) ? requestedTimezone : DEFAULT_TIMEZONE
  const today = todayIso(now, timezone)
  return {
    generatedAt: now.toISOString(), today, timezone,
    firstAlertDays: Number(store.settings?.firstAlertDays ?? 30),
    secondAlertDays: Number(store.settings?.secondAlertDays ?? 15),
    urgentDays: Number(store.settings?.urgentDays ?? 7),
    activeVehicles: activeVehicles.length,
    totalVehicles: store.vehicles.filter((vehicle) => vehicle.status !== 'Baja').length,
    overdueDocuments: expirations.filter((item) => item.status === 'Vencido').length,
    overdueVehicleCount: new Set(expirations.filter((item) => item.status === 'Vencido' && item.vehicleId).map((item) => item.vehicleId)).size,
    activePeople: (store.people || []).filter((person) => person.active !== false).length,
    overduePersonCount: new Set(expirations.filter((item) => item.status === 'Vencido' && item.personId).map((item) => item.personId)).size,
    urgentDocuments: expirations.filter((item) => item.status === 'Muy próximo').length,
    thisMonth: getExpirations(store, { scope: 'this-month' }, now).length,
    nextMonth: getExpirations(store, { scope: 'next-month' }, now).length,
    incompleteVehicles: incompleteVehicles.length,
    incompleteVehicleIds: incompleteVehicles.map((vehicle) => vehicle.id),
    upcoming: expirations.slice(0, 10),
    byVehicleType: store.vehicleTypes.map((type) => ({ ...type, count: store.vehicles.filter((vehicle) => vehicle.typeId === type.id && vehicle.status === 'Activo').length })).filter((type) => type.count > 0),
  }
}
