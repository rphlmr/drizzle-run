import * as z from "zod/mini";

import {
  communityTopics,
  createD1CommunityRepository,
  type CommunityRepository,
  type VisibleCommunityListing,
} from "./community-repository";
import { toCommunityShare } from "./community-share";
import { checkRateLimit, createApiError, decodePageCursor, encodePageCursor } from "./http";
import { toListingCopy } from "./listed-snapshot";
import { logWorkerFailure } from "./logger";
import type { WorkerEnvironment } from "./platform";
import { authorizeLinkOwner, requireSignedInUser, ShareDescriptionSchema } from "./playgrounds";
import type { ReadCurrentUser, SessionUser } from "./session";
import { createD1SnapshotRepository, type SnapshotRepository } from "./snapshot-repository";
import type { InputRefusal } from "./validation";

/** What the Community routes depend on: the clock, the session and the repositories. */
export interface CommunityServices {
  now(): string;
  listings(database: WorkerEnvironment["PLAYGROUNDS"]): CommunityRepository;
  snapshots(database: WorkerEnvironment["PLAYGROUNDS"]): SnapshotRepository;
  /** The signed-in user, or null. */
  currentUser(request: Request, environment: WorkerEnvironment): Promise<SessionUser | null>;
}

/** The Community services the Worker runs with: the clock, the session and D1. */
export function createD1CommunityServices({ currentUser }: { currentUser: ReadCurrentUser }): CommunityServices {
  return {
    now: () => new Date().toISOString(),
    listings: createD1CommunityRepository,
    snapshots: createD1SnapshotRepository,
    currentUser,
  };
}

/** Listings per page when the query asks for no size. */
export const communityPageSize = 12;
/** The largest page a query may ask for. */
export const maxCommunityPageSize = 48;
const maxSearchLength = 100;

const pageSizeMessage = `A page holds 1 to ${maxCommunityPageSize} shares.`;

/** The Community page query, such as `?q=users&topic=bug_repro&db=sqlite&sort=oldest&limit=12&cursor=...`. */
export const CommunityQuerySchema = z.pipe(
  z.object({
    q: z._default(
      z
        .string()
        .check(z.trim(), z.maxLength(maxSearchLength, `A search must be at most ${maxSearchLength} characters.`)),
      "",
    ),
    topic: z._default(z.enum(communityTopics, { error: "This topic does not exist." }), "playground"),
    db: z.optional(z.enum(["", "postgresql", "sqlite"], { error: "Filter by postgresql or sqlite." })),
    sort: z._default(z.enum(["newest", "oldest"], { error: "Sort by newest or oldest." }), "newest"),
    limit: z.optional(
      z.pipe(
        z.pipe(z.string().check(z.regex(/^\d{1,3}$/, pageSizeMessage)), z.transform(Number)),
        z.number().check(z.gte(1, pageSizeMessage), z.lte(maxCommunityPageSize, pageSizeMessage)),
      ),
    ),
    cursor: z.optional(
      z.pipe(
        z.string(),
        z.transform((cursor, context) => {
          const position = decodePageCursor(cursor);

          if (position === null) {
            context.issues.push({ code: "custom", message: "This page cursor is invalid.", input: cursor });
            return z.NEVER;
          }

          return { listedAt: position.at, linkId: position.id };
        }),
      ),
    ),
  }),
  z.transform(({ q, db, ...query }) => ({ ...query, search: q, dialect: db === "" ? undefined : db })),
);

export const invalidCommunityQuery = { status: 400, code: "invalid_query" } satisfies InputRefusal;

/** `GET /api/community`: listed shares, filtered and paged. */
export async function listCommunityShares(
  _request: Request,
  environment: WorkerEnvironment,
  query: z.output<typeof CommunityQuerySchema>,
  services: CommunityServices,
): Promise<Response> {
  const { search, topic, dialect, sort, cursor: after } = query;
  const limit = query.limit ?? communityPageSize;
  let rows: VisibleCommunityListing[];

  try {
    rows = await services.listings(environment.PLAYGROUNDS).listVisible({
      search,
      topic,
      dialect,
      sort,
      after,
      limit: limit + 1,
    });
  } catch (cause) {
    logWorkerFailure({
      event: "community_read_failed",
      cause,
      message: "Loading Community shares failed",
      request: _request,
    });
    return createApiError(503, "community_unavailable", "Community shares could not be loaded right now.");
  }

  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return Response.json(
    {
      shares: page.map((row) => toCommunityShare(row, row.owner)),
      nextCursor:
        rows.length > limit && last !== undefined ? encodePageCursor({ at: last.listedAt, id: last.linkId }) : null,
    },
    { headers: { "Cache-Control": "no-cache" } },
  );
}

