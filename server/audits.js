import { listAudits, listVehicleAudits } from './store.js'
import { auditBoundary, compareHistoryKeys, historyKey, isAfterHistoryKey } from './maintenance.js'

export const AUDIT_PAGE_SIZE = 30
export const AUDIT_MAX_PAGE_SIZE = 100

// Las descripciones del historial se arman en castellano al responder, así que la búsqueda
// también reconoce estas etiquetas y las traduce a las acciones y entidades guardadas.
const entityLabels = {
  vehicle: 'vehículo unidad', vehicles: 'vehículos importación', document: 'documento documentación', vehicle_type: 'tipo de vehículo',
  document_type: 'tipo de documento', employee: 'usuario acceso', profile: 'perfil', settings: 'configuración general', part: 'refacción repuesto stock',
  spare_part: 'refacción repuesto stock', repair: 'reparación taller', person: 'empleado persona', email_alerts: 'emails correo informe',
}
const actionLabels = {
  created: 'creó alta registró', updated: 'actualizó modificó', renewed: 'renovó renovación', deleted: 'eliminó', deactivated: 'dio de baja',
  access_enabled: 'habilitó acceso', access_disabled: 'deshabilitó acceso', attached_file: 'adjuntó archivo', stock_added: 'añadió stock',
  stock_modified: 'modificó stock', stock_consumed: 'utilizó consumió', imported: 'importó', sent: 'envió informe', sent_test: 'correo de prueba',
}
const normalize = (value) => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const matchingKeys = (labels, search) => Object.entries(labels).filter(([, label]) => normalize(label).includes(search)).map(([key]) => key)

export function auditQuery(searchParams) {
  const integerParam = (name, fallback) => {
    const value = Number(searchParams.get(name))
    return Number.isSafeInteger(value) && value > 0 ? value : fallback
  }
  const search = String(searchParams.get('q') || '').trim().slice(0, 100)
  const normalized = normalize(search)
  return {
    page: integerParam('page', 1),
    pageSize: Math.min(AUDIT_MAX_PAGE_SIZE, integerParam('pageSize', AUDIT_PAGE_SIZE)),
    search,
    entities: normalized ? matchingKeys(entityLabels, normalized) : [],
    actions: normalized ? matchingKeys(actionLabels, normalized) : [],
  }
}

// Producción consulta MySQL; los stores en memoria de las pruebas filtran store.audit con las mismas reglas.
export const databaseAudits = {
  list: (_store, query) => listAudits(query),
  // Pide un evento más que el límite para saber si quedan páginas.
  forVehicle: (_store, vehicle, documentIds, { cursor, limit }) => listVehicleAudits(vehicle.id, documentIds, { before: auditBoundary(cursor), limit: limit + 1 }),
}

export const memoryAudits = {
  async list(store, { page = 1, pageSize = AUDIT_PAGE_SIZE, search = '', entities = [], actions = [] } = {}) {
    const needle = normalize(search)
    const items = (store.audit || []).filter((item) => !needle || entities.includes(item.entity) || actions.includes(item.action) || normalize([item.employeeName, item.employeeEmail, item.action, item.entity, item.entityId, JSON.stringify(item.data ?? null)].join(' ')).includes(needle))
    const size = Math.min(AUDIT_MAX_PAGE_SIZE, Math.max(1, pageSize))
    const totalPages = Math.max(1, Math.ceil(items.length / size))
    const current = Math.min(totalPages, Math.max(1, page))
    return { items: items.slice((current - 1) * size, current * size), total: items.length, page: current, pageSize: size, totalPages }
  },
  async forVehicle(store, vehicle, documentIds, { cursor, limit }) {
    const ids = new Set(documentIds)
    const scoped = (store.audit || []).filter((item) => (item.entity === 'vehicle' && item.entityId === vehicle.id) || (item.entity === 'document' && ids.has(item.entityId)))
    const covered = scoped.filter((item) => (item.entity === 'vehicle' && item.action === 'created') || (item.entity === 'document' && ['created', 'renewed'].includes(item.action))).map((item) => `${item.entity}:${item.entityId}`)
    const items = scoped.filter((item) => isAfterHistoryKey(cursor, historyKey(item))).sort((a, b) => compareHistoryKeys(historyKey(a), historyKey(b))).slice(0, limit + 1)
    return { items, total: scoped.length, covered: [...new Set(covered)] }
  },
}
