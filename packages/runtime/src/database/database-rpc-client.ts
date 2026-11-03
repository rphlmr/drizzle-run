import type { Dialect } from "@drizzle-run/core/catalog";
import { assign, createActor, enqueueActions, fromPromise, setup, waitFor, type Actor } from "xstate";
import * as z from "zod/mini";

import { declareType } from "../machines/declare-type.ts";
import { keepIfValid, PlainRecordSchema } from "../schema.ts";
import { decodeDatabaseValue, encodeDatabaseValue } from "./database-codec.ts";

/** The worker a `DatabaseWorkerClient` talks to; tests pass an in-memory one. */
export interface DatabaseWorkerTransport {
  postMessage(message: unknown): void;
  terminate(): void | Promise<void>;
  subscribe(onMessage: (message: unknown) => void, onError: (cause: Error) => void): void;
}

/** Options of `DatabaseWorkerClient`; `onFailure` runs once when the worker fails. */
export interface DatabaseWorkerClientOptions {
  onFailure?(cause: Error): void;
  template?: Blob;
}

/** A call waiting for its reply, with the id it was sent under once the worker is ready */
interface PendingCall {
  operation: string;
  value: unknown;
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

interface SentCall extends PendingCall {
  id: number;
}

/** What the client tells its machine: its own calls, then what the worker answered */
type DatabaseClientEvent =
  | { type: "client.call"; call: PendingCall }
  | { type: "client.dispose" }
  | { type: "worker.ready" }
  | { type: "worker.replied"; id: number; result: { ok: true; value: unknown } | { ok: false; error: Error } }
  | { type: "worker.failed"; error: Error };

interface DatabaseClientContext {
  /** Calls made before the worker was ready, sent once it is */
  waiting: PendingCall[];
  sent: SentCall[];
  lastRequestId: number;
  failure: Error | undefined;
  terminationError?: Error;
}

/** What the client's machine does to its worker */
interface DatabaseClientPorts {
  /** Sends a call to the worker; throws when the worker cannot take it. */
  send(call: SentCall): void;
  terminate(): void | Promise<void>;
  onFailure(cause: Error): void;
}

const CLOSED_MESSAGE = "Database worker client is closed";
export const DATABASE_TERMINATION_ACTOR_ID = "databaseTermination";

/**
 * Database client machine
 *
 * `starting` until the worker says it is ready, `ready` while calls go out and replies come back, then `failed` on a
 * worker failure or an unexpected reply, or `closed` once disposed. Calls made while starting wait for ready. A failed
 * or closed client rejects every pending and later call, with the failure when there is one.
 */
export function createDatabaseClientMachine(ports: DatabaseClientPorts) {
  return setup({
    types: {
      context: declareType<DatabaseClientContext>(),
      events: declareType<DatabaseClientEvent>(),
    },
    actors: {
      terminate: fromPromise(async () => {
        await ports.terminate();
      }),
    },
    guards: {
      isSentCall: ({ context, event }) =>
        event.type === "worker.replied" && context.sent.some((call) => call.id === event.id),
      requestIdsExhausted: ({ context }) => !Number.isSafeInteger(context.lastRequestId + 1),
    },
    actions: {
      sendCalls: enqueueActions(({ context, enqueue, self }, calls: readonly PendingCall[]) => {
        const sent = calls.map((call, index) => ({ ...call, id: context.lastRequestId + index + 1 }));

        enqueue.assign({ sent: [...context.sent, ...sent], lastRequestId: context.lastRequestId + sent.length });
        enqueue(() => {
          try {
            for (const call of sent) {
              ports.send(call);
            }
          } catch (cause) {
            self.send({ type: "worker.failed", error: toError(cause, "Database worker request could not be sent") });
          }
        });
      }),
      settleReply: enqueueActions(({ context, enqueue, event }) => {
        if (event.type !== "worker.replied") {
          return;
        }

        const call = context.sent.find((sent) => sent.id === event.id);
        enqueue.assign({ sent: context.sent.filter((sent) => sent.id !== event.id) });
        enqueue(() => {
          if (event.result.ok) {
            call?.resolve(event.result.value);
          } else {
            call?.reject(event.result.error);
          }
        });
      }),
      rejectPending: enqueueActions(({ context, enqueue }, error: Error) => {
        const pending = [...context.waiting, ...context.sent];

        enqueue.assign({ waiting: [], sent: [] });
        enqueue(() => rejectCalls(pending, error));
      }),
      rejectCall: ({ event }, error: Error) => {
        if (event.type === "client.call") {
          event.call.reject(error);
        }
      },
      fail: enqueueActions(({ context, enqueue }, error: Error) => {
        const pending = [...context.waiting, ...context.sent];

        enqueue.assign({ failure: error, waiting: [], sent: [] });
        enqueue(() => {
          rejectCalls(pending, error);
          ports.onFailure(error);
        });
      }),
    },
  }).createMachine({
    id: "databaseClient",
    initial: "starting",
    context: { waiting: [], sent: [], lastRequestId: 0, failure: undefined },
    states: {
      starting: {
        on: {
          "client.call": { actions: assign({ waiting: ({ context, event }) => [...context.waiting, event.call] }) },
          "worker.ready": {
            target: "ready",
            actions: [{ type: "sendCalls", params: ({ context }) => context.waiting }, assign({ waiting: [] })],
          },
          "worker.replied": {
            target: "failed",
            actions: { type: "fail", params: () => new Error("Unexpected database worker response") },
          },
          "worker.failed": { target: "failed", actions: { type: "fail", params: ({ event }) => event.error } },
          "client.dispose": { target: "stopping" },
        },
      },
      ready: {
        on: {
          "client.call": [
            {
              guard: "requestIdsExhausted",
              target: "failed",
              actions: [
                { type: "fail", params: () => new Error("Database worker request ID exceeded the safe integer range") },
                { type: "rejectCall", params: ({ context }) => getFailure(context) },
              ],
            },
            { actions: { type: "sendCalls", params: ({ event }) => [event.call] } },
          ],
          "worker.replied": [
            { guard: "isSentCall", actions: "settleReply" },
            {
              target: "failed",
              actions: { type: "fail", params: () => new Error("Unexpected or duplicate database worker response ID") },
            },
          ],
          "worker.ready": {
            target: "failed",
            actions: { type: "fail", params: () => new Error("Database worker sent an unexpected ready message") },
          },
          "worker.failed": { target: "failed", actions: { type: "fail", params: ({ event }) => event.error } },
          "client.dispose": { target: "stopping" },
        },
      },
      failed: {
        always: "stopping",
      },
      stopping: {
        entry: { type: "rejectPending", params: ({ context }) => context.failure ?? new Error(CLOSED_MESSAGE) },
        invoke: {
          id: DATABASE_TERMINATION_ACTOR_ID,
          src: "terminate",
          onDone: "closed",
          onError: {
            target: "terminationFailed",
            actions: assign({
              terminationError: ({ event }) => toError(event.error, "Database worker termination failed"),
            }),
          },
        },
        on: {
          "client.call": {
            actions: { type: "rejectCall", params: ({ context }) => context.failure ?? new Error(CLOSED_MESSAGE) },
          },
        },
      },
      terminationFailed: {
        on: {
          "client.call": {
            actions: {
              type: "rejectCall",
              params: ({ context }) => context.terminationError ?? new Error(CLOSED_MESSAGE),
            },
          },
        },
      },
      closed: {
        on: {
          "client.call": {
            actions: { type: "rejectCall", params: ({ context }) => context.failure ?? new Error(CLOSED_MESSAGE) },
          },
        },
      },
    },
  });
}

function rejectCalls(calls: readonly PendingCall[], error: Error): void {
  for (const call of calls) {
    call.reject(error);
  }
}

function getFailure(context: DatabaseClientContext): Error {
  if (context.failure === undefined) {
    throw new Error("Expected the failed database client to keep its failure");
  }

  return context.failure;
}

/** A failure that is not an `Error` but carries a message, such as a structured-cloned one. */
const ErrorLikeSchema = z.pipe(PlainRecordSchema, z.object({ name: keepIfValid(z.string()), message: z.string() }));

/** A database error the worker serialized; its optional fields are dropped when they have the wrong type. */
const WorkerErrorSchema = z.pipe(
  PlainRecordSchema,
  z.object({
    name: z.string(),
    message: z.string(),
    stack: keepIfValid(z.string()),
    code: keepIfValid(z.string()),
    extendedCode: keepIfValid(z.string()),
    rawCode: keepIfValid(z.union([z.string(), z.number()])),
  }),
);

/** The id of a reply: the positive id of the request it answers. */
const ResponseIdSchema = z.number().check(z.int(), z.positive());

function toError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) {
    return cause;
  }

  const errorLike = ErrorLikeSchema.safeParse(cause);

  if (!errorLike.success) {
    return new Error(fallback);
  }

  const error = new Error(errorLike.data.message);

  if (errorLike.data.name !== undefined) {
    error.name = errorLike.data.name;
  }

  return error;
}

