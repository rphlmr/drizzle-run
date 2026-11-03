import { digestCloudProject } from "@drizzle-run/core/contracts";
import type { PendingEdit } from "@drizzle-run/runtime/machines";
import type { Database } from "@sqlite.org/sqlite-wasm";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { migrateAsync } from "drizzle-orm/sqlite-core/async/session";

import { getHistorySetting, mergeStoredHistory, type ChatHistory } from "../connect/chat-history";
import { mergePendingEdits, PENDING_EDITS_SETTING } from "../connect/pending-edits";
import { readStoreMigrations } from "./migrations";
import { cloudSync, projectPreferences, projects, settings, shareLinks } from "./schema";
import { SqliteD1Database } from "./sqlite-d1";

/** A project record as the store keeps it. The page validates it on load, so its fields are not trusted here. */
type ProjectRow = typeof projects.$inferSelect;

export interface StoredProject {
  version: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  manifest: unknown;
  origin?: NonNullable<ProjectRow["origin"]>;
  trust: ProjectRow["trust"];
  /** The official version it was forked from. */
  source?: { kind: NonNullable<ProjectRow["sourceKind"]>; id: string };
}

/** A share link as the store keeps it. The page validates it on read. */
export interface StoredShareLink {
  linkId: string;
  publishedAt: string;
  description?: string;
  publishedDigest?: string;
  listing?: { topic: string; description?: string };
}

/** A project's cloud sync state in this browser. The page validates it on read. */
export interface StoredCloudSync {
  projectId: string;
  revision: number;
  digest: string;
}

/** How ending a session treats Cloud edits the account does not hold. */
export type CloudRemovalPolicy = "require_saved" | "keep_unsaved" | "discard";

/** The projects removed and the unsaved projects found by the same locked store operation. */
export interface CloudProjectRemoval {
  removedIds: string[];
  unsavedIds: string[];
}

/** The ids an upsert's `returning({ id })` gave back: none when its update was skipped. */
function readReturnedIds(rows: unknown): string[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.flatMap((row: unknown) =>
    typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? [row.id] : [],
  );
}

/** The operations the store runs, each in one transaction on the database file. */
export interface StoreOperations {
  loadProjects(): Promise<StoredProject[]>;
  /** One project, or undefined when the store has none with that id. */
  readProject(projectId: string): Promise<StoredProject | undefined>;
  /**
   * Writes the projects, and deletes `deletedIds` with their share links
   *
   * `baseRevisions` holds, per project, the revision the caller last read or wrote. Such a project is written only over
   * a copy no newer than that, and never written back once another tab deleted it. A project without one is written
   * only over an older revision. A project left as it is comes back in `stale`.
   */
  saveProjects(
    projects: readonly StoredProject[],
    deletedIds: readonly string[],
    baseRevisions?: Readonly<Record<string, number>>,
  ): Promise<{ stale: string[] }>;
  readPreference(projectId: string): Promise<string | undefined>;
  writePreference(projectId: string, selectedFile: string): Promise<void>;
  readSetting(key: string): Promise<unknown>;
  /** Writes a JSON value; `undefined` removes the setting. */
  writeSetting(key: string, value: unknown): Promise<void>;
  /** Merges a tab's chat history into the stored one, as `mergeStoredHistory` does, in one transaction. */
  mergeChatHistory(conversation: string, history: ChatHistory): Promise<void>;
  /** Merges a tab's pending edits into the stored ones, as `mergePendingEdits` does, in one transaction. */
  mergePendingEdits(edits: readonly PendingEdit[], knownIds: readonly string[]): Promise<void>;
  readShareLink(projectId: string): Promise<StoredShareLink | undefined>;
  /** The browser's saved share links by project, including links whose project has not been saved yet. */
  readShareLinks(): Promise<{ projectId: string; link: StoredShareLink }[]>;
  writeShareLink(projectId: string, link: StoredShareLink): Promise<void>;
  /** Deletes the project's share link only while it is still `linkId`, so a newer link saved meanwhile stays. */
  deleteShareLink(projectId: string, linkId: string): Promise<void>;
  /** The rows of one GitHub account, by its numeric id. */
  loadCloudSync(githubId: number): Promise<StoredCloudSync[]>;
  /** Creates a row only while its project exists; an existing deletion marker can still learn a completed upload. */
  writeCloudSync(githubId: number, state: StoredCloudSync): Promise<void>;
  deleteCloudSync(githubId: number, projectId: string): Promise<void>;
  /**
   * Removes Cloud copies and their rows under the store lock; null selects all accounts after session expiry
   *
   * `require_saved` refuses the whole operation if any edits are unsaved. `keep_unsaved` keeps those projects as Local.
   * `discard` requires the owner's confirmation to lose unsaved edits. Their share links always stay.
   */
  removeCloudProjects(githubId: number | null, policy: CloudRemovalPolicy): Promise<CloudProjectRemoval>;
}

