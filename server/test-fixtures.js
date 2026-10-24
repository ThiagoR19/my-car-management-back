// Datos exclusivos de pruebas; la API nunca importa este módulo.
import { passwordRecord } from './store.js'
const iso = (date) => new Date(date).toISOString()
export function seedDatabase() {
  const adminPassword = passwordRecord('admin1234')
  const managerPassword = passwordRecord('manager1234')
  const vehicleTypes = [
    { id: 'vt-truck', name: 'Camión', active: true },
    { id: 'vt-trailer', name: 'Semirremolque', active: true },
    { id: 'vt-pickup', name: 'Camioneta', active: true },
    { id: 'vt-utility', name: 'Utilitario', active: true },
    { id: 'vt-tractor', name: 'Tractor', active: true },
  ]
  const documentTypes = [
    { id: 'dt-rto', name: 'RTO', description: 'Revisión Técnica Obligatoria', requiresExpiration: true, alertDays: 30, active: true },
    { id: 'dt-insurance', name: 'Seguro', description: 'Póliza de seguro vigente', requiresExpiration: true, alertDays: 15, active: true },
    { id: 'dt-fire', name: 'Matafuego', description: 'Control y recarga del matafuego', requiresExpiration: true, alertDays: 30, active: true },
    { id: 'dt-permit', name: 'Habilitación', description: 'Habilitación de transporte', requiresExpiration: true, alertDays: 30, active: true },
    { id: 'dt-card', name: 'Cédula', description: 'Cédula de identificación del vehículo', requiresExpiration: false, alertDays: 0, active: true },
  ]
  const vehicles = [
    { id: 'vh-1', unit: '24', plate: 'AB123CD', typeId: 'vt-truck', type: 'Camión', brand: 'Mercedes-Benz', model: 'Atego', year: 2021, chassis: '9BM958164MB123456', engine: 'OM926LA-123456', color: 'Blanco', status: 'Activo', mileage: 184320, branch: 'Buenos Aires', driver: 'Juan Pérez', notes: '', createdAt: iso('2026-01-12') },
    { id: 'vh-2', unit: '31', plate: 'AE456FG', typeId: 'vt-truck', type: 'Camión', brand: 'Iveco', model: 'Tector', year: 2020, chassis: '8ATA1C2B3D4E56789', engine: 'F4AE0681D-456789', color: 'Azul', status: 'Activo', mileage: 226540, branch: 'Buenos Aires', driver: 'Juan Pérez', notes: '', createdAt: iso('2026-01-15') },
    { id: 'vh-3', unit: '08', plate: 'AC987XY', typeId: 'vt-trailer', type: 'Semirremolque', brand: 'Randon', model: 'SR 3E', year: 2019, chassis: '9RACSR3E19XY12345', engine: '', color: 'Gris', status: 'Activo', mileage: 0, branch: 'Rosario', driver: 'Ana García', notes: '', createdAt: iso('2026-02-02') },
    { id: 'vh-4', unit: '15', plate: 'AA321BB', typeId: 'vt-pickup', type: 'Camioneta', brand: 'Toyota', model: 'Hilux', year: 2022, chassis: '8AJHA3CD5N1234567', engine: '2GD-FTV-321654', color: 'Gris', status: 'En mantenimiento', mileage: 72800, branch: 'Buenos Aires', driver: 'María López', notes: 'En taller por service preventivo.', createdAt: iso('2026-02-16') },
    { id: 'vh-5', unit: '19', plate: 'AD654EF', typeId: 'vt-truck', type: 'Camión', brand: 'Scania', model: 'P 250', year: 2021, chassis: 'YS2P4X20001234567', engine: 'DC09-987654', color: 'Rojo', status: 'Activo', mileage: 164200, branch: 'Córdoba', driver: 'Ana García', notes: '', createdAt: iso('2026-02-20') },
    { id: 'vh-6', unit: '42', plate: 'AF789GH', typeId: 'vt-utility', type: 'Utilitario', brand: 'Renault', model: 'Master', year: 2018, chassis: 'VF1MA000123456789', engine: 'M9T-456123', color: 'Blanco', status: 'Fuera de servicio', mileage: 289400, branch: 'Rosario', driver: '', notes: 'A la espera de baja administrativa.', createdAt: iso('2026-03-03') },
  ]
  const documents = [
    { id: 'doc-1', vehicleId: 'vh-1', typeId: 'dt-rto', number: 'RTO-2026-00124', issueDate: '2026-01-12', expirationDate: '2026-10-12', notes: '', active: true, version: 1 },
    { id: 'doc-2', vehicleId: 'vh-1', typeId: 'dt-insurance', number: 'POL-88421', issueDate: '2026-03-01', expirationDate: '2027-03-04', notes: '', active: true, version: 1 },
    { id: 'doc-3', vehicleId: 'vh-1', typeId: 'dt-fire', number: 'MF-0024', issueDate: '2026-01-10', expirationDate: '2027-01-04', notes: '', active: true, version: 1 },
    { id: 'doc-4', vehicleId: 'vh-2', typeId: 'dt-rto', number: 'RTO-2026-00456', issueDate: '2026-01-10', expirationDate: '2027-02-12', notes: '', active: true, version: 1 },
    { id: 'doc-5', vehicleId: 'vh-2', typeId: 'dt-insurance', number: 'POL-77310', issueDate: '2026-02-15', expirationDate: '2026-10-15', notes: '', active: true, version: 1 },
    { id: 'doc-6', vehicleId: 'vh-2', typeId: 'dt-fire', number: 'MF-0031', issueDate: '2026-01-10', expirationDate: '2027-01-10', notes: '', active: true, version: 1 },
    { id: 'doc-7', vehicleId: 'vh-2', typeId: 'dt-permit', number: 'HAB-456', issueDate: '2026-01-20', expirationDate: '2026-12-20', notes: '', active: true, version: 1 },
    { id: 'doc-8', vehicleId: 'vh-3', typeId: 'dt-rto', number: 'RTO-2026-00987', issueDate: '2026-02-02', expirationDate: '2026-11-01', notes: '', active: true, version: 1 },
    { id: 'doc-9', vehicleId: 'vh-3', typeId: 'dt-fire', number: 'MF-0008', issueDate: '2026-02-01', expirationDate: '2027-02-01', notes: '', active: true, version: 1 },
    { id: 'doc-10', vehicleId: 'vh-4', typeId: 'dt-rto', number: 'RTO-2025-00321', issueDate: '2025-10-01', expirationDate: '2027-04-10', notes: '', active: true, version: 1 },
    { id: 'doc-11', vehicleId: 'vh-4', typeId: 'dt-insurance', number: 'POL-99211', issueDate: '2025-10-01', expirationDate: '2026-10-02', notes: 'Renovar con la aseguradora.', active: true, version: 1 },
    { id: 'doc-12', vehicleId: 'vh-4', typeId: 'dt-fire', number: 'MF-0015', issueDate: '2025-01-10', expirationDate: '2026-10-14', notes: '', active: true, version: 1 },
    { id: 'doc-13', vehicleId: 'vh-4', typeId: 'dt-card', number: 'CED-321', issueDate: '2022-05-01', expirationDate: null, notes: '', active: true, version: 1 },
    { id: 'doc-14', vehicleId: 'vh-5', typeId: 'dt-rto', number: 'RTO-2026-00654', issueDate: '2026-02-20', expirationDate: '2027-01-20', notes: '', active: true, version: 1 },
    { id: 'doc-15', vehicleId: 'vh-5', typeId: 'dt-insurance', number: 'POL-99123', issueDate: '2026-01-22', expirationDate: '2027-01-22', notes: '', active: true, version: 1 },
    { id: 'doc-16', vehicleId: 'vh-5', typeId: 'dt-permit', number: 'HAB-654', issueDate: '2026-01-22', expirationDate: '2026-10-22', notes: '', active: true, version: 1 },
    { id: 'doc-17', vehicleId: 'vh-6', typeId: 'dt-rto', number: 'RTO-2026-00789', issueDate: '2026-02-28', expirationDate: '2026-10-28', notes: '', active: true, version: 1 },
  ]
  const parts = [
    { id: 'prt-1', name: 'Aceite Sintético 5W-30', stock: 24, unit: 'unidad', minStock: 10, category: 'Lubricantes', createdAt: iso('2026-01-10'), updatedAt: iso('2026-01-10') },
    { id: 'prt-2', name: 'Bujías de encendido', stock: 12, unit: 'packs', minStock: 6, category: 'Sistema eléctrico', createdAt: iso('2026-01-12'), updatedAt: iso('2026-01-12') },
    { id: 'prt-3', name: 'Filtro de aceite', stock: 18, unit: 'unidad', minStock: 8, category: 'Filtros', createdAt: iso('2026-01-15'), updatedAt: iso('2026-01-15') },
    { id: 'prt-4', name: 'Pastillas de freno', stock: 8, unit: 'packs', minStock: 4, category: 'Frenos', createdAt: iso('2026-02-01'), updatedAt: iso('2026-02-01') },
    { id: 'prt-5', name: 'Filtro de aire', stock: 15, unit: 'unidad', minStock: 5, category: 'Filtros', createdAt: iso('2026-02-10'), updatedAt: iso('2026-02-10') },
    { id: 'prt-6', name: 'Líquido de frenos DOT 4', stock: 6, unit: 'unidad', minStock: 5, category: 'Fluidos', createdAt: iso('2026-02-15'), updatedAt: iso('2026-02-15') },
  ]
  return {
    employees: [
      { id: 'emp-admin', name: 'Juan Pérez', username: 'admin', email: 'admin@fleet.local', role: 'Administrador', active: true, createdAt: iso('2026-01-01'), ...adminPassword },
      { id: 'emp-manager', name: 'Ana García', username: 'ana', email: 'ana@fleet.local', role: 'Empleado', active: true, createdAt: iso('2026-01-10'), ...managerPassword },
    ],
    accessRequests: [],
    vehicleTypes,
    documentTypes,
    vehicles,
    documents,
    parts,
    repairs: [],
    audit: [],
    notifications: [],
    settings: { firstAlertDays: 30, secondAlertDays: 15, urgentDays: 7, companyName: 'MyCarManagement', timezone: 'America/Argentina/Buenos_Aires' },
  }
}

