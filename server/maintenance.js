import { randomUUID } from 'node:crypto'
import { addAudit, describeAudit } from './domain.js'

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400 })
}

export function recordRepair(store, actor, input) {
  const vehicle = store.vehicles.find((item) => item.id === input.vehicleId)
  if (!vehicle) invalid('Seleccioná un vehículo válido')
  if (['Baja', 'Vendido'].includes(vehicle.status)) invalid('El vehículo ya no está disponible para reparaciones')
  const description = String(input.description || '').trim()
  if (!description) invalid('La descripción de la reparación es obligatoria')
  const date = String(input.date || '')
  const parsedDate = new Date(`${date}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) invalid('La fecha de reparación no es válida')
  const mileage = input.mileage === '' || input.mileage == null ? null : Number(input.mileage)
  if (mileage !== null && (!Number.isSafeInteger(mileage) || mileage < 0 || mileage > 2147483647)) invalid('El kilometraje no es válido')
  if (!Array.isArray(input.parts) || !input.parts.length) invalid('Agregá al menos un repuesto a la reparación')

  // Agrupar antes de validar evita consumir dos veces el mismo stock disponible.
  const quantities = new Map()
  for (const item of input.parts) {
    if (!item || typeof item.partId !== 'string' || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) invalid('Las cantidades de repuestos deben ser enteros mayores a cero')
    const quantity = (quantities.get(item.partId) || 0) + item.quantity
    if (!Number.isSafeInteger(quantity)) invalid('La cantidad de repuestos no es válida')
    quantities.set(item.partId, quantity)
  }
  const usedParts = [...quantities].map(([partId, quantity]) => {
    const part = store.parts.find((item) => item.id === partId)
    if (!part) invalid('Uno de los repuestos seleccionados ya no existe')
    if (quantity > part.stock) invalid(`Stock insuficiente de ${part.name}: disponibles ${part.stock} ${part.unit}`)
    return { partId, name: part.name, unit: part.unit, quantity, previousStock: part.stock, currentStock: part.stock - quantity }
  })

  // Ningún dato cambia hasta que todos los repuestos hayan sido validados.
  const createdAt = new Date().toISOString()
  const repair = { id: `rep-${randomUUID()}`, vehicleId: vehicle.id, description, date, mileage, notes: String(input.notes || '').trim(), parts: usedParts, employeeId: actor.id, employeeName: actor.name, createdAt }
  store.repairs ||= []
  store.repairs.push(repair)
  for (const used of usedParts) {
    Object.assign(store.parts.find((item) => item.id === used.partId), { stock: used.currentStock, updatedAt: createdAt })
    addAudit(store, actor, 'stock_consumed', 'part', used.partId, { ...used, vehicleId: vehicle.id, plate: vehicle.plate, repairId: repair.id })
  }
  if (mileage !== null && mileage > vehicle.mileage) Object.assign(vehicle, { mileage, updatedAt: createdAt })
  addAudit(store, actor, 'created', 'repair', repair.id, { vehicleId: vehicle.id, plate: vehicle.plate, description, date, parts: usedParts })
  return repair
}

export function vehicleHistory(store, vehicle) {
  const documents = store.documents.filter((item) => item.vehicleId === vehicle.id)
  const documentIds = new Set(documents.map((item) => item.id))
  const items = store.audit.filter((item) => (item.entity === 'vehicle' && item.entityId === vehicle.id) || (item.entity === 'document' && (documentIds.has(item.entityId) || item.data?.vehicleId === vehicle.id))).map((item) => ({ ...item, kind: item.entity, description: describeAudit(item, store) }))
  if (!items.some((item) => item.entity === 'vehicle' && item.action === 'created')) {
    items.push({ id: `registered-${vehicle.id}`, kind: 'vehicle', description: `Alta del vehículo ${vehicle.plate}`, createdAt: vehicle.createdAt })
  }
  for (const document of documents) {
    if (items.some((item) => item.entityId === document.id && ['created', 'renewed'].includes(item.action))) continue
    const type = store.documentTypes.find((item) => item.id === document.typeId)
    items.push({ id: `registered-${document.id}`, kind: 'document', description: `${document.previousId ? 'Renovación' : 'Carga'} de ${type?.name || 'documento'}${document.number ? ` · ${document.number}` : ''}`, createdAt: document.createdAt || document.issueDate || vehicle.createdAt })
  }
  for (const repair of store.repairs || []) {
    if (repair.vehicleId === vehicle.id) items.push({ id: repair.id, kind: 'repair', description: repair.description, date: repair.date, createdAt: repair.createdAt, employeeName: repair.employeeName, mileage: repair.mileage, notes: repair.notes, parts: repair.parts })
  }
  const eventTime = (item) => {
    const value = item.date || item.createdAt
    return value ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).getTime() || 0 : 0
  }
  return items.sort((a, b) => eventTime(b) - eventTime(a) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}
