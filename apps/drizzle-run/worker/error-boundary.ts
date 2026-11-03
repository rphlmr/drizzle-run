import { createApiError } from "./http";
import { getRequestId, logWorkerFailure } from "./logger";

/** Log an unexpected HTTP failure and return a generic JSON response with its correlation id. */
export function answerUnexpectedError(cause: unknown, request: Request): Response {
  logWorkerFailure({ event: "request_failed", cause, message: "An unexpected request failure occurred", request });

  return createApiError(500, "internal_error", "An unexpected error occurred. Try again.", {
    details: { request_id: getRequestId(request) },
    headers: { "X-Request-Id": getRequestId(request) },
  });
}
