import {
  digestPlaygroundSnapshot,
  digestRetiredPairSnapshot,
  findRetiredPairSnapshot,
  parsePlaygroundSnapshot,
  PlaygroundSnapshotValidationError,
  safeParsePlaygroundSnapshot,
  type PlaygroundSnapshot,
} from "@drizzle-run/core/contracts";

import { getFieldIssueMessage, readJsonBody, sendApiRequest, type Fetch } from "../lib/api";
import {
  IdempotencyKeySchema,
  OwnershipResponseSchema,
  PlaygroundErrorBodySchema,
  PlaygroundIdSchema,
  PlaygroundNotFoundError,
  PublishResponseSchema,
  SharedLinkDetailsSchema,
  SnapshotResponseSchema,
  type LoadedPlayground,
  type PlaygroundsService,
  type PublishedPlaygroundLink,
} from "./playgrounds-contract";

/** What the playground API needs: the network and the origin it runs on. */
export interface PlaygroundsServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
  /** The Drizzle Run origin requests go to and published links must stay on, such as `https://drizzle.run`. */
  origin: string;
}

const errorMessages: Readonly<Partial<Record<string, string>>> = {
  invalid_snapshot: "This playground cannot be shared because its snapshot is invalid.",
  snapshot_too_large:
    "This playground is too large to share. It remains available locally and can be exported as JSON.",
  idempotency_conflict:
    "This share attempt no longer matches its captured snapshot. Close the dialog and start a new share.",
  idempotency_key_conflict:
    "This share attempt no longer matches its captured snapshot. Close the dialog and start a new share.",
  overloaded: "Playground sharing is busy. Retry in a moment.",
  rate_limited: "Too many playgrounds were published. Try again shortly.",
  publish_storage_full:
    "Publishing is paused: Drizzle Run has no room left for new shares. Your playground stays in this browser.",
  storage_unavailable: "Playground sharing is temporarily unavailable. Retry in a moment.",
  snapshot_storage_unavailable: "Playground sharing is temporarily unavailable. Retry in a moment.",
  rate_limit_unavailable: "Playground sharing is temporarily unavailable. Retry in a moment.",
  not_found: "This shared playground could not be found.",
  playground_not_found: "This shared playground could not be found.",
  unsupported_snapshot: "This shared playground uses a format this version of Drizzle Run cannot open.",
  unsupported_version: "This shared playground uses a format this version of Drizzle Run cannot open.",
  sign_in_required: "Sign in with GitHub to share.",
  not_link_owner: "This share belongs to another GitHub account.",
  session_unavailable: "Your sign-in could not be checked right now. Retry in a moment.",
  invalid_share: "This share cannot be published. Keep the description under 140 characters.",
};

/** What deleting a share says instead, where the publishing wording would point the wrong way. */
const deleteErrorMessages: Readonly<Partial<Record<string, string>>> = {
  ...errorMessages,
  sign_in_required: "Sign in with the GitHub account that shared it to stop sharing it.",
  overloaded: "Drizzle Run is busy. Retry deleting the share in a moment.",
  rate_limited: "Too many requests. Try deleting the share again shortly.",
  storage_unavailable: "Deleting shares is temporarily unavailable. Retry in a moment.",
  snapshot_storage_unavailable: "Deleting shares is temporarily unavailable. Retry in a moment.",
};

const deleteRefusedMessage =
  "Only the owner of this share can delete it. Sign in with the GitHub account that shared it.";

/** The Worker's codes for a link that no longer exists. A bare 404, such as a route this deployment lacks, is none. */
const goneCodes: ReadonlySet<string> = new Set(["not_found", "playground_not_found"]);

const snapshotFieldMessages = {
  digest: "Drizzle Run returned an invalid snapshot digest.",
  updatedAt: "Drizzle Run returned an invalid timestamp.",
};

const publishFieldMessages = {
  id: "Drizzle Run returned an invalid playground ID.",
  digest: "Drizzle Run returned an invalid snapshot digest.",
  updatedAt: "Drizzle Run returned an invalid timestamp.",
  url: "Drizzle Run returned an invalid playground URL.",
  embedUrl: "Drizzle Run returned an invalid playground URL.",
};

