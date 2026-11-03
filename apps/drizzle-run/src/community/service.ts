import { getFieldIssueMessage, readApiErrorCode, readJsonBody, sendApiRequest, type Fetch } from "../lib/api";
import { CommunityListingResponseSchema, CommunityPageResponseSchema, type CommunityService } from "./contract";

/** What the Community API needs: the network and the origin it runs on. */
export interface CommunityServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
  /** The Drizzle Run origin requests go to, such as `https://drizzle.run`. */
  origin: string;
}

const errorMessages: Readonly<Partial<Record<string, string>>> = {
  community_unavailable: "Community shares are unavailable right now. Try again in a moment.",
  invalid_query: "These filters could not be applied. Clear them and try again.",
  invalid_listing: "This share could not be listed. Keep the description under 140 characters.",
  listing_removed: "This share was removed from Community after reports, so it cannot be listed again.",
  snapshot_changed: "The shared code changed while saving the listing. Try again to list its current code.",
  share_not_listed: "This share is no longer listed in Community.",
  rate_limited: "Too many reports were sent. Try again shortly.",
  rate_limit_unavailable: "Reporting is unavailable right now. Try again in a moment.",
  sign_in_required: "Sign in with GitHub to list a share in Community.",
  not_link_owner: "This share belongs to another GitHub account, so it cannot be listed from here.",
  playground_not_found: "This shared playground could not be found.",
};

const invalidShareMessage = "Drizzle Run returned an invalid Community share.";

async function readError(response: Response, signal: AbortSignal, fallback: string): Promise<Error> {
  const code = await readApiErrorCode(response, signal);

  return new Error((code === undefined ? undefined : errorMessages[code]) ?? fallback);
}

/** Create the Community API, sending every request to `origin`. */
export function createCommunityService({ fetch, origin }: CommunityServiceDependencies): CommunityService {
  const toUrl = (path: string) => new URL(path, origin).href;

  return {
    async fetchCommunityPage({ query, cursor, signal }) {
      const params = new URLSearchParams();
      const search = query.search.trim();

      if (search !== "") {
        params.set("q", search);
      }

      params.set("topic", query.topic);

      if (query.dialect !== undefined) {
        params.set("db", query.dialect);
      }

      if (query.sort !== "newest") {
        params.set("sort", query.sort);
      }

      if (cursor !== undefined) {
        params.set("cursor", cursor);
      }

      const response = await sendApiRequest(fetch, toUrl(`/api/community?${params}`), {
        headers: { accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw await readError(
          response,
          signal,
          "Community shares could not be loaded. Check your connection and try again.",
        );
      }

      const parsed = CommunityPageResponseSchema.safeParse(await readJsonBody(response, signal));

      if (!parsed.success) {
        throw new Error(
          getFieldIssueMessage(
            parsed.error,
            { shares: invalidShareMessage },
            "Drizzle Run returned an invalid Community page.",
          ),
        );
      }

      return { shares: parsed.data.shares, nextCursor: parsed.data.nextCursor ?? undefined };
    },

    async listShareInCommunity({ linkId, choice, signal }) {
      const response = await sendApiRequest(fetch, toUrl(`/api/playgrounds/${encodeURIComponent(linkId)}/listing`), {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          topic: choice.topic,
          description: choice.description.trim() === "" ? null : choice.description.trim(),
        }),
        signal,
      });

      if (!response.ok) {
        throw await readError(response, signal, "The share could not be listed in Community. Try again.");
      }

      const parsed = CommunityListingResponseSchema.safeParse(await readJsonBody(response, signal));

      if (!parsed.success) {
        throw new Error(invalidShareMessage);
      }

      const { listing } = parsed.data;

      if (listing.id !== linkId) {
        throw new Error("Drizzle Run returned a different Community listing.");
      }

      return listing;
    },

    async unlistShareFromCommunity({ linkId, signal }) {
      const response = await sendApiRequest(fetch, toUrl(`/api/playgrounds/${encodeURIComponent(linkId)}/listing`), {
        method: "DELETE",
        headers: { accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw await readError(response, signal, "The share could not be unlisted. Try again.");
      }
    },

    async reportCommunityShare({ shareId, signal }) {
      const response = await sendApiRequest(fetch, toUrl(`/api/community/${encodeURIComponent(shareId)}/report`), {
        method: "POST",
        headers: { accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw await readError(response, signal, "The report could not be sent. Check your connection and try again.");
      }
    },
  };
}
