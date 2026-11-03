import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { CommunityTopic } from "./community-repository";
import type { D1Database } from "./platform";
import { communityListings, playgroundLinks } from "./schema";

/** A shared link, with what its page and link preview show about it. */
export interface StoredSharePage {
  /** The summary of the link's snapshot; see `toSnapshotSummaryJson`. */
  summaryJson: string;
  description: string | null;
  /** The topic of the link's visible Community listing; null when it is not listed. */
  listingTopic: CommunityTopic | null;
}

/** What shared pages read from D1: one link's preview, and every link listed in Community. */
export interface SharePageRepository {
  /** Null for an unknown link. */
  findSharePage(linkId: string): Promise<StoredSharePage | null>;
  /** The links with a visible Community listing, the most recently listed first, at most `limit`. */
  listListedLinkIds(limit: number): Promise<string[]>;
}

/** Creates the shared page repository on a D1 database. */
export function createD1SharePageRepository(database: D1Database): SharePageRepository {
  const db = drizzle(database);
  // Must match the community_listings_visible index's WHERE, as the Community repository writes it.
  const visible = sql`${communityListings.state} = 'listed'`;

  return {
    async findSharePage(linkId): Promise<StoredSharePage | null> {
      const row = await db
        .select({
          summaryJson: playgroundLinks.summaryJson,
          description: playgroundLinks.description,
          listingTopic: communityListings.topic,
        })
        .from(playgroundLinks)
        .leftJoin(communityListings, and(eq(communityListings.linkId, playgroundLinks.id), visible))
        .where(eq(playgroundLinks.id, linkId))
        .limit(1)
        .get();

      return row ?? null;
    },
    async listListedLinkIds(limit): Promise<string[]> {
      const rows = await db
        .select({ linkId: communityListings.linkId })
        .from(communityListings)
        .where(visible)
        .orderBy(desc(communityListings.listedAt))
        .limit(limit);

      return rows.map((row) => row.linkId);
    },
  };
}
