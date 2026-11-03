import * as z from "zod/mini";

import type { CommunityTopic } from "./community-repository";
import { createApiError, decodePageCursor, encodePageCursor, type PagePosition } from "./http";
import { maxListingTitleLength } from "./listed-snapshot";
import { logWorkerFailure } from "./logger";
import { createD1MySharesRepository, type MySharesRepository, type OwnedShareRow } from "./my-shares-repository";
import type { WorkerEnvironment } from "./platform";
import type { listingStates } from "./schema";
import type { ReadCurrentUser, SessionUser } from "./session";
import { readSnapshotPairs, type SnapshotSummaryJson } from "./snapshot-summary";
import type { InputRefusal } from "./validation";

/** What the My shares route depends on: the session and the repository. */
export interface MySharesServices {
  shares(database: WorkerEnvironment["PLAYGROUNDS"]): MySharesRepository;
  /** The signed-in user, or null. */
  currentUser(request: Request, environment: WorkerEnvironment): Promise<SessionUser | null>;
}

/** The share list services the Worker runs with: the session and D1. */
export function createD1MySharesServices({ currentUser }: { currentUser: ReadCurrentUser }): MySharesServices {
  return {
    shares: createD1MySharesRepository,
    currentUser,
  };
}

/** Shares per page when the query asks for no size. */
export const mySharesPageSize = 20;
/** The largest page a query may ask for. */
export const maxMySharesPageSize = 48;

/** Where a share stands in Community; a share removed after reports cannot be listed again. */
export type ShareListingState = (typeof listingStates)[number];

/** One link the signed-in user owns, as My shares shows it. */
export interface MyShare {
  id: string;
  title: string;
  description: string | null;
  /** The database, exact pair and flavor of each side: one for a run, two for a side by side. */
  pairs: SnapshotSummaryJson["pairs"];
  createdAt: string;
  /** When changes were last pushed. */
  updatedAt: string;
  /** Null when the share was never listed in Community. */
  listing: { state: ShareListingState; topic: CommunityTopic } | null;
}

function toMyShare(row: OwnedShareRow): MyShare {
  return {
    id: row.linkId,
    title: row.title,
    description: row.description,
    pairs: readSnapshotPairs(row.pairsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    listing: row.listing === null ? null : { state: row.listing.state, topic: row.listing.topic },
  };
}

const pageSizeMessage = `A page holds 1 to ${maxMySharesPageSize} shares.`;
const searchMessage = `Search with at most ${maxListingTitleLength} characters.`;

/** The My shares page query, such as `?limit=20&cursor=...&q=soft`. */
export const MySharesQuerySchema = z.object({
  /** Keeps the shares whose name contains it, ignoring ASCII case. */
  q: z.optional(z.string().check(z.maxLength(maxListingTitleLength, searchMessage))),
  limit: z.optional(
    z.pipe(
      z.pipe(z.string().check(z.regex(/^\d{1,3}$/, pageSizeMessage)), z.transform(Number)),
      z.number().check(z.gte(1, pageSizeMessage), z.lte(maxMySharesPageSize, pageSizeMessage)),
    ),
  ),
  cursor: z.optional(
    z.pipe(
      z.string(),
      z.transform((cursor, context): PagePosition => {
        const position = decodePageCursor(cursor);

        if (position === null) {
          context.issues.push({ code: "custom", message: "This page cursor is invalid.", input: cursor });
          return z.NEVER;
        }

        return position;
      }),
    ),
  ),
});

export const invalidMySharesQuery = { status: 400, code: "invalid_query" } satisfies InputRefusal;

/** `GET /api/me/shares`: the links the signed-in user owns, newest first, paged. */
export async function listMyShares(
  request: Request,
  environment: WorkerEnvironment,
  query: z.output<typeof MySharesQuerySchema>,
  services: MySharesServices,
): Promise<Response> {
  const limit = query.limit ?? mySharesPageSize;
  let user: SessionUser | null;
  let rows: OwnedShareRow[];

  try {
    user = await services.currentUser(request, environment);

    if (user === null) {
      return createApiError(401, "sign_in_required", "Sign in with GitHub to see your shares.");
    }

    // One extra row says whether another page follows.
    rows = await services.shares(environment.PLAYGROUNDS).listOwned({
      ownerUserId: user.id,
      after: query.cursor,
      limit: limit + 1,
      titleLength: maxListingTitleLength,
      search: query.q?.trim() || undefined,
    });
  } catch (cause) {
    logWorkerFailure({
      event: "my_shares_failed",
      cause,
      message: "Listing a user's shares failed",
      request,
    });
    return createApiError(503, "shares_unavailable", "Your shares could not be loaded right now.");
  }

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return Response.json(
    {
      shares: page.map(toMyShare),
      nextCursor:
        rows.length > limit && last !== undefined ? encodePageCursor({ at: last.createdAt, id: last.linkId }) : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
