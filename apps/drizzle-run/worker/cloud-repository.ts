import { and, count, desc, eq, sql, sum, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { D1Database } from "./platform";
import { cloudProjects, users } from "./schema";

/** A `cloud_projects` row: one synced project's index entry. */
export type CloudProjectEntry = typeof cloudProjects.$inferSelect;

/** A user's synced projects in total. */
export interface CloudTotals {
  projects: number;
  bytes: number;
}

/** The account limits a save is held to inside the index write itself, so concurrent saves cannot pass them. */
export interface CloudStorageLimits {
  maxProjects: number;
  maxTotalBytes: number;
}

/** The cloud sync index and quotas in D1. Payloads live in R2, never here. */
export interface CloudRepository {
  /** The user's synced projects, most recently saved first. */
  listProjects(userId: string): Promise<CloudProjectEntry[]>;
  findProject(userId: string, projectId: string): Promise<CloudProjectEntry | null>;
  readTotals(userId: string): Promise<CloudTotals>;
  /**
   * Adds the entry unless the project is already synced or the account would pass `limits`. Returns false when it
   * was refused; the caller reads the index again to say why.
   */
  insertProject(entry: CloudProjectEntry, limits: CloudStorageLimits): Promise<boolean>;
  /**
   * Replaces the entry only while it is still the `base` copy (its revision, and its digest when given) and the account
   * stays within `limits`. Returns false when another save got there first or the new size passes the limit.
   */
  updateProject(
    entry: CloudProjectEntry,
    base: { revision: number; digest?: string | undefined },
    limits: CloudStorageLimits,
  ): Promise<boolean>;
  /** Deletes the project's row while it is still at `copy`'s revision and content; false when it moved on. */
  deleteProject(userId: string, projectId: string, copy: { revision: number; digest: string }): Promise<boolean>;
}

/** The user's synced project count, as a scalar subquery. */
function selectProjectCount(userId: string): SQL<number> {
  return sql<number>`(select count(*) from ${cloudProjects} where ${cloudProjects.userId} = ${userId})`;
}

/** The user's synced bytes, as a scalar subquery; 0 without projects. */
function selectTotalBytes(userId: string): SQL<number> {
  const totalBytes = sql`coalesce(sum(${cloudProjects.byteSize}), 0)`;

  return sql<number>`(select ${totalBytes} from ${cloudProjects} where ${cloudProjects.userId} = ${userId})`;
}

/** Creates the cloud sync repository on a D1 database. */
export function createD1CloudRepository(database: D1Database): CloudRepository {
  const db = drizzle(database);

  return {
    async listProjects(userId): Promise<CloudProjectEntry[]> {
      return db
        .select()
        .from(cloudProjects)
        .where(eq(cloudProjects.userId, userId))
        .orderBy(desc(cloudProjects.updatedAt))
        .all();
    },
    async findProject(userId, projectId): Promise<CloudProjectEntry | null> {
      const row = await db
        .select()
        .from(cloudProjects)
        .where(and(eq(cloudProjects.userId, userId), eq(cloudProjects.projectId, projectId)))
        .limit(1)
        .get();

      return row ?? null;
    },
    async readTotals(userId): Promise<CloudTotals> {
      const row = await db
        .select({ projects: count(), bytes: sum(cloudProjects.byteSize) })
        .from(cloudProjects)
        .where(eq(cloudProjects.userId, userId))
        .get();

      return { projects: row?.projects ?? 0, bytes: Number(row?.bytes ?? 0) };
    },
    async insertProject(entry, limits): Promise<boolean> {
      // Selected from the user's row, so the limits sit in the statement's WHERE: SQLite runs one write at a time,
      // and the counts it checks are the ones it inserts against.
      const inserted = await db
        .insert(cloudProjects)
        .select((qb) =>
          qb
            .select({
              userId: users.id,
              projectId: sql<string>`${entry.projectId}`.as("project_id"),
              name: sql<string>`${entry.name}`.as("name"),
              revision: sql<number>`${entry.revision}`.as("revision"),
              contentDigest: sql<string>`${entry.contentDigest}`.as("content_digest"),
              byteSize: sql<number>`${entry.byteSize}`.as("byte_size"),
              objectKey: sql<string>`${entry.objectKey}`.as("object_key"),
              createdAt: sql<string>`${entry.createdAt}`.as("created_at"),
              updatedAt: sql<string>`${entry.updatedAt}`.as("updated_at"),
            })
            .from(users)
            .where(
              and(
                eq(users.id, entry.userId),
                sql`${selectProjectCount(entry.userId)} < ${limits.maxProjects}`,
                sql`${selectTotalBytes(entry.userId)} + ${entry.byteSize} <= ${limits.maxTotalBytes}`,
              ),
            ),
        )
        .onConflictDoNothing({ target: [cloudProjects.userId, cloudProjects.projectId] })
        .returning({ revision: cloudProjects.revision });

      return inserted.length === 1;
    },
    async updateProject(entry, base, limits): Promise<boolean> {
      // The subquery sums every row, this one included at its old size: take it out and add the new one.
      const updated = await db
        .update(cloudProjects)
        .set({
          name: entry.name,
          revision: entry.revision,
          contentDigest: entry.contentDigest,
          byteSize: entry.byteSize,
          objectKey: entry.objectKey,
          updatedAt: entry.updatedAt,
        })
        .where(
          and(
            eq(cloudProjects.userId, entry.userId),
            eq(cloudProjects.projectId, entry.projectId),
            eq(cloudProjects.revision, base.revision),
            base.digest === undefined ? undefined : eq(cloudProjects.contentDigest, base.digest),
            sql`${selectTotalBytes(entry.userId)} - ${cloudProjects.byteSize} + ${entry.byteSize}
              <= ${limits.maxTotalBytes}`,
          ),
        )
        .returning({ revision: cloudProjects.revision });

      return updated.length === 1;
    },
    async deleteProject(userId, projectId, copy): Promise<boolean> {
      const deleted = await db
        .delete(cloudProjects)
        .where(
          and(
            eq(cloudProjects.userId, userId),
            eq(cloudProjects.projectId, projectId),
            eq(cloudProjects.revision, copy.revision),
            eq(cloudProjects.contentDigest, copy.digest),
          ),
        )
        .returning({ revision: cloudProjects.revision });

      return deleted.length === 1;
    },
  };
}
