import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  date,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

const id = (name = 'id') => varchar(name, { length: 191 })
const shortText = (name) => varchar(name, { length: 255 })

const employeeRoleValues = [
  'ADMINISTRADOR',
  'EMPLEADO',
  'SUPERVISOR',
  'ADMINISTRATIVO',
  'TALLER',
  'CONSULTA',
]

const vehicleStatusValues = [
  'ACTIVO',
  'EN_MANTENIMIENTO',
  'FUERA_DE_SERVICIO',
  'VENDIDO',
  'BAJA',
]

export const employees = mysqlTable('employees', {
  id: id().primaryKey(),
  name: shortText('name').notNull(),
  username: shortText('username').notNull().unique(),
  email: shortText('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  role: mysqlEnum('role', employeeRoleValues).default('EMPLEADO').notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

export const accessRequests = mysqlTable('access_requests', {
  id: id().primaryKey(),
  name: shortText('name').notNull(),
  username: shortText('username').notNull().unique(),
  email: shortText('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const sessions = mysqlTable('sessions', {
  tokenHash: id('token_hash').primaryKey(),
  employeeId: id('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const vehicleTypes = mysqlTable('vehicle_types', {
  id: id().primaryKey(),
  name: shortText('name').notNull().unique(),
  active: boolean('active').default(true).notNull(),
  requiredDocumentTypeIds: json('required_document_type_ids').default([]).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

export const vehicles = mysqlTable('vehicles', {
  id: id().primaryKey(),
  plate: shortText('plate').notNull().unique(),
  unit: shortText('unit').notNull(),
  typeId: id('type_id').notNull().references(() => vehicleTypes.id),
  brand: shortText('brand').notNull(),
  model: shortText('model').notNull(),
  year: int('year'),
  chassis: shortText('chassis'),
  engine: shortText('engine'),
  color: shortText('color'),
  status: mysqlEnum('status', vehicleStatusValues).default('ACTIVO').notNull(),
  mileage: int('mileage').default(0).notNull(),
  branch: shortText('branch'),
  driver: shortText('driver'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

export const documentTypes = mysqlTable('document_types', {
  id: id().primaryKey(),
  name: shortText('name').notNull().unique(),
  description: text('description'),
  requiresExpiration: boolean('requires_expiration').default(true).notNull(),
  usualDurationDays: int('usual_duration_days'),
  alertDays: int('alert_days'),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

export const vehicleDocuments = mysqlTable('vehicle_documents', {
  id: id().primaryKey(),
  vehicleId: id('vehicle_id').notNull().references(() => vehicles.id),
  typeId: id('type_id').notNull().references(() => documentTypes.id),
  number: shortText('number'),
  issueDate: timestamp('issue_date', { mode: 'date' }),
  expirationDate: timestamp('expiration_date', { mode: 'date' }),
  observations: text('observations'),
  active: boolean('active').default(true).notNull(),
  version: int('version').default(1).notNull(),
  previousId: id('previous_id'),
  rootId: id('root_id').notNull(),
  // MySQL has no partial indexes. This generated key keeps
  // historical (inactive) versions reusable while allowing only one active
  // version for each document chain.
  activeRootKey: id('active_root_key').generatedAlwaysAs(sql`IF(active = 1, root_id, NULL)`, { mode: 'stored' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [uniqueIndex('vehicle_documents_active_root_unique').on(table.activeRootKey)])

export const documentFiles = mysqlTable('document_files', {
  id: id().primaryKey(),
  documentId: id('document_id').notNull().references(() => vehicleDocuments.id),
  fileName: shortText('file_name').notNull(),
  mimeType: shortText('mime_type').notNull(),
  storageKey: shortText('storage_key').notNull(),
  sizeBytes: int('size_bytes').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const notifications = mysqlTable('notifications', {
  id: id().primaryKey(),
  title: shortText('title').notNull(),
  description: text('description').notNull(),
  type: shortText('type').notNull(),
  read: boolean('read').default(false).notNull(),
  documentId: id('document_id'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const appSettings = mysqlTable('app_settings', {
  id: int('id').primaryKey().default(1),
  firstAlertDays: int('first_alert_days').default(30).notNull(),
  secondAlertDays: int('second_alert_days').default(15).notNull(),
  urgentDays: int('urgent_days').default(7).notNull(),
  companyName: shortText('company_name').default('MyCarManagement').notNull(),
  timezone: shortText('timezone').default('America/Argentina/Buenos_Aires').notNull(),
  emailAlerts: json('email_alerts').default({}).notNull(),
})

export const audits = mysqlTable('audits', {
  id: id().primaryKey(),
  employeeId: id('employee_id').references(() => employees.id, { onDelete: 'set null' }),
  employeeName: shortText('employee_name').notNull(),
  employeeEmail: shortText('employee_email'),
  action: shortText('action').notNull(),
  entity: shortText('entity').notNull(),
  entityId: id('entity_id').notNull(),
  data: json('data'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const parts = mysqlTable('parts', {
  id: id().primaryKey(),
  name: shortText('name').notNull().unique(),
  stock: int('stock').default(0).notNull(),
  unit: shortText('unit').default('unidad').notNull(),
  minStock: int('min_stock').default(5).notNull(),
  category: shortText('category').default('General').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

export const repairs = mysqlTable('vehicle_repairs', {
  id: id().primaryKey(),
  vehicleId: id('vehicle_id').notNull().references(() => vehicles.id),
  description: text('description').notNull(),
  date: date('date', { mode: 'string' }).notNull(),
  mileage: int('mileage'),
  notes: text('notes').default('').notNull(),
  parts: json('parts').notNull(),
  employeeId: id('employee_id').notNull(),
  employeeName: shortText('employee_name').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const employeesRelations = relations(employees, ({ many }) => ({
  audits: many(audits),
}))

export const vehicleTypesRelations = relations(vehicleTypes, ({ many }) => ({
  vehicles: many(vehicles),
}))

export const vehiclesRelations = relations(vehicles, ({ one, many }) => ({
  type: one(vehicleTypes, { fields: [vehicles.typeId], references: [vehicleTypes.id] }),
  documents: many(vehicleDocuments),
  repairs: many(repairs),
}))

export const repairsRelations = relations(repairs, ({ one }) => ({
  vehicle: one(vehicles, { fields: [repairs.vehicleId], references: [vehicles.id] }),
}))

export const documentTypesRelations = relations(documentTypes, ({ many }) => ({
  documents: many(vehicleDocuments),
}))

export const vehicleDocumentsRelations = relations(vehicleDocuments, ({ one, many }) => ({
  vehicle: one(vehicles, { fields: [vehicleDocuments.vehicleId], references: [vehicles.id] }),
  type: one(documentTypes, { fields: [vehicleDocuments.typeId], references: [documentTypes.id] }),
  files: many(documentFiles),
}))

export const documentFilesRelations = relations(documentFiles, ({ one }) => ({
  document: one(vehicleDocuments, { fields: [documentFiles.documentId], references: [vehicleDocuments.id] }),
}))

export const auditsRelations = relations(audits, ({ one }) => ({
  employee: one(employees, { fields: [audits.employeeId], references: [employees.id] }),
}))
