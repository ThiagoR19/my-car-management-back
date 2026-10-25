-- MyCarManagement - esquema MySQL para importar desde phpMyAdmin
-- Crear o seleccionar primero la base de datos destino.

SET NAMES utf8mb4;
SET default_storage_engine = InnoDB;

CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (
  `id` serial PRIMARY KEY,
  `hash` text NOT NULL,
  `created_at` bigint
);
INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES ('bb2446c6ccfda5982aae86f18cfbe1989ec3978ad28fb86f660f8c3c17ad829e', 1792800337921);

CREATE TABLE `access_requests` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`username` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `access_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `access_requests_username_unique` UNIQUE(`username`),
	CONSTRAINT `access_requests_email_unique` UNIQUE(`email`)
);

CREATE TABLE `app_settings` (
	`id` int NOT NULL DEFAULT 1,
	`first_alert_days` int NOT NULL DEFAULT 30,
	`second_alert_days` int NOT NULL DEFAULT 15,
	`urgent_days` int NOT NULL DEFAULT 7,
	`company_name` varchar(255) NOT NULL DEFAULT 'MyCarManagement',
	`timezone` varchar(255) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
	`email_alerts` json NOT NULL DEFAULT ('{}'),
	CONSTRAINT `app_settings_id` PRIMARY KEY(`id`)
);

CREATE TABLE `audits` (
	`id` varchar(191) NOT NULL,
	`employee_id` varchar(191),
	`employee_name` varchar(255) NOT NULL,
	`employee_email` varchar(255),
	`action` varchar(255) NOT NULL,
	`entity` varchar(255) NOT NULL,
	`entity_id` varchar(191) NOT NULL,
	`data` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audits_id` PRIMARY KEY(`id`)
);

CREATE TABLE `document_files` (
	`id` varchar(191) NOT NULL,
	`document_id` varchar(191) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`size_bytes` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `document_files_id` PRIMARY KEY(`id`)
);

CREATE TABLE `document_types` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`requires_expiration` boolean NOT NULL DEFAULT true,
	`usual_duration_days` int,
	`alert_days` int,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `document_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `document_types_name_unique` UNIQUE(`name`)
);

CREATE TABLE `employees` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`username` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`role` enum('ADMINISTRADOR','EMPLEADO','SUPERVISOR','ADMINISTRATIVO','TALLER','CONSULTA') NOT NULL DEFAULT 'EMPLEADO',
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `employees_id` PRIMARY KEY(`id`),
	CONSTRAINT `employees_username_unique` UNIQUE(`username`),
	CONSTRAINT `employees_email_unique` UNIQUE(`email`)
);

CREATE TABLE `notifications` (
	`id` varchar(191) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`type` varchar(255) NOT NULL,
	`read` boolean NOT NULL DEFAULT false,
	`document_id` varchar(191),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);

CREATE TABLE `parts` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`stock` int NOT NULL DEFAULT 0,
	`unit` varchar(255) NOT NULL DEFAULT 'unidad',
	`min_stock` int NOT NULL DEFAULT 5,
	`category` varchar(255) NOT NULL DEFAULT 'General',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `parts_id` PRIMARY KEY(`id`),
	CONSTRAINT `parts_name_unique` UNIQUE(`name`)
);

CREATE TABLE `vehicle_repairs` (
	`id` varchar(191) NOT NULL,
	`vehicle_id` varchar(191) NOT NULL,
	`description` text NOT NULL,
	`date` date NOT NULL,
	`mileage` int,
	`notes` text NOT NULL DEFAULT (''),
	`parts` json NOT NULL,
	`employee_id` varchar(191) NOT NULL,
	`employee_name` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vehicle_repairs_id` PRIMARY KEY(`id`)
);

