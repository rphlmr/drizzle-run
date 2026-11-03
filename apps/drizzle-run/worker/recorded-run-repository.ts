import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { D1Database } from "./platform";
import { playgroundLinks, recordedRuns } from "./schema";

/** A `recorded_runs` row. */
export type StoredRecordedRun = typeof recordedRuns.$inferSelect;

/** A recorded run to store for a link's current snapshot. */
export interface NewRecordedRun {
  linkId: string;
  snapshotDigest: string;
  payloadJson: string;
  recordedAt: string;
  createdAt: string;
}

/** The recorded runs in D1, one per link at most. */
export interface RecordedRunRepository {
  /**
   * Stores the recording unless the link already has one, or no longer shows the snapshot it ran
   *
   * Resolves true when this call stored it. A stored one stays as it was.
   */
  insertIfNew(recording: NewRecordedRun): Promise<boolean>;
  find(linkId: string): Promise<StoredRecordedRun | null>;
}

/** Creates the recorded run repository on a D1 database. */
export function createD1RecordedRunRepository(database: D1Database): RecordedRunRepository {
  const db = drizzle(database);

  return {
    async insertIfNew(recording): Promise<boolean> {
      // The digest is checked in the same statement, so a push that lands first never gets a recording of old code.
      const currentSnapshot = db
        .select({
          linkId: playgroundLinks.id,
          snapshotDigest: playgroundLinks.contentDigest,
          payloadJson: sql`${recording.payloadJson}`.as("payloadJson"),
          recordedAt: sql`${recording.recordedAt}`.as("recordedAt"),
          createdAt: sql`${recording.createdAt}`.as("createdAt"),
        })
        .from(playgroundLinks)
        .where(
          and(eq(playgroundLinks.id, recording.linkId), eq(playgroundLinks.contentDigest, recording.snapshotDigest)),
        );
      const inserted = await db
        .insert(recordedRuns)
        .select(currentSnapshot)
        .onConflictDoNothing({ target: recordedRuns.linkId })
        .returning({ linkId: recordedRuns.linkId });

      return inserted.length === 1;
    },
    async find(linkId): Promise<StoredRecordedRun | null> {
      const row = await db.select().from(recordedRuns).where(eq(recordedRuns.linkId, linkId)).limit(1).get();

      return row ?? null;
    },
  };
}
