import { and, asc, desc, eq, getColumns, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { D1Database, D1Result } from "./platform";
import { communityListings, playgroundLinks, users, type communityTopics } from "./schema";
import type { ListingCopy } from "./snapshot-repository";

export { communityTopics } from "./schema";

/** A stored listing topic. */
export type CommunityTopic = (typeof communityTopics)[number];
/** A database a listing runs on. */
export type CommunityDialect = StoredCommunityListing["dialect"];
/** The guest a listed side runs on. */
export type GuestFlavor = StoredCommunityListing["guestFlavor"];
/** The order of a listing query, by listing time. */
export type CommunitySort = "newest" | "oldest";

/**
 * A `community_listings` row. `secondDialect`, `secondOrmVersion`, `secondKitVersion` and `secondGuestFlavor` hold the
 * second side's database and pair of a side-by-side share, and are null for one version. `sideName` and `secondSideName` hold its sides' names,
 * null for an unnamed side.
 */
export type StoredCommunityListing = typeof communityListings.$inferSelect;

/** A visible listing with the GitHub account that listed it. */
export type VisibleCommunityListing = StoredCommunityListing & {
  owner: { githubId: number; login: string };
};

/** A listing to store: the owner's choices and the copy read from the link's snapshot. */
export interface NewCommunityListing {
  linkId: string;
  /** The signed-in user listing it, who must own the link. */
  ownerUserId: string;
  description: string | null;
  topic: CommunityTopic;
  copy: ListingCopy;
  /** The summary the copy was built from; a concurrent push must not make it stale. */
  summaryJson: string;
  listedAt: string;
}

/** How a listing write ended. */
export type ListingWrite = "listed" | "snapshot_changed";

/** A page of visible listings: the filters, the order and the cursor. */
export interface CommunityQuery {
  search: string;
  topic: CommunityTopic;
  dialect: CommunityDialect | undefined;
  sort: CommunitySort;
  /** The last row of the previous page. */
  after: { listedAt: string; linkId: string } | undefined;
  limit: number;
}

/** The Community listings in D1. */
export interface CommunityRepository {
  findListing(linkId: string): Promise<StoredCommunityListing | null>;
  /**
   * List the link, or list it again with new choices
   *
   * Reports and removal stay as they are. Writes the listing only while the link is the listing owner's and the copy
   * describes the link's snapshot; answers `snapshot_changed` otherwise.
   */
  upsertListing(listing: NewCommunityListing): Promise<ListingWrite>;
  unlist(linkId: string): Promise<void>;
  /** Visible listings only: listed by their owner and not removed after reports. */
  listVisible(query: CommunityQuery): Promise<VisibleCommunityListing[]>;
  /** The link's listing with its owner, or null when the link is not listed or its listing is not visible. */
  findVisible(linkId: string): Promise<VisibleCommunityListing | null>;
  /** Counts one report on a visible listing. False when the share is not listed. */
  report(linkId: string, reportedAt: string): Promise<boolean>;
}

/** Escapes LIKE wildcards so a search for "100%" matches the text "100%". */
function toLikePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** Creates the Community repository on a D1 database. */
export function createD1CommunityRepository(database: D1Database): CommunityRepository {
  const db = drizzle(database);
  // The community_listings_visible index's own WHERE, written as literals so the partial index always matches it.
  const visible = sql`${communityListings.state} = 'listed'`;

  return {
    async findListing(linkId): Promise<StoredCommunityListing | null> {
      const row = await db.select().from(communityListings).where(eq(communityListings.linkId, linkId)).limit(1).get();

      return row ?? null;
    },
    async upsertListing(listing): Promise<ListingWrite> {
      const listed = { ...listing.copy, description: listing.description, topic: listing.topic };
      const ownedLinkRow = db
        .select({
          linkId: playgroundLinks.id,
          ownerUserId: playgroundLinks.ownerUserId,
          state: sql`'listed'`.as("state"),
          title: sql`${listed.title}`.as("title"),
          description: sql`${listed.description}`.as("description"),
          topic: sql`${listed.topic}`.as("topic"),
          dialect: sql`${listed.dialect}`.as("dialect"),
          ormVersion: sql`${listed.ormVersion}`.as("ormVersion"),
          kitVersion: sql`${listed.kitVersion}`.as("kitVersion"),
          guestFlavor: sql`${listed.guestFlavor}`.as("guestFlavor"),
          secondDialect: sql`${listed.secondDialect}`.as("secondDialect"),
          secondOrmVersion: sql`${listed.secondOrmVersion}`.as("secondOrmVersion"),
          secondKitVersion: sql`${listed.secondKitVersion}`.as("secondKitVersion"),
          secondGuestFlavor: sql`${listed.secondGuestFlavor}`.as("secondGuestFlavor"),
          sideName: sql`${listed.sideName}`.as("sideName"),
          secondSideName: sql`${listed.secondSideName}`.as("secondSideName"),
          fileNames: sql`${listed.fileNames}`.as("fileNames"),
          listedAt: sql`${listing.listedAt}`.as("listedAt"),
        })
        .from(playgroundLinks)
        .where(
          and(
            eq(playgroundLinks.id, listing.linkId),
            eq(playgroundLinks.ownerUserId, listing.ownerUserId),
            eq(playgroundLinks.summaryJson, listing.summaryJson),
          ),
        );

      const written = await db
        .insert(communityListings)
        .select(ownedLinkRow)
        .onConflictDoUpdate({
          target: communityListings.linkId,
          set: {
            ...listed,
            ownerUserId: listing.ownerUserId,
            // A share removed after reports stays removed.
            state: sql`CASE WHEN ${communityListings.state} = 'removed' THEN 'removed' ELSE 'listed' END`,
            listedAt: sql`CASE
              WHEN ${communityListings.state} = 'unlisted' THEN ${listing.listedAt}
              ELSE ${communityListings.listedAt}
            END`,
          },
        })
        .returning({ linkId: communityListings.linkId });

      return written.length > 0 ? "listed" : "snapshot_changed";
    },
    async unlist(linkId): Promise<void> {
      await db
        .update(communityListings)
        .set({ state: "unlisted" })
        .where(and(eq(communityListings.linkId, linkId), eq(communityListings.state, "listed")));
    },
    listVisible(query): Promise<VisibleCommunityListing[]> {
      const conditions: (SQL | undefined)[] = [visible];

      if (query.search !== "") {
        const pattern = toLikePattern(query.search);
        conditions.push(sql`(
          ${communityListings.title} LIKE ${pattern} ESCAPE '\\'
          OR ${communityListings.description} LIKE ${pattern} ESCAPE '\\'
        )`);
      }

      conditions.push(eq(communityListings.topic, query.topic));

      if (query.dialect !== undefined) {
        conditions.push(
          or(eq(communityListings.dialect, query.dialect), eq(communityListings.secondDialect, query.dialect)),
        );
      }

      if (query.after !== undefined) {
        const position = sql`(${communityListings.listedAt}, ${communityListings.linkId})`;
        const after = sql`(${query.after.listedAt}, ${query.after.linkId})`;
        conditions.push(query.sort === "newest" ? sql`${position} < ${after}` : sql`${position} > ${after}`);
      }

      const direction = query.sort === "newest" ? desc : asc;

      return db
        .select({
          ...getColumns(communityListings),
          owner: { githubId: users.githubId, login: users.login },
        })
        .from(communityListings)
        .innerJoin(users, eq(users.id, communityListings.ownerUserId))
        .where(and(...conditions))
        .orderBy(direction(communityListings.listedAt), direction(communityListings.linkId))
        .limit(query.limit);
    },
    async findVisible(linkId): Promise<VisibleCommunityListing | null> {
      const row = await db
        .select({
          ...getColumns(communityListings),
          owner: { githubId: users.githubId, login: users.login },
        })
        .from(communityListings)
        .innerJoin(users, eq(users.id, communityListings.ownerUserId))
        .where(and(visible, eq(communityListings.linkId, linkId)))
        .limit(1)
        .get();

      return row ?? null;
    },
    async report(linkId, reportedAt): Promise<boolean> {
      const result: D1Result = await db
        .update(communityListings)
        .set({ reportCount: sql`${communityListings.reportCount} + 1`, lastReportedAt: reportedAt })
        .where(and(eq(communityListings.linkId, linkId), visible));

      return (result.meta?.changes ?? 0) > 0;
    },
  };
}
