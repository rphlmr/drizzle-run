import * as z from "zod/mini";

import { logWorkerFailure } from "./logger";
import type { WorkerEnvironment } from "./platform";

/** A JSON object with its fields still unread. Refuses null, arrays and other non-objects. */
export const FieldsSchema = z.record(z.string(), z.unknown());

/** A whole number, as `Number.isInteger` reads it, with no safe-integer bound. */
export const IntegerSchema = z.number().check(z.refine(Number.isInteger));

/** A UUID v4 in lowercase, the id of a playground link, a Community share or a cloud project. */
export const UuidV4Schema = z
  .string()
  .check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));

/** What an API error adds: fields beside its code and message, and response headers. */
export interface ApiErrorOptions {
  details?: Record<string, unknown>;
  headers?: HeadersInit;
}

/** An uncached JSON error response. */
export function createApiError(
  status: number,
  code: string,
  message: string,
  { details = {}, headers = {} }: ApiErrorOptions = {},
): Response {
  const responseHeaders = new Headers(headers);

  responseHeaders.set("Cache-Control", "no-store");

  return Response.json({ error: { code, message, ...details } }, { status, headers: responseHeaders });
}

/** Whether the request's `If-None-Match` names `etag`, its weak form, or `*`. */
export function isNotModified(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");

  if (ifNoneMatch === null) {
    return false;
  }

  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();

    return trimmed === "*" || trimmed === etag || trimmed === `W/${etag}`;
  });
}

/** Bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The UTF-8 text a `toBase64Url` value holds; null when it is not base64url or not UTF-8. */
export function fromBase64UrlText(value: string): string | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));

    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/**
 * The rate-limit key for a client address: an IPv4 address as it is, an IPv6 address by its /64 prefix, since one
 * client usually holds a whole /64. Anything that is not an IPv6 address is returned unchanged.
 */
export function toRateLimitAddress(address: string): string {
  if (!address.includes(":") || address.includes(".")) {
    return address;
  }

  const [head = "", tail, ...rest] = address.split("::");

  if (rest.length > 0) {
    return address;
  }

  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: tail === undefined ? 0 : missing }, () => "0"), ...tailGroups];

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return address;
  }

  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/** How long a request refused by a rate limit waits: the period of every limiter in wrangler.jsonc. */
export const rateLimitRetryAfterMs = 60_000;

const rateLimits = {
  publish: {
    binding: "PUBLISH_RATE_LIMIT",
    limited: "Too many playgrounds were published. Try again shortly.",
    unavailable: "Publishing is temporarily unavailable.",
  },
  report: {
    binding: "PUBLISH_RATE_LIMIT",
    limited: "Too many reports were sent. Try again shortly.",
    unavailable: "Reporting is temporarily unavailable.",
  },
  record: {
    binding: "PUBLISH_RATE_LIMIT",
    limited: "Too many runs were recorded. Try again shortly.",
    unavailable: "Recording runs is temporarily unavailable.",
  },
  auth: {
    binding: "AUTH_RATE_LIMIT",
    limited: "Too many sign-in attempts. Try again shortly.",
    unavailable: "Sign-in is temporarily unavailable.",
  },
} as const satisfies Record<
  string,
  { binding: "PUBLISH_RATE_LIMIT" | "AUTH_RATE_LIMIT"; limited: string; unavailable: string }
>;

/**
 * Who a request counts as, for rate limits and daily budgets
 *
 * `user:<id>` for a signed-in account, so people behind one address do not share its limits; `ip:<address>` otherwise,
 * on the address `toRateLimitAddress` groups.
 */
export function toRequestClient(request: Request, userId: string | null): string {
  return userId === null
    ? `ip:${toRateLimitAddress(request.headers.get("cf-connecting-ip") ?? "anonymous")}`
    : `user:${userId}`;
}

/**
 * Rate limit one action
 *
 * Publishes, Community reports and recorded runs share `PUBLISH_RATE_LIMIT`, sign-ins have `AUTH_RATE_LIMIT`; each
 * action keeps its own counter. A request with `userId` is counted for that account, so people behind one address do
 * not share it; any other request for its rate-limit address. A refusal is 429 with `Retry-After`, a limiter that
 * fails is 503, and a missing binding allows everything.
 */
export async function checkRateLimit(
  request: Request,
  environment: WorkerEnvironment,
  action: keyof typeof rateLimits,
  { userId = null }: { userId?: string | null } = {},
): Promise<Response | undefined> {
  const { binding, limited, unavailable } = rateLimits[action];
  const limiter = environment[binding];

  if (limiter === undefined) {
    return undefined;
  }

  const client = toRequestClient(request, userId);

  try {
    const { success } = await limiter.limit({ key: `${action}:${client}` });

    if (success) {
      return undefined;
    }

    return createApiError(429, "rate_limited", limited, {
      headers: { "Retry-After": String(rateLimitRetryAfterMs / 1000) },
    });
  } catch (cause) {
    logWorkerFailure({
      event: "rate_limit_failed",
      cause,
      message: "Checking the rate limit failed",
      request,
      context: { action },
    });
    return createApiError(503, "rate_limit_unavailable", unavailable);
  }
}

/** Whether the request comes from the worker's own origin. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (origin === null || origin !== new URL(request.url).origin) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");

  return fetchSite === null || fetchSite === "same-origin";
}

// The content types Hono's JSON validator reads; it reads any other body as `{}`.
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/** Whether the request body is JSON, as the routes' JSON validators read it. */
export function isJsonRequest(request: Request): boolean {
  return JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "");
}

/** Compares two hashes in time that does not depend on where they differ. */
export function isSameHash(stored: string, given: string): boolean {
  if (stored.length !== given.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < stored.length; index += 1) {
    difference |= stored.charCodeAt(index) ^ given.charCodeAt(index);
  }

  return difference === 0;
}

/** A keyset page position: the last row's timestamp and its UUID v4 id, in sort order. */
export interface PagePosition {
  at: string;
  id: string;
}

const PagePositionSchema = z.tuple([z.string().check(z.refine((at) => Number.isFinite(Date.parse(at)))), UuidV4Schema]);

/** The cursor of the page after `position`: its `[at, id]` as base64url JSON. */
export function encodePageCursor(position: PagePosition): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify([position.at, position.id])));
}

/** The position an `encodePageCursor` cursor holds; null for anything else. */
export function decodePageCursor(cursor: string): PagePosition | null {
  const text = fromBase64UrlText(cursor);

  if (text === null) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = PagePositionSchema.safeParse(value);

  return parsed.success ? { at: parsed.data[0], id: parsed.data[1] } : null;
}
