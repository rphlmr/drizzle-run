import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import { createApiError, isJsonRequest, isSameOriginRequest } from "./http";
import { inheritRequestId } from "./logger";

/** How a route refuses input that fails its schema. */
export interface InputRefusal {
  status: number;
  code: string;
  /** The message to send; the first issue's own message when absent, so the schema words it. */
  message?: string;
}

/** One Standard Schema issue, as `sValidator` hands it to its hook. */
interface InputIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/**
 * Refuse input that fails its schema
 *
 * The hook for `sValidator`. Answers `{ error: { code, message } }` for the first issue: with the refusal `fields`
 * gives the top-level field it names, or else with `refusal`.
 *
 * @example
 * sValidator("json", ShareBodySchema, refuseInvalid({ status: 422, code: "invalid_share" }, { description: tooLong }))
 */
export function refuseInvalid(refusal: InputRefusal, fields: Readonly<Record<string, InputRefusal>> = {}) {
  return (result: { success: true } | { success: false; error: readonly InputIssue[] }): Response | undefined => {
    if (result.success) {
      return undefined;
    }

    const [issue] = result.error;
    const segment = issue?.path?.[0];
    const field = typeof segment === "object" ? segment.key : segment;
    const { status, code, message } = (typeof field === "string" ? fields[field] : undefined) ?? refusal;

    return createApiError(status, code, message ?? issue?.message ?? "This request is invalid.");
  };
}

/** Refuse with 403 `same_origin_required` a request that does not come from the Worker's own pages. */
export function requireSameOrigin(message: string): MiddlewareHandler {
  return async (c, next) => {
    if (!isSameOriginRequest(c.req.raw)) {
      return createApiError(403, "same_origin_required", message);
    }

    return next();
  };
}

/** Refuse with 415 `json_required` a request whose body is not JSON. */
export function requireJson(message: string): MiddlewareHandler {
  return async (c, next) => {
    if (!isJsonRequest(c.req.raw)) {
      return createApiError(415, "json_required", message);
    }

    return next();
  };
}

/** Refuse with 413 and `code` a body over `maxBytes`, by its Content-Length or by the bytes it streams. */
export function limitBody({ maxBytes, code, message }: { maxBytes: number; code: string; message: string }) {
  const limiter = bodyLimit({ maxSize: maxBytes, onError: () => createApiError(413, code, message) });

  const middleware: MiddlewareHandler = async (c, next) => {
    const original = c.req.raw;

    return limiter(c, async () => {
      inheritRequestId(c.req.raw, original);
      await next();
    });
  };

  return middleware;
}

/** The answer to a body the JSON validator cannot parse. */
export function createInvalidJsonError(): Response {
  return createApiError(400, "invalid_json", "The request body must contain valid UTF-8 JSON.");
}