function resolveWorkerError(value: unknown): Error | undefined {
  const workerError = WorkerErrorSchema.safeParse(value);

  if (!workerError.success) {
    return undefined;
  }

  const { name, message, stack, code, extendedCode, rawCode } = workerError.data;
  const error = new Error(message);
  error.name = name;

  if (stack !== undefined) {
    error.stack = stack;
  }

  if (code !== undefined) {
    Object.assign(error, { code });
  }

  if (rawCode !== undefined) {
    Object.assign(error, { rawCode });
  }

  if (extendedCode !== undefined) {
    Object.assign(error, { extendedCode });
  }

  return error;
}

/**
 * Database worker client
 *
 * Sends database calls to the database worker and matches each reply to its request. Once the worker fails, every
 * pending and later call rejects with that failure; once disposed, with a closed error.
 */
export class DatabaseWorkerClient {
  readonly #actor: Actor<ReturnType<typeof createDatabaseClientMachine>>;

  constructor(transport: DatabaseWorkerTransport, dialect: Dialect, options: DatabaseWorkerClientOptions = {}) {
    this.#actor = createActor(
      createDatabaseClientMachine({
        send: ({ id, operation, value }) => transport.postMessage({ id, operation, value: encodeDatabaseValue(value) }),
        terminate: () => transport.terminate(),
        onFailure: (cause) => options.onFailure?.(cause),
      }),
    );
    this.#actor.start();

