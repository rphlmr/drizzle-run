import { GUEST_FLAVORS } from "@drizzle-run/core/catalog";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, snakeCase, text } from "drizzle-orm/sqlite-core";

// The D1 schema. `pnpm db:generate` writes its migrations to drizzle/; `pnpm db:check` fails on any drift.
// Keys are camelCase; snakeCase.table names the SQL columns in snake_case.

/** A GitHub account that signed in, to list shares in Community, see its own shares and sync projects. */
export const users = snakeCase.table(
  "users",
  {
    id: text().primaryKey().notNull(),
    // GitHub's numeric user id: stable across login renames. The avatar URL is built from it.
    githubId: integer().notNull().unique(),
    login: text().notNull(),
    name: text(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [
    check("users_github_id", sql`${table.githubId} > 0`),
    check("users_login", sql`length(${table.login}) BETWEEN 1 AND 39`),
    check("users_name", sql`${table.name} IS NULL OR length(${table.name}) <= 255`),
  ],
);

/** A signed-in browser. The cookie holds a random token; only its SHA-256 is stored, so a database leak signs no one in. */
export const sessions = snakeCase.table(
  "sessions",
  {
    tokenHash: text().primaryKey().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text().notNull(),
    expiresAt: text().notNull(),
  },
  (table) => [
    check("sessions_token_hash", sql`length(${table.tokenHash}) = 64 AND ${table.tokenHash} NOT GLOB '*[^0-9a-f]*'`),
    index("sessions_user").on(table.userId),
  ],
);

/**
 * A shared link and the snapshot it shows. Pushing changes replaces the snapshot; the link stays. Only its owner, signed
 * in, can push, delete, list or record a run.
 */
export const playgroundLinks = snakeCase.table(
  "playground_links",
  {
    id: text().primaryKey().notNull(),
    ownerUserId: text()
      .notNull()
      .references(() => users.id),
    snapshotVersion: integer().notNull(),
    payloadJson: text().notNull(),
    contentDigest: text().notNull(),
    // What the playground shows, in one line. The share's link preview uses it.
    description: text(),
    // The snapshot's name, pairs and a digest per file, written with it, so Community and link previews never read the
    // full payload.
    summaryJson: text().notNull(),
    // The key of the publish that created the link, so a retried first publish returns the same link.
    idempotencyKey: text().notNull().unique(),
    createdAt: text().notNull(),
    // When the snapshot was last pushed.
    updatedAt: text().notNull(),
  },
  (table) => [
    check("playground_links_snapshot_version", sql`${table.snapshotVersion} > 0`),
    check("playground_links_payload_json", sql`length(CAST(${table.payloadJson} AS BLOB)) <= 1048576`),
    check(
      "playground_links_content_digest",
      sql`length(${table.contentDigest}) = 64 AND ${table.contentDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "playground_links_description",
      sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND 140`,
    ),
    index("playground_links_owner_created").on(table.ownerUserId, table.createdAt, table.id),
  ],
);

/** The author's run of a link's current snapshot, shown in embeds whose page cannot run Drizzle Run. */
export const recordedRuns = snakeCase.table(
  "recorded_runs",
  {
    linkId: text()
      .primaryKey()
      .notNull()
      .references(() => playgroundLinks.id),
    // The content digest of the snapshot the run ran against. Pushing other code deletes the recording.
    snapshotDigest: text().notNull(),
    // 256 KiB, the recorded run limit.
    payloadJson: text().notNull(),
    recordedAt: text().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [
    check(
      "recorded_runs_snapshot_digest",
      sql`length(${table.snapshotDigest}) = 64 AND ${table.snapshotDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("recorded_runs_payload_json", sql`length(CAST(${table.payloadJson} AS BLOB)) <= 262144`),
  ],
);

/**
 * The topics a Community listing may use, as stored. Every share is a `playground` unless its owner marks it as a bug
 * repro; Community shows bug repros only under their own filter.
 */
export const communityTopics = ["playground", "bug-repros"] as const;

/**
 * Where a listing stands: `listed` while its owner keeps it in Community, `unlisted` once they take it out, and
 * `removed` when it was taken out by hand after reports, which its owner cannot undo.
 */
export const listingStates = ["listed", "unlisted", "removed"] as const;

/**
 * Shares whose owner listed them in Community. One row per link, with a copy of the link's title, pairs and files that
 * every push refreshes, for search and filters. Listing needs sign-in: the owner is the link's owner, shown on the card.
 */
export const communityListings = snakeCase.table(
  "community_listings",
  {
    linkId: text()
      .primaryKey()
      .notNull()
      .references(() => playgroundLinks.id),
    ownerUserId: text()
      .notNull()
      .references(() => users.id),
    state: text({ enum: listingStates }).notNull(),
    title: text().notNull(),
    description: text(),
    topic: text({ enum: communityTopics }).notNull(),
    // A side-by-side share lists both sides: the first side's database and pair here, the second's in second_*, all
    // NULL for one version.
    dialect: text({ enum: ["postgresql", "sqlite"] }).notNull(),
    ormVersion: text().notNull(),
    kitVersion: text().notNull(),
    // Each side's guestFlavor is indexed separately from its ORM and Kit versions.
    guestFlavor: text({ enum: GUEST_FLAVORS }).notNull(),
    secondDialect: text({ enum: ["postgresql", "sqlite"] }),
    secondOrmVersion: text(),
    secondKitVersion: text(),
    secondGuestFlavor: text({ enum: GUEST_FLAVORS }),
    // The names the author gave a side-by-side share's sides; NULL for an unnamed side and for one version.
    sideName: text(),
    secondSideName: text(),
    // JSON array of the snapshot's file paths.
    fileNames: text().notNull(),
    listedAt: text().notNull(),
    reportCount: integer().notNull().default(0),
    lastReportedAt: text(),
  },
  (table) => [
    check("community_listings_state", sql`${table.state} IN ('listed', 'unlisted', 'removed')`),
    check("community_listings_title", sql`length(${table.title}) BETWEEN 1 AND 160`),
    check(
      "community_listings_description",
      sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND 140`,
    ),
    check("community_listings_topic", sql`${table.topic} IN ('playground', 'bug-repros')`),
    check("community_listings_dialect", sql`${table.dialect} IN ('postgresql', 'sqlite')`),
    check(
      "community_listings_second_dialect",
      sql`${table.secondDialect} IS NULL OR ${table.secondDialect} IN ('postgresql', 'sqlite')`,
    ),
    check("community_listings_guest_flavor", sql`${table.guestFlavor} IN ('slim', 'effect')`),
    check(
      "community_listings_second_guest_flavor",
      sql`${table.secondGuestFlavor} IS NULL OR ${table.secondGuestFlavor} IN ('slim', 'effect')`,
    ),
    check("community_listings_side_name", sql`${table.sideName} IS NULL OR length(${table.sideName}) BETWEEN 1 AND 40`),
    check(
      "community_listings_second_side_name",
      sql`${table.secondSideName} IS NULL OR length(${table.secondSideName}) BETWEEN 1 AND 40`,
    ),
    check(
      "community_listings_file_names",
      sql`json_valid(${table.fileNames}) AND json_type(${table.fileNames}) = 'array'`,
    ),
    check("community_listings_report_count", sql`${table.reportCount} >= 0`),
    index("community_listings_visible")
      .on(table.listedAt, table.linkId)
      .where(sql`${table.state} = 'listed'`),
    // Reported shares waiting for a look, most reported first.
    index("community_listings_reported")
      .on(table.reportCount, table.lastReportedAt)
      .where(sql`${table.reportCount} > 0 AND ${table.state} <> 'removed'`),
  ],
);

/**
 * A project a signed-in user syncs across machines: the index row only. The project itself is an R2 object in the
 * CLOUD_PROJECTS bucket at `objectKey` (see cloud-sync.ts), so D1 stays small.
 */
export const cloudProjects = snakeCase.table(
  "cloud_projects",
  {
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The project's local id, a UUID v4, the same on every machine.
    projectId: text().notNull(),
    name: text().notNull(),
    // Goes up by one with every save; a save must name the revision it was based on.
    revision: integer().notNull(),
    // SHA-256 of the project's name, manifest and trust, so an unchanged project is never written again.
    contentDigest: text().notNull(),
    byteSize: integer().notNull(),
    // The R2 key of this revision's payload. Each save writes a key of its own, so a save that loses a race never
    // overwrites or deletes the winner's object.
    objectKey: text().notNull(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
    check("cloud_projects_revision", sql`${table.revision} > 0`),
    check(
      "cloud_projects_content_digest",
      sql`length(${table.contentDigest}) = 64 AND ${table.contentDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("cloud_projects_byte_size", sql`${table.byteSize} BETWEEN 1 AND 1048576`),
    check("cloud_projects_name", sql`length(${table.name}) BETWEEN 1 AND 200`),
  ],
);

/**
 * The bytes shares and recorded runs keep in D1 in total, for the stored-bytes cap: one row, `scope` "everyone". It goes
 * down when a publish that stored nothing gives its bytes back, when a push replaces a larger snapshot, and when an owner
 * deletes a share with everything it stored.
 */
export const publishStorage = snakeCase.table(
  "publish_storage",
  {
    scope: text().primaryKey().notNull(),
    bytes: integer().notNull(),
  },
  (table) => [check("publish_storage_bytes", sql`${table.bytes} >= 0`)],
);
