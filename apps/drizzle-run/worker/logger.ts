import pino from "pino/browser.js";

interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

/** Preserve error causes without copying arbitrary fields such as SQL parameters or request payloads. */
export function serializeWorkerError(cause: unknown, seen = new Set<Error>()): SerializedError {
  if (!(cause instanceof Error)) {
    return {
      type: typeof cause,
      message: typeof cause === "string" ? cause : "A non-Error value was thrown.",
    };
  }

  if (seen.has(cause)) {
    return { type: cause.name, message: "Circular error cause." };
  }

  seen.add(cause);

  return {
    type: cause.name,
    message: cause.message,
    stack: cause.stack,
    ...(cause.cause === undefined ? {} : { cause: serializeWorkerError(cause.cause, seen) }),
  };
}

const logger = pino({
  level: "info",
  serializers: { err: serializeWorkerError },
  browser: {
    serialize: ["err", "!stdSerializers.err"],
    write: {
      error: (record) => console.error(JSON.stringify(record)),
      warn: (record) => console.warn(JSON.stringify(record)),
      info: (record) => console.info(JSON.stringify(record)),
    },
  },
});

const requestIds = new WeakMap<Request, string>();

/** A generated correlation id, shared by every log and response for this request. */
export function getRequestId(request: Request): string {
  const existing = requestIds.get(request);

  if (existing !== undefined) {
    return existing;
  }

  const requestId = crypto.randomUUID();
  requestIds.set(request, requestId);

  return requestId;
}

/** Retain correlation when middleware replaces a request while reading its body. */
export function inheritRequestId(request: Request, original: Request): void {
  requestIds.set(request, getRequestId(original));
}

/** Log one handled failure as a JSON line; request headers, bodies and query strings are excluded. */
export function logWorkerFailure({
  event,
  cause,
  message,
  request,
  context = {},
}: {
  event: string;
  cause: unknown;
  message: string;
  request?: Request;
  context?: Record<string, string | number>;
}): void {
  logger.error(
    {
      ...context,
      event,
      err: cause,
      ...(request === undefined
        ? {}
        : { request_id: getRequestId(request), method: request.method, path: new URL(request.url).pathname }),
    },
    message,
  );
}

/** Log Durable Object callback failures and rethrow so the runtime preserves alarm retry and failure semantics. */
export async function runDurableObjectCallback(event: string, operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    logWorkerFailure({ event, cause, message: "A Durable Object callback failed" });
    throw cause;
  }
}
