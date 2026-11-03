-- Edited by hand: NOT NULL on the TEXT primary keys. Kit 1.0.0-rc.5 leaves it out, and SQLite then accepts NULL.
CREATE TABLE `cloud_projects` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`content_digest` text NOT NULL,
	`byte_size` integer NOT NULL,
	`object_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `cloud_projects_pk` PRIMARY KEY(`user_id`, `project_id`),
	CONSTRAINT `fk_cloud_projects_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "cloud_projects_revision" CHECK("revision" > 0),
	CONSTRAINT "cloud_projects_content_digest" CHECK(length("content_digest") = 64 AND "content_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "cloud_projects_byte_size" CHECK("byte_size" BETWEEN 1 AND 1048576),
	CONSTRAINT "cloud_projects_name" CHECK(length("name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE `community_listings` (
	`link_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`topic` text NOT NULL,
	`dialect` text NOT NULL,
	`orm_version` text NOT NULL,
	`kit_version` text NOT NULL,
	`guest_flavor` text NOT NULL,
	`second_dialect` text,
	`second_orm_version` text,
	`second_kit_version` text,
	`second_guest_flavor` text,
	`side_name` text,
	`second_side_name` text,
	`file_names` text NOT NULL,
	`listed_at` text NOT NULL,
	`report_count` integer DEFAULT 0 NOT NULL,
	`last_reported_at` text,
	CONSTRAINT `fk_community_listings_link_id_playground_links_id_fk` FOREIGN KEY (`link_id`) REFERENCES `playground_links`(`id`),
	CONSTRAINT `fk_community_listings_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "community_listings_state" CHECK("state" IN ('listed', 'unlisted', 'removed')),
	CONSTRAINT "community_listings_title" CHECK(length("title") BETWEEN 1 AND 160),
	CONSTRAINT "community_listings_description" CHECK("description" IS NULL OR length("description") BETWEEN 1 AND 140),
	CONSTRAINT "community_listings_topic" CHECK("topic" IN ('playground', 'bug-repros')),
	CONSTRAINT "community_listings_dialect" CHECK("dialect" IN ('postgresql', 'sqlite')),
	CONSTRAINT "community_listings_second_dialect" CHECK("second_dialect" IS NULL OR "second_dialect" IN ('postgresql', 'sqlite')),
	CONSTRAINT "community_listings_guest_flavor" CHECK("guest_flavor" IN ('slim', 'effect')),
	CONSTRAINT "community_listings_second_guest_flavor" CHECK("second_guest_flavor" IS NULL OR "second_guest_flavor" IN ('slim', 'effect')),
	CONSTRAINT "community_listings_side_name" CHECK("side_name" IS NULL OR length("side_name") BETWEEN 1 AND 40),
	CONSTRAINT "community_listings_second_side_name" CHECK("second_side_name" IS NULL OR length("second_side_name") BETWEEN 1 AND 40),
	CONSTRAINT "community_listings_file_names" CHECK(json_valid("file_names") AND json_type("file_names") = 'array'),
	CONSTRAINT "community_listings_report_count" CHECK("report_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `playground_links` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`snapshot_version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`content_digest` text NOT NULL,
	`description` text,
	`summary_json` text NOT NULL,
	`idempotency_key` text NOT NULL UNIQUE,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_playground_links_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "playground_links_snapshot_version" CHECK("snapshot_version" > 0),
	CONSTRAINT "playground_links_payload_json" CHECK(length(CAST("payload_json" AS BLOB)) <= 1048576),
	CONSTRAINT "playground_links_content_digest" CHECK(length("content_digest") = 64 AND "content_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "playground_links_description" CHECK("description" IS NULL OR length("description") BETWEEN 1 AND 140)
);
--> statement-breakpoint
CREATE TABLE `publish_storage` (
	`scope` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	CONSTRAINT "publish_storage_bytes" CHECK("bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `recorded_runs` (
	`link_id` text PRIMARY KEY NOT NULL,
	`snapshot_digest` text NOT NULL,
	`payload_json` text NOT NULL,
	`recorded_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_recorded_runs_link_id_playground_links_id_fk` FOREIGN KEY (`link_id`) REFERENCES `playground_links`(`id`),
	CONSTRAINT "recorded_runs_snapshot_digest" CHECK(length("snapshot_digest") = 64 AND "snapshot_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "recorded_runs_payload_json" CHECK(length(CAST("payload_json" AS BLOB)) <= 262144)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "sessions_token_hash" CHECK(length("token_hash") = 64 AND "token_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL UNIQUE,
	`login` text NOT NULL,
	`name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "users_github_id" CHECK("github_id" > 0),
	CONSTRAINT "users_login" CHECK(length("login") BETWEEN 1 AND 39),
	CONSTRAINT "users_name" CHECK("name" IS NULL OR length("name") <= 255)
);
--> statement-breakpoint
CREATE INDEX `community_listings_visible` ON `community_listings` (`listed_at`,`link_id`) WHERE "community_listings"."state" = 'listed';--> statement-breakpoint
CREATE INDEX `community_listings_reported` ON `community_listings` (`report_count`,`last_reported_at`) WHERE "community_listings"."report_count" > 0 AND "community_listings"."state" <> 'removed';--> statement-breakpoint
CREATE INDEX `playground_links_owner_created` ON `playground_links` (`owner_user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);