/** The name of a store operation. */
export type StoreOperationName = keyof StoreOperations;

/** The arguments of each store operation, by name. */
export type StoreArgs = { [Name in StoreOperationName]: Parameters<StoreOperations[Name]> };

/** What each store operation resolves to, by name. */
export type StoreResults = { [Name in StoreOperationName]: Awaited<ReturnType<StoreOperations[Name]>> };

/** A request for one store operation, as the page posts it to the store worker; `Name` narrows it to one. */
export type StoreRequest<Name extends StoreOperationName = StoreOperationName> = {
  [Operation in Name]: { id: number; operation: Operation; args: StoreArgs[Operation] };
}[Name];

/** The store operations, typed so that a request's name picks its own arguments and result. */
type StoreFunctions = { [Name in StoreOperationName]: (...args: StoreArgs[Name]) => Promise<StoreResults[Name]> };

/** The store worker's answer to a request. */
export type StoreResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

/** Runs work with the store's database open, and closes it afterwards. The browser holds a cross-tab lock meanwhile. */
export type WithStoreDatabase = <Result>(work: (database: Database) => Promise<Result>) => Promise<Result>;

type StoreDatabase = DrizzleD1Database;

function toStoredProject(row: ProjectRow): StoredProject {
  return {
    version: row.recordVersion,
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    manifest: row.manifest,
    ...(row.origin === null ? {} : { origin: row.origin }),
    trust: row.trust,
    ...(row.sourceKind === null || row.sourceId === null ? {} : { source: { kind: row.sourceKind, id: row.sourceId } }),
  };
}

function toStoredShareLink(row: typeof shareLinks.$inferSelect): StoredShareLink {
  const link: StoredShareLink = {
    linkId: row.linkId,
    publishedAt: row.publishedAt,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.publishedDigest === null ? {} : { publishedDigest: row.publishedDigest }),
  };

  if (row.listingTopic === null) {
    return link;
  }

  const listing = { topic: row.listingTopic };

  return {
    ...link,
    listing: row.listingDescription === null ? listing : { ...listing, description: row.listingDescription },
  };
}

function runOperation<Name extends StoreOperationName>(operations: StoreFunctions, request: StoreRequest<Name>) {
  return operations[request.operation](...request.args);
}

