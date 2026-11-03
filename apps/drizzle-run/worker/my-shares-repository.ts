import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { PagePosition } from "./http";
import type { D1Database } from "./platform";
import { communityListings, playgroundLinks } from "./schema";

/** One link a user owns, with its Community listing, if it ever had one. */
export interface OwnedShareRow {
  linkId: string;
  createdAt: string;
  /** The snapshot's name, cut to `titleLength` characters by the query. */
  title: string;
  description: string | null;
  /** The summary's `pairs`, as JSON text. */
  pairsJson: string;
  /** When changes were last pushed. */
  updatedAt: string;
  listing: Pick<typeof communityListings.$inferSelect, "state" | "topic"> | null;
}

/** A page of a user's links, newest first. */
export interface OwnedSharesQuery {
  ownerUserId: string;
  /** The last row of the previous page, by `createdAt` and link id. */
  after: PagePosition | undefined;
  limit: number;
  /** The most title characters a row carries, so a long name never travels whole. */
  titleLength: number;
  /** Keeps the links whose name contains it, ignoring ASCII case. */
  search: string | undefined;
}

/** The links a signed-in user owns, in D1. */
export interface MySharesRepository {
  /** Only the owner's links: another account's never come back. */
  listOwned(query: OwnedSharesQuery): Promise<OwnedShareRow[]>;
}

/** Creates the My shares repository on a D1 database. */
export function createD1MySharesRepository(database: D1Database): MySharesRepository {
  const db = drizzle(database);

  return {
    listOwned({ ownerUserId, after, limit, titleLength, search }): Promise<OwnedShareRow[]> {
      const conditions: SQL[] = [eq(playgroundLinks.ownerUserId, ownerUserId)];

      // Keep the (created_at, id) order of playground_links_owner_created, or SQLite sorts the page itself.
      if (after !== undefined) {
        conditions.push(sql`(${playgroundLinks.createdAt}, ${playgroundLinks.id}) < (${after.at}, ${after.id})`);
      }

      if (search !== undefined) {
        conditions.push(
          sql`instr(lower(json_extract(${playgroundLinks.summaryJson}, '$.name')), lower(${search})) > 0`,
        );
      }

      return db
        .select({
          linkId: playgroundLinks.id,
          createdAt: playgroundLinks.createdAt,
          // The name the Worker validated at publish: always present and not blank.
          title: sql<string>`substr(json_extract(${playgroundLinks.summaryJson}, '$.name'), 1, ${titleLength})`,
          description: playgroundLinks.description,
          pairsJson: sql<string>`json_extract(${playgroundLinks.summaryJson}, '$.pairs')`,
          updatedAt: playgroundLinks.updatedAt,
          listing: {
            state: communityListings.state,
            topic: communityListings.topic,
          },
        })
        .from(playgroundLinks)
        .leftJoin(communityListings, eq(communityListings.linkId, playgroundLinks.id))
        .where(and(...conditions))
        .orderBy(desc(playgroundLinks.createdAt), desc(playgroundLinks.id))
        .limit(limit);
    },
  };
}