CREATE TABLE `sessions` (
	`token_hash` varchar(191) NOT NULL,
	`employee_id` varchar(191) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sessions_token_hash` PRIMARY KEY(`token_hash`)
);

CREATE TABLE `vehicle_documents` (
	`id` varchar(191) NOT NULL,
	`vehicle_id` varchar(191) NOT NULL,
	`type_id` varchar(191) NOT NULL,
	`number` varchar(255),
	`issue_date` timestamp,
	`expiration_date` timestamp,
	`observations` text,
	`active` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`previous_id` varchar(191),
	`root_id` varchar(191) NOT NULL,
	`active_root_key` varchar(191) GENERATED ALWAYS AS (IF(active = 1, root_id, NULL)) STORED,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vehicle_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `vehicle_documents_active_root_unique` UNIQUE(`active_root_key`)
);

CREATE TABLE `vehicle_types` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`required_document_type_ids` json NOT NULL DEFAULT ('[]'),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vehicle_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `vehicle_types_name_unique` UNIQUE(`name`)
);

CREATE TABLE `vehicles` (
	`id` varchar(191) NOT NULL,
	`plate` varchar(255) NOT NULL,
	`unit` varchar(255) NOT NULL,
	`type_id` varchar(191) NOT NULL,
	`brand` varchar(255) NOT NULL,
	`model` varchar(255) NOT NULL,
	`year` int,
	`chassis` varchar(255),
	`engine` varchar(255),
	`color` varchar(255),
	`status` enum('ACTIVO','EN_MANTENIMIENTO','FUERA_DE_SERVICIO','VENDIDO','BAJA') NOT NULL DEFAULT 'ACTIVO',
	`mileage` int NOT NULL DEFAULT 0,
	`branch` varchar(255),
	`driver` varchar(255),
	`notes` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vehicles_id` PRIMARY KEY(`id`),
	CONSTRAINT `vehicles_plate_unique` UNIQUE(`plate`)
);

ALTER TABLE `audits` ADD CONSTRAINT `audits_employee_id_employees_id_fk` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE set null ON UPDATE no action;
ALTER TABLE `document_files` ADD CONSTRAINT `document_files_document_id_vehicle_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `vehicle_documents`(`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `vehicle_repairs` ADD CONSTRAINT `vehicle_repairs_vehicle_id_vehicles_id_fk` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_employee_id_employees_id_fk` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `vehicle_documents` ADD CONSTRAINT `vehicle_documents_vehicle_id_vehicles_id_fk` FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `vehicle_documents` ADD CONSTRAINT `vehicle_documents_type_id_document_types_id_fk` FOREIGN KEY (`type_id`) REFERENCES `document_types`(`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `vehicles` ADD CONSTRAINT `vehicles_type_id_vehicle_types_id_fk` FOREIGN KEY (`type_id`) REFERENCES `vehicle_types`(`id`) ON DELETE no action ON UPDATE no action;



-- Personas y documentaciÃ³n personal
CREATE TABLE IF NOT EXISTS `people` (
  `id` varchar(191) NOT NULL,
  `first_name` varchar(255) NOT NULL,
  `last_name` varchar(255) NOT NULL,
  `identification_type` varchar(255) NOT NULL DEFAULT 'DNI',
  `identification_number` varchar(255) NOT NULL,
  `birth_date` date,
  `email` varchar(255),
  `phone` varchar(255),
  `address` varchar(255),
  `city` varchar(255),
  `province` varchar(255),
  `nationality` varchar(255),
  `notes` text,
  `active` boolean NOT NULL DEFAULT true,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `people_id` PRIMARY KEY (`id`),
  CONSTRAINT `people_identification_unique` UNIQUE (`identification_type`, `identification_number`)
);
CREATE TABLE IF NOT EXISTS `person_documents` (
	`id` varchar(191) NOT NULL,
	`person_id` varchar(191) NOT NULL,
	`type_id` varchar(191) NOT NULL,
	`number` varchar(255),
	`issue_date` timestamp,
	`expiration_date` timestamp,
	`observations` text,
	`active` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`previous_id` varchar(191),
	`root_id` varchar(191) NOT NULL,
	`active_root_key` varchar(191) GENERATED ALWAYS AS (IF(active = 1, root_id, NULL)) STORED,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `person_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `person_documents_active_root_unique` UNIQUE(`active_root_key`)
);
CREATE TABLE IF NOT EXISTS `person_document_files` (
	`id` varchar(191) NOT NULL,
	`document_id` varchar(191) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`size_bytes` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `person_document_files_id` PRIMARY KEY(`id`)
);
ALTER TABLE `person_documents` ADD CONSTRAINT `person_documents_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people` (`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `person_documents` ADD CONSTRAINT `person_documents_type_id_document_types_id_fk` FOREIGN KEY (`type_id`) REFERENCES `document_types` (`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `person_document_files` ADD CONSTRAINT `person_document_files_document_id_person_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `person_documents` (`id`) ON DELETE no action ON UPDATE no action;
ALTER TABLE `vehicles` ADD COLUMN `person_id` varchar(191) NULL, ADD CONSTRAINT `vehicles_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people` (`id`) ON DELETE set null ON UPDATE no action;

INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES ('8e999b0e80e5b9ea7a55e99db61e1aff0a62e764da20f0a69cda466a2bdef8f3', 1792886737921);
