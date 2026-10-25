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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE `person_documents` ADD CONSTRAINT `person_documents_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people` (`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `person_documents` ADD CONSTRAINT `person_documents_type_id_document_types_id_fk` FOREIGN KEY (`type_id`) REFERENCES `document_types` (`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `person_document_files` ADD CONSTRAINT `person_document_files_document_id_person_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `person_documents` (`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `vehicles` ADD COLUMN `person_id` varchar(191) NULL, ADD CONSTRAINT `vehicles_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people` (`id`) ON DELETE set null ON UPDATE no action;
