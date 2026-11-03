import * as z from "zod/mini";

/** The part of `fetch` the API services use: an absolute URL and its options. The browser's `fetch` is one. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Send a request to Drizzle Run, in plain words when it never arrives
 *
 * A request that never reached the server rejects with the browser's own text, such as "Failed to fetch"; this
 * rejects with a sentence a person can act on instead, keeping the browser's error as its cause. A cancelled request
 * rejects as it did.
 */
export async function sendApiRequest(
  fetch: Fetch,
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    if (init.signal.aborted) {
      throw cause;
    }

    throw new Error("Drizzle Run could not be reached. Check your connection, then try again.", { cause });
  }
}

/**
 * Read a response's JSON body
 *
 * A failed response whose body is not JSON, such as a proxy's 502 page, reads as undefined, so the caller's status or
 * schema picks the message. A successful response whose body cannot be read, such as one cut off when the connection
 * dropped, rejects in plain words, as `sendApiRequest` does. A request cancelled while its body was read rejects as it
 * did.
 */
export async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (signal.aborted) {
      throw cause;
    }

    if (!response.ok) {
      return undefined;
    }

    throw new Error("Drizzle Run could not be reached. Check your connection, then try again.", { cause });
  }
}

/** A timestamp `Date.parse` reads, such as `2026-10-11T00:00:00.000Z`. */
export const TimestampSchema = z.string().check(z.refine((value) => Number.isFinite(Date.parse(value))));

/** The Worker's error envelope, `{ error: { code, message } }`; only the code is read. */
export const ApiErrorBodySchema = z.object({ error: z.object({ code: z.string() }) });

/**
 * Read the Worker's error code from a failed response
 *
 * Returns undefined when the body is not JSON or not the error envelope, such as a proxy's 502 page, so the caller
 * falls back to its own message. A request cancelled while its body was read rejects as it did.
 */
export async function readApiErrorCode(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const body = await readJsonBody(response, signal);
  const parsed = ApiErrorBodySchema.safeParse(body);

  return parsed.success ? parsed.data.error.code : undefined;
}

/**
 * Name the field a response got wrong
 *
 * Picks the message of the first issue's top-level field, so an invalid response still says which part was invalid.
 * Returns `fallback` when no message names that field.
 */
export function getFieldIssueMessage(
  error: z.core.$ZodError,
  messages: Readonly<Partial<Record<string, string>>>,
  fallback: string,
): string {
  const field = error.issues[0]?.path[0];

  return typeof field === "string" ? (messages[field] ?? fallback) : fallback;
}
