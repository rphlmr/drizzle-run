import { DIALECT_IDS, GUEST_FLAVORS } from "@drizzle-run/core/catalog";
import { PAIR_SIDE_NAME_MAX_LENGTH } from "@drizzle-run/core/pair";
import * as z from "zod/mini";

import { GithubAvatarUrlSchema, GithubLoginSchema } from "../auth/contract";
import { TimestampSchema } from "../lib/api";
import { CommunityTopicSchema, type CommunityTopic } from "./topics";

/** A database a Community share runs on. */
export const CommunityDialectSchema = z.enum(DIALECT_IDS);

/** A database a Community share runs on. */
export type CommunityDialect = z.output<typeof CommunityDialectSchema>;

/** The order of the Community list, by listing date. */
export const CommunitySortSchema = z.enum(["newest", "oldest"]);

/** The order of the Community list, by listing date. */
export type CommunitySort = z.output<typeof CommunitySortSchema>;

/**
 * A database and a tested ORM and Kit pair on it, by version, and the guest it runs on: "effect" when the share's
 * guestFlavor is effect.
 */
export const CommunityPairSchema = z.object({
  dialect: CommunityDialectSchema,
  orm: z.string(),
  kit: z.string(),
  guestFlavor: z.enum(GUEST_FLAVORS),
  /** A side-by-side side's name, when the author gave it one. */
  name: z.optional(z.string().check(z.minLength(1), z.maxLength(PAIR_SIDE_NAME_MAX_LENGTH))),
});

/** A database and a tested ORM and Kit pair on it, and the guest it runs on. */
export type CommunityPair = z.output<typeof CommunityPairSchema>;

/** A listing's owner: a GitHub login and its avatar on GitHub's avatar host. */
export const CommunityOwnerSchema = z.object({
  login: GithubLoginSchema,
  avatarUrl: GithubAvatarUrlSchema,
});

/** A listed share's link id: a UUID v4. */
export const CommunityShareIdSchema = z
  .string()
  .check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));

/** One listed share, as the Community page shows it. Community content is attacker-controlled. */
export const CommunityShareSchema = z.object({
  id: CommunityShareIdSchema,
  title: z.string(),
  description: z.nullable(z.string()),
  topic: CommunityTopicSchema,
  /** The database and pair of a one-version share, or of a side-by-side share's left side. */
  releasePair: CommunityPairSchema,
  /** Both sides' databases and pairs, in order: only a side-by-side share has them. */
  sides: z.optional(z.readonly(z.tuple([CommunityPairSchema, CommunityPairSchema]))),
  files: z.array(z.string()),
  listedAt: TimestampSchema,
  /** The GitHub account that listed it. */
  owner: CommunityOwnerSchema,
});

/** One listed share, as the Community page shows it. */
export type CommunityShare = z.output<typeof CommunityShareSchema>;

/** `GET /api/community`: one page of shares, and the cursor of the next one. */
export const CommunityPageResponseSchema = z.object({
  shares: z.array(CommunityShareSchema),
  nextCursor: z.nullable(z.string()),
});

/** `PUT /api/playgrounds/:id/listing`: the listing as stored. */
export const CommunityListingResponseSchema = z.object({ listing: CommunityShareSchema });

/**
 * The Community filters: an empty search and an undefined dialect match every share of the topic. A dialect matches a
 * side-by-side share when either side runs it.
 */
export interface CommunityQuery {
  search: string;
  topic: CommunityTopic;
  dialect: CommunityDialect | undefined;
  sort: CommunitySort;
}

/** One page of Community shares. */
export interface CommunityPage {
  shares: CommunityShare[];
  /** Undefined on the last page. */
  nextCursor: string | undefined;
}

/** What the owner chose in the Share dialog. Title, database, and pair come from the snapshot itself. */
export interface ListingChoice {
  topic: CommunityTopic;
  description: string;
}

/** List a link in Community. */
export interface ListShareRequest {
  linkId: string;
  choice: ListingChoice;
  signal: AbortSignal;
}

/** The Community API: browsing, listing, unlisting and reporting shares. */
export interface CommunityService {
  /** Load one page of listed shares; pass the previous page's cursor for the next one. */
  fetchCommunityPage(request: {
    query: CommunityQuery;
    cursor: string | undefined;
    signal: AbortSignal;
  }): Promise<CommunityPage>;
  /**
   * List a link in Community
   *
   * Needs the signed-in GitHub account that owns the link.
   */
  listShareInCommunity(request: ListShareRequest): Promise<CommunityShare>;
  /** Take a link out of Community with its owner's session. The link keeps working. */
  unlistShareFromCommunity(request: { linkId: string; signal: AbortSignal }): Promise<void>;
  /** Report a share to the moderators; throws a plain message when the Worker refuses it. */
  reportCommunityShare(request: { shareId: string; signal: AbortSignal }): Promise<void>;
}