    try {
      transport.subscribe(
        (message) => this.#handleMessage(message),
        (cause) => this.#actor.send({ type: "worker.failed", error: toError(cause, "Database worker failed") }),
      );
      transport.postMessage({ kind: "init", dialect, ...(options.template ? { template: options.template } : {}) });
    } catch (cause) {
      this.#actor.send({
        type: "worker.failed",
        error: toError(cause, "Database worker could not be initialized"),
      });
    }
  }

  call(operation: string, value: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#actor.send({ type: "client.call", call: { operation, value, resolve, reject } });
    });
  }

  async dispose(): Promise<void> {
    this.#actor.send({ type: "client.dispose" });
    const snapshot = await waitFor(
      this.#actor,
      (state) => state.matches("closed") || state.matches("terminationFailed"),
    );

    if (snapshot.context.terminationError) {
      throw snapshot.context.terminationError;
    }
  }

  #handleMessage(message: unknown): void {
    const response = PlainRecordSchema.safeParse(message);

    if (!response.success) {
      this.#actor.send({ type: "worker.failed", error: new Error("Invalid database worker response") });
      return;
    }

    const value = response.data;

    if (value.kind === "startup_error" || value.kind === "protocol_error") {
      this.#actor.send({
        type: "worker.failed",
        error: resolveWorkerError(value.error) ?? new Error("Invalid database worker failure"),
      });
      return;
    }

    if (value.kind === "ready") {
      this.#actor.send({ type: "worker.ready" });
      return;
    }

    const responseId = ResponseIdSchema.safeParse(value.id);
    const hasError = Object.hasOwn(value, "error");
    const hasValue = Object.hasOwn(value, "value");

    if (!responseId.success) {
      this.#actor.send({ type: "worker.failed", error: new Error("Unexpected database worker response") });
      return;
    }

    if (hasError === hasValue) {
      this.#actor.send({ type: "worker.failed", error: new Error("Malformed database worker response") });
      return;
    }

    if (hasError) {
      const error = resolveWorkerError(value.error);

      this.#actor.send(
        error === undefined
          ? { type: "worker.failed", error: new Error("Malformed database worker error response") }
          : { type: "worker.replied", id: responseId.data, result: { ok: false, error } },
      );
      return;
    }

    try {
      this.#actor.send({
        type: "worker.replied",
        id: responseId.data,
        result: { ok: true, value: decodeDatabaseValue(value.value) },
      });
    } catch (cause) {
      this.#actor.send({ type: "worker.failed", error: toError(cause, "Malformed database worker value response") });
    }
  }
}
