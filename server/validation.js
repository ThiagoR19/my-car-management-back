import { parseDate, todayIso } from './domain.js'

export class ValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

export function invalid(message, statusCode = 400) {
  throw new ValidationError(message, statusCode)
}

export function integer(value, field, min = 0, max = 2147483647) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) invalid(`${field} debe ser un entero entre ${min} y ${max}`)
  return Number(value)
}

export function validateBooleans(input, fields) {
  for (const field of fields) if (input[field] !== undefined && typeof input[field] !== 'boolean') invalid(`${field} debe ser verdadero o falso`)
}

export function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} es obligatorio`)
  return value.trim()
}

export function nonNegativeInteger(value, field) {
  return integer(value, field)
}

const vehicleStatuses = ['Activo', 'En mantenimiento', 'Fuera de servicio', 'Vendido', 'Baja']

export function validateVehicle(input, store, previous = null) {
  const vehicle = {
    unit: requiredString(String(input.unit ?? ''), 'La unidad'),
    plate: requiredString(String(input.plate ?? '').toUpperCase(), 'La patente'),
    typeId: requiredString(String(input.typeId ?? ''), 'El tipo de vehículo'),
    brand: requiredString(String(input.brand ?? ''), 'La marca'),
    model: requiredString(String(input.model ?? ''), 'El modelo'),
    year: input.year === '' || input.year == null ? null : integer(input.year, 'El año', 1900, new Date().getFullYear() + 1),
    chassis: String(input.chassis ?? '').trim(),
    engine: String(input.engine ?? '').trim(),
    color: String(input.color ?? '').trim(),
    status: input.status === undefined ? 'Activo' : input.status,
    mileage: integer(input.mileage ?? 0, 'El kilometraje'),
    branch: String(input.branch ?? '').trim(),
    driver: String(input.driver ?? '').trim(),
    personId: input.personId ? requiredString(input.personId, 'El empleado asignado') : null,
    notes: String(input.notes ?? '').trim(),
  }
  if (!vehicleStatuses.includes(vehicle.status)) invalid('El estado del vehículo no es válido')
  if (store && !store.vehicleTypes.some((type) => type.id === vehicle.typeId)) invalid('El tipo de vehículo no es válido')
  if (vehicle.personId && store) {
    const person = store.people?.find((item) => item.id === vehicle.personId)
    if (!person) invalid('El empleado asignado no existe')
    if (person.active === false && previous?.personId !== person.id) invalid('El empleado asignado está inactivo')
  }
  return vehicle
}

export function validatePerson(input) {
  validateBooleans(input, ['active'])
  const person = {
    firstName: requiredString(input.firstName, 'El nombre'),
    lastName: requiredString(input.lastName, 'El apellido'),
    identificationType: requiredString(input.identificationType ?? 'DNI', 'El tipo de identificación').toUpperCase(),
    identificationNumber: requiredString(input.identificationNumber, 'El número de identificación').toUpperCase(),
    birthDate: documentDate(input.birthDate, 'La fecha de nacimiento'),
    email: String(input.email ?? '').trim().toLowerCase(),
    phone: String(input.phone ?? '').trim(),
    address: String(input.address ?? '').trim(),
    city: String(input.city ?? '').trim(),
    province: String(input.province ?? '').trim(),
    nationality: String(input.nationality ?? '').trim(),
    notes: String(input.notes ?? '').trim(),
    active: input.active ?? true,
  }
  for (const field of ['firstName', 'lastName', 'identificationType', 'identificationNumber', 'email', 'phone', 'address', 'city', 'province', 'nationality']) {
    if (person[field].length > 255) invalid('Los datos del empleado no pueden superar los 255 caracteres por campo')
  }
  if (person.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email)) invalid('El email no es válido')
  if (person.birthDate && person.birthDate > todayIso()) invalid('La fecha de nacimiento no puede ser futura')
  return person
}

function documentDate(value, field) {
  if (value === '' || value === null || value === undefined) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseDate(value)) invalid(`${field} no es válida; usá el formato AAAA-MM-DD`)
  return value
}

export function validateDocument(input, storeOrType) {
  if (input.personId && input.vehicleId) invalid('El documento debe pertenecer a un empleado o a un vehículo')
  const document = {
    ...(input.personId ? { personId: requiredString(input.personId, 'El empleado') } : { vehicleId: requiredString(String(input.vehicleId ?? ''), 'El vehículo') }),
    typeId: requiredString(String(input.typeId ?? ''), 'El tipo de documento'),
    number: String(input.number ?? '').trim(),
    issueDate: documentDate(input.issueDate, 'La fecha de emisión'),
    expirationDate: documentDate(input.expirationDate, 'La fecha de vencimiento'),
    notes: String(input.notes ?? '').trim(),
    active: input.active !== false,
  }
  const store = Array.isArray(storeOrType?.documentTypes) ? storeOrType : null
  const type = store ? store.documentTypes.find((item) => item.id === document.typeId) : storeOrType
  if (storeOrType && (!type || type.id !== document.typeId)) invalid('El tipo de documento no es válido')
  if (store && document.personId && !store.people?.some((person) => person.id === document.personId)) invalid('El empleado no es válido')
  if (store && document.vehicleId && !store.vehicles.some((vehicle) => vehicle.id === document.vehicleId)) invalid('El vehículo no es válido')
  if (type?.requiresExpiration === false) document.expirationDate = null
  else if (type && !document.expirationDate) invalid('La fecha de vencimiento es obligatoria para este tipo de documento')
  if (document.issueDate && document.expirationDate && document.issueDate > document.expirationDate) invalid('La fecha de emisión no puede ser posterior al vencimiento')
  return document
}

export function validateDocumentType(input) {
  validateBooleans(input, ['requiresExpiration', 'active'])
  return {
    name: requiredString(input.name, 'El nombre'),
    description: String(input.description ?? '').trim(),
    requiresExpiration: input.requiresExpiration ?? true,
    active: input.active ?? true,
    alertDays: input.alertDays == null ? null : integer(input.alertDays, 'Los días de alerta', 0, 3650),
    usualDurationDays: input.usualDurationDays == null || input.usualDurationDays === '' ? null : integer(input.usualDurationDays, 'La duración habitual', 1, 36500),
  }
}

export function parseCsv(csv) {
  const text = String(csv ?? '').replace(/^\uFEFF/, '')
  const records = []
  let cells = []
  let cell = ''
  let quoted = false
  let closedQuote = false
  let line = 1
  let recordLine = 1
  const finishCell = () => { cells.push(closedQuote ? cell : cell.trim()); cell = ''; closedQuote = false }
  const finishRecord = () => {
    finishCell()
    if (cells.some((value) => value !== '')) records.push({ cells, line: recordLine })
    cells = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1 }
        else { quoted = false; closedQuote = true }
      } else {
        cell += char
        if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) line += 1
      }
    } else if (char === '"') {
      if (cell.trim() || closedQuote) invalid(`CSV inválido: comillas inesperadas en la fila ${line}`)
      cell = ''
      quoted = true
    } else if (char === ',') finishCell()
    else if (char === '\r' || char === '\n') {
      finishRecord()
      if (char === '\r' && text[index + 1] === '\n') index += 1
      line += 1
      recordLine = line
    } else if (closedQuote) {
      if (!/\s/.test(char)) invalid(`CSV inválido: contenido después de comillas en la fila ${line}`)
    } else cell += char
  }
  if (quoted) invalid(`CSV con comillas sin cerrar en la fila ${recordLine}`)
  if (cell || closedQuote || cells.length) finishRecord()
  if (!records.length) invalid('El CSV está vacío')
  const headers = records.shift().cells.map((value) => value.trim().toLowerCase())
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) invalid('CSV inválido: los encabezados no pueden estar vacíos o repetidos')
  if (!headers.includes('patente') && !headers.includes('plate')) invalid('El CSV debe incluir Patente')
  const rows = records.map((record) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, record.cells[index] ?? '']))
    Object.defineProperties(row, {
      lineNumber: { value: record.line },
      csvLine: { value: record.line },
      csvError: { value: record.cells.length !== headers.length ? 'La cantidad de columnas no coincide con el encabezado' : null },
    })
    return row
  })
  Object.defineProperty(rows, 'headers', { value: headers })
  return rows
}

export function csvEscape(value) {
  const raw = String(value ?? '')
  // Prevent spreadsheet formula execution when an exported field starts with
  // a dangerous formula character, including after whitespace/control chars.
  const text = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function validateSettings(input, current = {}) {
  const settings = { firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7, companyName: 'MyCarManagement', timezone: 'America/Argentina/Buenos_Aires', ...current }
  for (const field of ['firstAlertDays', 'secondAlertDays', 'urgentDays']) {
    if (input[field] !== undefined) settings[field] = integer(input[field], 'Los días de alerta', 0, 3650)
  }
  if (settings.firstAlertDays < settings.secondAlertDays || settings.secondAlertDays < settings.urgentDays) invalid('La primera alerta debe ser mayor o igual a la segunda y la segunda mayor o igual a los días urgentes')
  if (input.companyName !== undefined) settings.companyName = requiredString(input.companyName, 'El nombre de empresa')
  if (input.timezone !== undefined) {
    const timezone = requiredString(input.timezone, 'La zona horaria')
    try { new Intl.DateTimeFormat('es-AR', { timeZone: timezone }).format() } catch { invalid('La zona horaria no es válida') }
    settings.timezone = timezone
  }
  return settings
}