function createOperations(db: StoreDatabase): StoreOperations {
  return {
    async loadProjects() {
      const rows = await db.select().from(projects);

      return rows.map(toStoredProject);
    },

    async readProject(projectId) {
      const [row] = await db.select().from(projects).where(eq(projects.id, projectId));

      return row === undefined ? undefined : toStoredProject(row);
    },

    async saveProjects(records, deletedIds, baseRevisions = {}) {
      const deletions =
        deletedIds.length === 0
          ? []
          : [
              db.delete(projects).where(inArray(projects.id, [...deletedIds])),
              db.delete(shareLinks).where(inArray(shareLinks.projectId, [...deletedIds])),
            ];
      const upserts = records.map((record) => {
        const columns = {
          recordVersion: record.version,
          name: record.name,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          revision: record.revision,
          manifest: record.manifest,
          origin: record.origin ?? null,
          trust: record.trust,
          sourceKind: record.source?.kind ?? null,
          sourceId: record.source?.id ?? null,
        };
        const baseRevision = Object.hasOwn(baseRevisions, record.id) ? baseRevisions[record.id] : undefined;

        // A save queued behind another tab's write replaces it only when that write is no newer than what this tab
        // saw, and an update finds no row once another tab deleted the project.
        if (baseRevision !== undefined) {
          return db
            .update(projects)
            .set(columns)
            .where(and(eq(projects.id, record.id), sql`${projects.revision} <= ${baseRevision}`))
            .returning({ id: projects.id });
        }

        return db
          .insert(projects)
          .values({ id: record.id, ...columns })
          .onConflictDoUpdate({
            target: projects.id,
            set: {
              recordVersion: sql`excluded.record_version`,
              name: sql`excluded.name`,
              createdAt: sql`excluded.created_at`,
              updatedAt: sql`excluded.updated_at`,
              revision: sql`excluded.revision`,
              manifest: sql`excluded.manifest`,
              origin: sql`excluded.origin`,
              trust: sql`excluded.trust`,
              sourceKind: sql`excluded.source_kind`,
              sourceId: sql`excluded.source_id`,
            },
            // Another tab may have saved a newer copy since this one loaded it: the older write never replaces it.
            setWhere: sql`excluded.revision > ${projects.revision}`,
          })
          .returning({ id: projects.id });
      });
      const [first, ...rest] = [...deletions, ...upserts];

      if (first === undefined) {
        return { stale: [] };
      }

      const results: unknown[] = await db.batch([first, ...rest]);
      const written = new Set(results.slice(deletions.length).flatMap(readReturnedIds));

      return { stale: records.filter((record) => !written.has(record.id)).map((record) => record.id) };
    },

    async readPreference(projectId) {
      const [row] = await db.select().from(projectPreferences).where(eq(projectPreferences.projectId, projectId));

      return row?.selectedFile;
    },

    async writePreference(projectId, selectedFile) {
      await db
        .insert(projectPreferences)
        .values({ projectId, selectedFile })
        .onConflictDoUpdate({ target: projectPreferences.projectId, set: { selectedFile } });
    },

    async readSetting(key) {
      const [row] = await db.select().from(settings).where(eq(settings.key, key));

      return row?.value;
    },

    async writeSetting(key, value) {
      if (value === undefined) {
        await db.delete(settings).where(eq(settings.key, key));
        return;
      }

      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    },

    async mergeChatHistory(conversation, history) {
      const key = getHistorySetting(conversation);
      const [row] = await db.select().from(settings).where(eq(settings.key, key));
      const value = mergeStoredHistory(row?.value, history, conversation);

      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    },

    async mergePendingEdits(edits, knownIds) {
      const [row] = await db.select().from(settings).where(eq(settings.key, PENDING_EDITS_SETTING));
      const value = mergePendingEdits(row?.value, edits, knownIds);

      await db
        .insert(settings)
        .values({ key: PENDING_EDITS_SETTING, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } });
    },

    async readShareLinks() {
      const rows = await db.select().from(shareLinks);

      return rows.map((row) => ({ projectId: row.projectId, link: toStoredShareLink(row) }));
    },

    async readShareLink(projectId) {
      const [row] = await db.select().from(shareLinks).where(eq(shareLinks.projectId, projectId));

      return row === undefined ? undefined : toStoredShareLink(row);
    },

    async writeShareLink(projectId, link) {
      const columns = {
        linkId: link.linkId,
        publishedAt: link.publishedAt,
        description: link.description ?? null,
        publishedDigest: link.publishedDigest ?? null,
        listingTopic: link.listing?.topic ?? null,
        listingDescription: link.listing?.description ?? null,
      };

      await db
        .insert(shareLinks)
        .values({ projectId, ...columns })
        .onConflictDoUpdate({ target: shareLinks.projectId, set: columns });
    },

    async deleteShareLink(projectId, linkId) {
      await db.delete(shareLinks).where(and(eq(shareLinks.projectId, projectId), eq(shareLinks.linkId, linkId)));
    },

    async loadCloudSync(githubId) {
      return db
        .select({
          projectId: cloudSync.projectId,
          revision: cloudSync.revision,
          digest: cloudSync.digest,
        })
        .from(cloudSync)
        .where(eq(cloudSync.githubId, githubId));
    },

    async writeCloudSync(githubId, state) {
      const columns = { revision: state.revision, digest: state.digest };

      await db
        .insert(cloudSync)
        .select(sql`
          select ${githubId}, ${state.projectId}, ${state.revision}, ${state.digest}
          where exists (select 1 from ${projects} where ${projects.id} = ${state.projectId})
            or exists (
              select 1 from ${cloudSync}
              where ${cloudSync.githubId} = ${githubId} and ${cloudSync.projectId} = ${state.projectId}
            )
        `)
        .onConflictDoUpdate({ target: [cloudSync.githubId, cloudSync.projectId], set: columns });
    },

    async deleteCloudSync(githubId, projectId) {
      await db.delete(cloudSync).where(and(eq(cloudSync.githubId, githubId), eq(cloudSync.projectId, projectId)));
    },

    async removeCloudProjects(githubId, policy) {
      const accountFilter = githubId === null ? undefined : eq(cloudSync.githubId, githubId);
      const copies = await db
        .select({ project: projects, sync: cloudSync })
        .from(cloudSync)
        .innerJoin(projects, eq(projects.id, cloudSync.projectId))
        .where(accountFilter);
      const unsavedIds = [
        ...new Set(
          copies
            .filter(({ project, sync }) => sync.revision === 0 || digestCloudProject(project) !== sync.digest)
            .map(({ project }) => project.id),
        ),
      ];

      if (policy === "require_saved" && unsavedIds.length > 0) {
        return { removedIds: [], unsavedIds };
      }

      const kept = new Set(policy === "keep_unsaved" ? unsavedIds : []);
      const removedIds = [...new Set(copies.map(({ project }) => project.id))].filter((id) => !kept.has(id));
      const [removed] = await db.batch([
        db.delete(projects).where(inArray(projects.id, removedIds)).returning({ id: projects.id }),
        db
          .delete(cloudSync)
          .where(githubId === null ? undefined : or(accountFilter, inArray(cloudSync.projectId, removedIds))),
      ]);

      return { removedIds: removed.map((project: { id: string }) => project.id), unsavedIds };
    },
  };
}