/** The body of a listing: its topic and its description. */
export const ListingBodySchema = z.object(
  {
    topic: z.enum(communityTopics, { error: "Pick one of the Community topics." }),
    description: ShareDescriptionSchema,
  },
  { error: "Send the listing as { topic, description }." },
);

/** The largest listing body, in bytes. */
export const maxListingBodyBytes = 4096;

export const shareNotListed = {
  status: 404,
  code: "share_not_listed",
  message: "This share is not listed in Community.",
} satisfies InputRefusal;

/**
 * `PUT /api/playgrounds/:id/listing`: lists the link in Community, or changes its topic and description
 *
 * The card shows the link's current snapshot, and every push refreshes it. Only the link's signed-in owner can list it.
 */
export async function listInCommunity(
  request: Request,
  environment: WorkerEnvironment,
  { id, body: listing }: { id: string; body: z.output<typeof ListingBodySchema> },
  services: CommunityServices,
): Promise<Response> {
  const user = await requireSignedInUser({
    request,
    environment,
    sessions: services,
    signInMessage: "Sign in with GitHub to list a share in Community.",
  });

  if (user instanceof Response) {
    return user;
  }

  try {
    const link = await authorizeLinkOwner({ id, user, links: services.snapshots(environment.PLAYGROUNDS) });

    if (link instanceof Response) {
      return link;
    }

    const listings = services.listings(environment.PLAYGROUNDS);
    const current = await listings.findListing(id);

    if (current !== null && current.state === "removed") {
      return createApiError(
        403,
        "listing_removed",
        "This share was removed from Community after reports and cannot be listed again.",
      );
    }

    const written = await listings.upsertListing({
      linkId: id,
      ownerUserId: user.id,
      description: listing.description,
      topic: listing.topic,
      copy: toListingCopy(link.summaryJson),
      summaryJson: link.summaryJson,
      listedAt: services.now(),
    });

    if (written === "snapshot_changed") {
      return createApiError(409, "snapshot_changed", "The shared code changed while saving the listing. Try again.");
    }

    const saved = await listings.findListing(id);

    if (saved === null) {
      return createApiError(503, "community_unavailable", "The listing could not be read back yet.");
    }

    return Response.json({ listing: toCommunityShare(saved, user) }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "community_list_failed",
      cause,
      message: "Listing a share in Community failed",
      request,
    });
    return createApiError(503, "community_unavailable", "The share could not be listed right now. Try again.");
  }
}

/** `DELETE /api/playgrounds/:id/listing`: takes the link out of Community. The link itself keeps working. */
export async function unlistFromCommunity(
  request: Request,
  environment: WorkerEnvironment,
  { id }: { id: string },
  services: CommunityServices,
): Promise<Response> {
  const user = await requireSignedInUser({
    request,
    environment,
    sessions: services,
    signInMessage: "Sign in with GitHub to take a share out of Community.",
  });

  if (user instanceof Response) {
    return user;
  }

  try {
    const link = await authorizeLinkOwner({ id, user, links: services.snapshots(environment.PLAYGROUNDS) });

    if (link instanceof Response) {
      return link;
    }

    await services.listings(environment.PLAYGROUNDS).unlist(id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "community_unlist_failed",
      cause,
      message: "Unlisting a share from Community failed",
      request,
    });
    return createApiError(503, "community_unavailable", "The share could not be unlisted right now. Try again.");
  }
}

/** `POST /api/community/:id/report`: flags a listed share for a look. Removal happens by hand. */
export async function reportCommunityShare(
  request: Request,
  environment: WorkerEnvironment,
  { id }: { id: string },
  services: CommunityServices,
): Promise<Response> {
  const limited = await checkRateLimit(request, environment, "report");

  if (limited !== undefined) {
    return limited;
  }

  try {
    const counted = await services.listings(environment.PLAYGROUNDS).report(id, services.now());

    if (!counted) {
      return createApiError(404, "share_not_listed", "This share is not listed in Community.");
    }

    return Response.json({ reported: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logWorkerFailure({
      event: "community_report_failed",
      cause,
      message: "Reporting a Community share failed",
      request,
    });
    return createApiError(503, "community_unavailable", "The report could not be sent right now. Try again.");
  }
}