/**
 * "in 45 seconds" or "in 2 minutes": the wait a `Retry-After` header in seconds asks for, or undefined when it is
 * missing or not a positive number of seconds.
 */
function toRetryWait(retryAfter: string | null): string | undefined {
  const seconds = Number(retryAfter ?? "");

  if (retryAfter === null || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return undefined;
  }

  if (seconds < 60) {
    return `in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }

  const minutes = Math.ceil(seconds / 60);

  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function toApiError(
  response: Response,
  body: unknown,
  {
    messages = errorMessages,
    refused,
  }: { messages?: Readonly<Partial<Record<string, string>>>; refused?: string } = {},
): Error {
  const { status } = response;
  const parsed = PlaygroundErrorBodySchema.safeParse(body);
  const code = parsed.success ? parsed.data.error : undefined;
  const wait = code === "rate_limited" ? toRetryWait(response.headers.get("retry-after")) : undefined;

  if (wait !== undefined) {
    return new Error(`Too many playgrounds were published. Try again ${wait}.`);
  }

  const message = code === undefined ? undefined : messages[code];

  if (message !== undefined) {
    return status === 404 ? new PlaygroundNotFoundError(message) : new Error(message);
  }

  if (refused !== undefined && (status === 401 || status === 403)) {
    return new Error(refused);
  }

  if (status === 429 || status === 503) {
    return new Error("Playground sharing is busy. Retry in a moment.");
  }

  if (status >= 500) {
    return new Error("Playground sharing is temporarily unavailable. Retry in a moment.");
  }

  return new Error("The playground request failed. Check your connection and try again.");
}

/** A supported snapshot, or one on a removed pair kept as published, with the digest of its canonical bytes. */
function readSnapshot(value: unknown) {
  const parsed = safeParsePlaygroundSnapshot(value);

  if (parsed.success) {
    return { snapshot: parsed.data, digest: digestPlaygroundSnapshot(parsed.data) };
  }

  const retired = findRetiredPairSnapshot(value);

  if (retired === undefined) {
    throw new PlaygroundSnapshotValidationError(parsed.issues);
  }

  return { ...retired, digest: digestRetiredPairSnapshot(retired.snapshot) };
}

function toOptionalText(value: string): string | null {
  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

function assertPlaygroundId(id: string) {
  if (!PlaygroundIdSchema.safeParse(id).success) {
    throw new TypeError("Invalid playground ID.");
  }
}

function assertIdempotencyKey(idempotencyKey: string) {
  if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
    throw new TypeError("A UUID idempotency key is required.");
  }
}

/**
 * Create the shared playground API
 *
 * Every request goes to `origin`, and every link a publish returns must resolve on it.
 */
export function createPlaygroundsService({ fetch, origin }: PlaygroundsServiceDependencies): PlaygroundsService {
  const toUrl = (path: string) => new URL(path, origin).href;
  const send = (path: string, init: RequestInit & { signal: AbortSignal }) => sendApiRequest(fetch, toUrl(path), init);

  function resolveLocalUrl(value: string): string | undefined {
    try {
      return new URL(value, origin).href;
    } catch {
      return undefined;
    }
  }

  async function sendSnapshot({
    method,
    path,
    body,
    snapshot,
    idempotencyKey,
    signal,
  }: {
    method: "POST" | "PUT";
    path: string;
    body: string;
    snapshot: PlaygroundSnapshot;
    idempotencyKey?: string;
    signal: AbortSignal;
  }): Promise<PublishedPlaygroundLink> {
    const response = await send(path, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body,
      signal,
    });
    const result = await readJsonBody(response, signal);

    if (!response.ok) {
      throw toApiError(response, result);
    }

    const parsed = PublishResponseSchema.safeParse(result);

    if (!parsed.success) {
      throw new Error(
        getFieldIssueMessage(parsed.error, publishFieldMessages, "Drizzle Run returned an invalid share response."),
      );
    }

    const published = parsed.data;

    if (published.digest !== digestPlaygroundSnapshot(snapshot)) {
      throw new Error("Drizzle Run returned an invalid snapshot digest.");
    }

    const url = resolveLocalUrl(published.url);
    const embedUrl = resolveLocalUrl(published.embedUrl);

    if (
      url === undefined ||
      embedUrl === undefined ||
      url !== toUrl(`/s/${published.id}`) ||
      embedUrl !== toUrl(`/embed/${published.id}`)
    ) {
      throw new Error("Drizzle Run returned an invalid playground URL.");
    }

    return {
      id: published.id,
      digest: published.digest,
      updatedAt: published.updatedAt,
      url,
      embedUrl,
    };
  }

  return {
    async getPlaygroundSnapshot({ id, signal }): Promise<LoadedPlayground> {
      assertPlaygroundId(id);

      const response = await send(`/api/playgrounds/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
      const body = await readJsonBody(response, signal);

      if (!response.ok) {
        throw toApiError(response, body);
      }

      const parsed = SnapshotResponseSchema.safeParse(body);

      if (!parsed.success) {
        throw new Error(
          getFieldIssueMessage(
            parsed.error,
            snapshotFieldMessages,
            "Drizzle Run returned an invalid snapshot response.",
          ),
        );
      }

      const { digest, ...snapshot } = readSnapshot(parsed.data.snapshot);

      if (digest !== parsed.data.digest) {
        throw new Error("This shared playground failed its integrity check.");
      }

      const details = SharedLinkDetailsSchema.safeParse(body);

      if (!details.success) {
        throw new Error("Drizzle Run returned an invalid shared playground.");
      }

      return { ...snapshot, ...details.data, digest, updatedAt: parsed.data.updatedAt };
    },

    async publishPlaygroundSnapshot({ snapshot: input, description, idempotencyKey, signal }) {
      const snapshot = parsePlaygroundSnapshot(structuredClone(input));
      assertIdempotencyKey(idempotencyKey);

      return sendSnapshot({
        method: "POST",
        path: "/api/playgrounds",
        body: JSON.stringify({ snapshot, description: toOptionalText(description) }),
        snapshot,
        idempotencyKey,
        signal,
      });
    },

    async pushChanges({ linkId, snapshot: input, description, signal }) {
      const snapshot = parsePlaygroundSnapshot(structuredClone(input));
      assertPlaygroundId(linkId);

      const link = await sendSnapshot({
        method: "PUT",
        path: `/api/playgrounds/${encodeURIComponent(linkId)}`,
        body: JSON.stringify({ snapshot, description: toOptionalText(description) }),
        snapshot,
        signal,
      });

      if (link.id !== linkId) {
        throw new Error("Drizzle Run returned an invalid playground ID.");
      }

      return link;
    },

    async fetchLinkOwnership({ linkId, signal }) {
      assertPlaygroundId(linkId);

      const response = await send(`/api/playgrounds/${encodeURIComponent(linkId)}/ownership`, {
        headers: { accept: "application/json" },
        signal,
      });
      const body = await readJsonBody(response, signal);

      if (!response.ok) {
        throw toApiError(response, body);
      }

      const parsed = OwnershipResponseSchema.safeParse(body);

      return parsed.success && parsed.data.owned;
    },

    async deletePlayground({ linkId, signal }) {
      assertPlaygroundId(linkId);

      const response = await send(`/api/playgrounds/${encodeURIComponent(linkId)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        signal,
      });

      if (response.status === 204) {
        return "deleted";
      }

      const body = await readJsonBody(response, signal);
      const parsed = PlaygroundErrorBodySchema.safeParse(body);

      if (response.status === 404 && parsed.success && goneCodes.has(parsed.data.error)) {
        return "alreadyGone";
      }

      if (response.ok) {
        throw new Error("Drizzle Run returned an invalid delete response.");
      }

      throw toApiError(response, body, { messages: deleteErrorMessages, refused: deleteRefusedMessage });
    },
  };
}
