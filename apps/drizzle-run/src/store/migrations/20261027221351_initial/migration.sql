-- Edited by hand: NOT NULL on the TEXT primary keys. Kit 1.0.0-rc.4 leaves it out, and SQLite then accepts NULL.
CREATE TABLE `cloud_sync` (
	`github_id` integer NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`digest` text NOT NULL,
	CONSTRAINT `cloud_sync_pk` PRIMARY KEY(`github_id`, `project_id`),
	CONSTRAINT "cloud_sync_github_id" CHECK("github_id" > 0),
	CONSTRAINT "cloud_sync_revision" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `project_preferences` (
	`project_id` text PRIMARY KEY NOT NULL,
	`selected_file` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`record_version` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer NOT NULL,
	`manifest` text NOT NULL,
	`origin` text,
	`trust` text NOT NULL,
	`source_kind` text,
	`source_id` text,
	CONSTRAINT "projects_revision" CHECK("revision" >= 0),
	CONSTRAINT "projects_origin" CHECK("origin" IN ('community')),
	CONSTRAINT "projects_trust" CHECK("trust" IN ('trusted', 'untrusted')),
	CONSTRAINT "projects_source_kind" CHECK("source_kind" IN ('example', 'guide')),
	CONSTRAINT "projects_source" CHECK(("source_kind" IS NULL) = ("source_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `share_links` (
	`project_id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`published_at` text NOT NULL,
	`description` text,
	`published_digest` text,
	`listing_topic` text,
	`listing_description` text
);
