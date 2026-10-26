import { realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { addAudit } from './domain.js'
import { resolveStoredFilePath, uploadsDir } from './store.js'

function removeDocuments(store, ownerKey, ownerId) {
  const removed = store.documents.filter((document) => document[ownerKey] === ownerId)
  const ids = new Set(removed.map((document) => document.id))
  const notificationIds = new Set(removed.map((document) => `notification-${document.id}`))
  store.documents = store.documents.filter((document) => !ids.has(document.id))
  store.notifications = (store.notifications || []).filter((notification) => !ids.has(notification.documentId) && !notificationIds.has(notification.id))
  return removed
}

export function deletePerson(store, actor, person) {
  const removed = removeDocuments(store, 'personId', person.id)
  const assignedVehicleIds = []
  const name = `${person.firstName} ${person.lastName}`
  for (const vehicle of store.vehicles) {
    if (vehicle.personId !== person.id) continue
    assignedVehicleIds.push(vehicle.id)
    vehicle.personId = null
    vehicle.driver = ''
    vehicle.updatedAt = new Date().toISOString()
  }
  store.people = store.people.filter((item) => item.id !== person.id)
  addAudit(store, actor, 'deleted', 'person', person.id, { name, documentCount: removed.length, assignedVehicleIds })
  return removed
}

export function deleteVehicle(store, actor, vehicle) {
  const removed = removeDocuments(store, 'vehicleId', vehicle.id)
  const repairs = (store.repairs || []).filter((repair) => repair.vehicleId === vehicle.id)
  store.repairs = (store.repairs || []).filter((repair) => repair.vehicleId !== vehicle.id)
  store.vehicles = store.vehicles.filter((item) => item.id !== vehicle.id)
  addAudit(store, actor, 'deleted', 'vehicle', vehicle.id, { plate: vehicle.plate, unit: vehicle.unit, documentCount: removed.length, repairCount: repairs.length })
  return removed
}

// Se ejecuta después del commit. Un fallo al guardar nunca borra un archivo
// todavía referenciado; las rutas fuera de uploads y los adjuntos compartidos
// por documentos conservados tampoco se eliminan.
export function cleanupDeletedFiles(removed, remaining) {
  const retainedPaths = new Set(remaining.filter((document) => document.filePath).map((document) => {
    try { return realpathSync(resolveStoredFilePath(document.filePath)) } catch { return resolve(resolveStoredFilePath(document.filePath)) }
  }))
  const paths = new Set(removed.map((document) => document.filePath).filter(Boolean))
  for (const filePath of paths) {
    try {
      const path = resolveStoredFilePath(filePath)
      const realPath = realpathSync(path)
      const key = relative(realpathSync(uploadsDir), realPath)
      if (!key || key === '..' || key.startsWith(`..${sep}`) || isAbsolute(key) || retainedPaths.has(realPath)) continue
      unlinkSync(path)
    } catch (caught) {
      if (caught.code !== 'ENOENT') console.error(`No se pudo limpiar un adjunto eliminado: ${caught.message}`)
    }
  }
}
