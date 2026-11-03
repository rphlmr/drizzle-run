import { sql } from "drizzle-orm";
import { check, integer, primaryKey, snakeCase, text } from "drizzle-orm/sqlite-core";

// Kit drops NOT NULL from TEXT primary keys, and SQLite would accept NULL in them, so each migration keeps it by hand.

/**
 * A local project. The columns hold a project record; `manifest` is the record's manifest as JSON.
 * Rows are read back through the record validation, so a row it rejects stays here for recovery or export.
 */
export const projects = snakeCase.table(
  "projects",
  {
    id: text().primaryKey().notNull(),
    recordVersion: integer().notNull(),
    name: text().notNull(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
    revision: integer().notNull(),
    manifest: text({ mode: "json" }).$type<unknown>().notNull(),
    // `community`: someone else's share, or a copy of one. NULL for the user's own project.
    origin: text({ enum: ["community"] }),
    // Whether the user lets the AI change and run the project: only the user's own act moves it.
    trust: text({ enum: ["trusted", "untrusted"] }).notNull(),
    sourceKind: text({ enum: ["example", "guide"] }),
    sourceId: text(),
  },
  (table) => [
    check("projects_revision", sql`${table.revision} >= 0`),
    check("projects_origin", sql`${table.origin} IN ('community')`),
    check("projects_trust", sql`${table.trust} IN ('trusted', 'untrusted')`),
    check("projects_source_kind", sql`${table.sourceKind} IN ('example', 'guide')`),
    check("projects_source", sql`(${table.sourceKind} IS NULL) = (${table.sourceId} IS NULL)`),
  ],
);

/** The file each project last showed. A project may get one before its first save, so there is no foreign key. */
export const projectPreferences = snakeCase.table("project_preferences", {
  projectId: text().primaryKey().notNull(),
  selectedFile: text().notNull(),
});

/** App-wide settings, such as "the guide was seen", as JSON values. */
export const settings = snakeCase.table("settings", {
  key: text().primaryKey().notNull(),
  value: text({ mode: "json" }).$type<unknown>().notNull(),
});

/**
 * What this browser needs to push changes to a project's shared link. Deleting a project deletes its row.
 * A link restored from an import may arrive before the project's first save, so there is no foreign key.
 */
export const shareLinks = snakeCase.table("share_links", {
  projectId: text().primaryKey().notNull(),
  linkId: text().notNull(),
  publishedAt: text().notNull(),
  description: text(),
  publishedDigest: text(),
  listingTopic: text(),
  listingDescription: text(),
});

/**
 * The Cloud projects this browser holds, per account: the cloud revision and content digest each last matched. A
 * project with a row for the signed-in account is Cloud; one without is Local. Each GitHub account signed in here
 * keeps its own rows, so one account's state is never planned against another account's cloud. Deleting a project
 * keeps its row until the cloud copy is removed too, so there is no foreign key.
 */
export const cloudSync = snakeCase.table(
  "cloud_sync",
  {
    githubId: integer().notNull(),
    projectId: text().notNull(),
    // 0 until the first save reaches the cloud.
    revision: integer().notNull(),
    // SHA-256 of the name and manifest at that revision; empty until then.
    digest: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.githubId, table.projectId] }),
    check("cloud_sync_github_id", sql`${table.githubId} > 0`),
    check("cloud_sync_revision", sql`${table.revision} >= 0`),
  ],
);
