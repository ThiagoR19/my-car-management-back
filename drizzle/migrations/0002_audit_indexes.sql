CREATE INDEX `audits_created_at_id_idx` ON `audits` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `audits_entity_entity_id_idx` ON `audits` (`entity`,`entity_id`);