function toResponseError(error: unknown): { name: string; message: string } {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }

  // drizzle-orm wraps SQLite errors in a "Failed query" error whose message repeats every parameter.
  const reported = error.cause instanceof Error ? error.cause : error;

  return { name: reported.name, message: reported.message };
}

/**
 * Create the store service the store worker runs
 *
 * Each request opens the database through `withDatabase`, applies any pending bundled migrations with drizzle-orm's
 * migrator, then runs its operation. Migrating on every request keeps a tab whose file was replaced (by another tab
 * on a newer release, or cleared site data) correct; with nothing pending it costs two small queries.
 */
export function createStoreService(withDatabase: WithStoreDatabase) {
  const migrations = readStoreMigrations();

  async function run(request: StoreRequest): Promise<unknown> {
    const pendingMigrations = await migrations;

    return withDatabase(async (database) => {
      const db = drizzle(new SqliteD1Database(database));
      await migrateAsync(pendingMigrations, db);

      return runOperation(createOperations(db), request);
    });
  }

  /** Runs a request and answers it, with the error's name and message when it fails. */
  async function respond(request: StoreRequest): Promise<StoreResponse> {
    try {
      return { id: request.id, ok: true, result: await run(request) };
    } catch (cause) {
      return { id: request.id, ok: false, error: toResponseError(cause) };
    }
  }

  return { respond };
}
