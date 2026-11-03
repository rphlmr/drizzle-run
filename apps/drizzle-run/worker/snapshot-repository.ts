import { and, eq, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { D1Database } from "./platform";
import { communityListings, playgroundLinks, publishStorage, recordedRuns } from "./schema";

/** A `playground_links` row: the link and the snapshot it shows. */
export type StoredPlaygroundLink = typeof playgroundLinks.$inferSelect;

/** A snapshot to store, as a publish or a push sends it. */
export interface NewPlaygroundSnapshot {
  snapshotVersion: number;
  payloadJson: string;
  contentDigest: string;
  description: string | null;
  summaryJson: string;
}

/** A new link to store with its first snapshot. */
export interface NewPlaygroundLink extends NewPlaygroundSnapshot {
  id: string;
  ownerUserId: string;
  idempotencyKey: string;
  createdAt: string;
}

/** The copy of a snapshot's title, pairs and files a Community listing keeps for search and filters. */
export type ListingCopy = Pick<
  typeof communityListings.$inferInsert,
  | "title"
  | "dialect"
  | "ormVersion"
  | "kitVersion"
  | "guestFlavor"
  | "secondDialect"
  | "secondOrmVersion"
  | "secondKitVersion"
  | "secondGuestFlavor"
  | "sideName"
  | "secondSideName"
  | "fileNames"
>;

/** The `publish_storage` row every publish counts toward. */
export const EVERYONE_PUBLISH_SCOPE = "everyone";

/** What the stored total counts for a link beyond the texts of its rows; see `measureNewLinkBytes`. */
export interface StoredLinkBytes {
  /** Counted once per recorded run. */
  rowOverheadBytes: number;
  /** Counted once per link: its own row, and the row and text room of the Community listing it may get. */
  linkBytes: number;
}

/** The published links in D1. */
export interface SnapshotRepository {
  /** Creates the link with its snapshot, unless the idempotency key was already used. */
  insertLinkIfNew(link: NewPlaygroundLink): Promise<void>;
  /** The link a first publish created with this idempotency key. */
  findByIdempotencyKey(key: string): Promise<StoredPlaygroundLink | null>;
  findLink(id: string): Promise<StoredPlaygroundLink | null>;
  /**
   * Replace a link's snapshot, in one transaction
   *
   * Refreshes its Community listing's copy, deletes a recorded run of other code, and gives back to the stored total
   * what the replaced snapshot and that recording counted. Returns false and changes nothing when the link is gone.
   */
  pushSnapshot(
    linkId: string,
    snapshot: NewPlaygroundSnapshot & { updatedAt: string },
    listing: ListingCopy,
    counted: Pick<StoredLinkBytes, "rowOverheadBytes">,
  ): Promise<boolean>;
  /**
   * Reserve a publish's bytes in the stored total
   *
   * Counts nothing and returns false when the total would pass `storedBudget`, the most bytes shares and recorded runs
   * may keep in D1.
   */
  reservePublishBytes(reservation: { bytes: number; storedBudget: number }): Promise<boolean>;
  /** Give back reserved bytes that stored nothing, such as a publish whose insert failed. */
  releasePublishBytes(bytes: number): Promise<void>;
  /**
   * Delete a link with its recorded run and Community listing, in one transaction
   *
   * Gives back to the stored total what those rows counted, measured from the rows still there before they go, so a
   * deletion that finds the link already gone gives back nothing.
   */
  deleteLink(linkId: string, counted: StoredLinkBytes): Promise<void>;
}

/** The UTF-8 bytes of a text column or expression, 0 for NULL, as `measureStoredBytes` counts them. */
function measureTextBytes(text: AnyColumn | SQL): SQL<number> {
  return sql<number>`coalesce(length(CAST(${text} AS BLOB)), 0)`;
}

/**
 * The bytes of a link's snapshot texts, as `measureSnapshotBytes` counts them: its payload, summary, description, and
 * the file names a Community listing copies, as `JSON.stringify(Object.keys(summary.files))` writes them
 */
function measureSnapshotTextBytes(): SQL<number> {
  const listedFileNames = sql`(SELECT json_group_array(key) FROM json_each(${playgroundLinks.summaryJson}, '$.files'))`;

  return sql<number>`${measureTextBytes(playgroundLinks.payloadJson)} + ${measureTextBytes(playgroundLinks.summaryJson)}
    + ${measureTextBytes(playgroundLinks.description)} + ${measureTextBytes(listedFileNames)}`;
}

/** Creates the snapshot repository on a D1 database. */
export function createD1SnapshotRepository(database: D1Database): SnapshotRepository {
  const db = drizzle(database);

  const subtractStoredBytes = (bytes: SQL<number> | number) =>
    db
      .update(publishStorage)
      .set({ bytes: sql`max(${publishStorage.bytes} - (${bytes}), 0)` })
      .where(eq(publishStorage.scope, EVERYONE_PUBLISH_SCOPE));

  const measureRecordingBytes = (rowOverheadBytes: number, where: SQL | undefined) =>
    db
      .select({
        bytes: sql<number>`coalesce(sum(
          ${measureTextBytes(recordedRuns.payloadJson)} + ${measureTextBytes(recordedRuns.snapshotDigest)}
          + ${rowOverheadBytes}
        ), 0)`,
      })
      .from(recordedRuns)
      .where(where);

  return {
    async insertLinkIfNew(link): Promise<void> {
      await db
        .insert(playgroundLinks)
        .values({ ...link, updatedAt: link.createdAt })
        .onConflictDoNothing({ target: playgroundLinks.idempotencyKey });
    },
    async findByIdempotencyKey(key): Promise<StoredPlaygroundLink | null> {
      const row = await db.select().from(playgroundLinks).where(eq(playgroundLinks.idempotencyKey, key)).limit(1).get();

      return row ?? null;
    },
    async findLink(id): Promise<StoredPlaygroundLink | null> {
      const row = await db.select().from(playgroundLinks).where(eq(playgroundLinks.id, id)).limit(1).get();

      return row ?? null;
    },
    async pushSnapshot(linkId, snapshot, listing, { rowOverheadBytes }): Promise<boolean> {
      const staleRecording = and(
        eq(recordedRuns.linkId, linkId),
        ne(recordedRuns.snapshotDigest, snapshot.contentDigest),
      );
      const replacedBytes = db
        .select({ bytes: measureSnapshotTextBytes() })
        .from(playgroundLinks)
        .where(eq(playgroundLinks.id, linkId));

      // One transaction: the bytes are measured from the rows still there, then the rows change.
      const [, , updated] = await db.batch([
        subtractStoredBytes(
          sql<number>`coalesce((${replacedBytes}), 0) + (${measureRecordingBytes(rowOverheadBytes, staleRecording)})`,
        ),
        db.delete(recordedRuns).where(staleRecording),
        db
          .update(playgroundLinks)
          .set(snapshot)
          .where(eq(playgroundLinks.id, linkId))
          .returning({ id: playgroundLinks.id }),
        db.update(communityListings).set(listing).where(eq(communityListings.linkId, linkId)),
      ]);

      return updated.length > 0;
    },
    async reservePublishBytes({ bytes, storedBudget }) {
      // A new row starts at `bytes` without the guard below, so a publish larger than the cap stops here.
      if (bytes > storedBudget) {
        return false;
      }

      const reserved = await db
        .insert(publishStorage)
        .values({ scope: EVERYONE_PUBLISH_SCOPE, bytes })
        .onConflictDoUpdate({
          target: publishStorage.scope,
          set: { bytes: sql`${publishStorage.bytes} + ${bytes}` },
          setWhere: sql`${publishStorage.bytes} + ${bytes} <= ${storedBudget}`,
        })
        .returning({ bytes: publishStorage.bytes });

      return reserved.length > 0;
    },
    async releasePublishBytes(bytes) {
      await subtractStoredBytes(bytes);
    },
    async deleteLink(linkId, { rowOverheadBytes, linkBytes }): Promise<void> {
      // Only a link still there gives back its bytes, so a repeated deletion never takes another share's.
      const linkRowBytes = db
        .select({ bytes: sql<number>`coalesce(sum(${measureSnapshotTextBytes()} + ${linkBytes}), 0)` })
        .from(playgroundLinks)
        .where(eq(playgroundLinks.id, linkId));

      // One transaction: the bytes are measured from the rows still there, then the rows go.
      await db.batch([
        subtractStoredBytes(
          sql<number>`(${linkRowBytes}) + (${measureRecordingBytes(rowOverheadBytes, eq(recordedRuns.linkId, linkId))})`,
        ),
        db.delete(recordedRuns).where(eq(recordedRuns.linkId, linkId)),
        db.delete(communityListings).where(eq(communityListings.linkId, linkId)),
        db.delete(playgroundLinks).where(eq(playgroundLinks.id, linkId)),
      ]);
    },
  };
}
