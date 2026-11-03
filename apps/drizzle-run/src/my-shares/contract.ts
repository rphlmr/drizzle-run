import { DialectSchema, GUEST_FLAVORS } from "@drizzle-run/core/catalog";
import * as z from "zod/mini";

import { CommunityShareIdSchema } from "../community/contract";
import { CommunityTopicSchema } from "../community/topics";
import { TimestampSchema } from "../lib/api";

/** Where a share stands in Community. A removed share left Community after reports and cannot be listed again. */
export const ShareListingStateSchema = z.enum(["listed", "unlisted", "removed"]);

/** Where a share stands in Community. */
export type ShareListingState = z.output<typeof ShareListingStateSchema>;

/** The database, ORM and Kit versions and guest flavor of one side of a share, and the side's name when it has one. */
const MySharePairSchema = z.object({
  dialect: DialectSchema,
  orm: z.string(),
  kit: z.string(),
  guestFlavor: z.enum(GUEST_FLAVORS),
  name: z.optional(z.string()),
});

/** One link the signed-in account owns. */
export const MyShareSchema = z.object({
  id: CommunityShareIdSchema,
  title: z.string(),
  description: z.nullable(z.string()),
  /** One pair for a run, two for a side by side. */
  pairs: z.union([z.tuple([MySharePairSchema]), z.tuple([MySharePairSchema, MySharePairSchema])]),
  createdAt: TimestampSchema,
  /** When the owner last pushed changes, or the publish time when they never did. */
  updatedAt: TimestampSchema,
  /** Null when the share was never listed in Community. */
  listing: z.nullable(z.object({ state: ShareListingStateSchema, topic: CommunityTopicSchema })),
});

/** One link the signed-in account owns. */
export type MyShare = z.output<typeof MyShareSchema>;

/** `GET /api/me/shares`: one page of the account's links, newest first, and the cursor of the next one. */
export const MySharesPageResponseSchema = z.object({
  shares: z.array(MyShareSchema),
  nextCursor: z.nullable(z.string()),
});

/** One page of the account's links. */
export interface MySharesPage {
  shares: MyShare[];
  /** Undefined on the last page. */
  nextCursor: string | undefined;
}

/** Why loading the account's links failed: a stable code, and a message to show. */
export class MySharesError extends Error {
  readonly code: "sign_in_required" | "shares_unavailable";

  constructor(code: MySharesError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MySharesError";
    this.code = code;
  }
}

/** The links the signed-in account owns. */
export interface MySharesService {
  /**
   * Load one page of the account's links, newest first; pass the previous page's cursor, and the same search, for the
   * next one
   *
   * Throws a `MySharesError` with `sign_in_required` when the session ended.
   */
  fetchMySharesPage(request: {
    cursor: string | undefined;
    /** Keeps the shares whose name contains it; empty keeps every share. */
    search: string;
    signal: AbortSignal;
  }): Promise<MySharesPage>;
}
