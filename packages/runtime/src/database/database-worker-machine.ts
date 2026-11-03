import { DialectSchema } from "@drizzle-run/core/catalog";
import { assign, fromPromise, setup } from "xstate";
import * as z from "zod/mini";

import { declareType } from "../machines/declare-type.ts";
import { toError } from "../machines/error-text.ts";
import type { DatabaseDialect, DatabaseEngine } from "./database-engine.ts";

/** One database call; ids are positive and never reused. */
const DatabaseRequestSchema = z.object({
  id: z.number().check(z.int(), z.positive()),
  operation: z.string(),
  value: z.optional(z.unknown()),
});

type DatabaseRequest = z.output<typeof DatabaseRequestSchema>;

/** A request waiting its turn: a call for the engine, a refusal to answer, or a malformed message that ends the worker */
export type QueuedDatabaseRequest =
  | ({ kind: "call" } & DatabaseRequest)
  | { kind: "refused"; id: number; error: unknown }
  | { kind: "malformed" };

/** What the database worker's machine does to the engine and the worker it runs in */
export interface DatabaseWorkerPorts {
  createEngine(dialect: DatabaseDialect, template?: Blob): Promise<DatabaseEngine>;
  /** Returns the error that refuses `request` before it reaches the engine, such as an operation the dialect lacks. */
  resolveRefusal(dialect: DatabaseDialect, request: DatabaseRequest): Error | null;
  /** Runs one call on the engine and posts its answer; never rejects. */
  serve(engine: DatabaseEngine, request: DatabaseRequest): Promise<void>;
  /** Answers a call with its result. */
  postValue(id: number, value: unknown): void;
  postReady(): void;
  postStartupError(error: unknown): void;
  postProtocolError(error: unknown): void;
  postRequestError(id: number, error: unknown): void;
  closeScope(): void;
}

/** What the database worker hears from its client */
export type DatabaseWorkerEvent =
  | { type: "client.init"; dialect: unknown; template?: Blob }
  | { type: "client.request"; message: unknown };

interface DatabaseWorkerContext {
  dialect: DatabaseDialect | undefined;
  template?: Blob;
  engine: DatabaseEngine | undefined;
  startupError: Error | undefined;
  queue: QueuedDatabaseRequest[];
  seenIds: ReadonlySet<number>;
}

const CLOSED_ERROR_MESSAGE = "Database worker is closed";

/**
 * Database worker machine
 *
 * `idle` until `client.init` names a supported dialect, `starting` while its engine opens, `ready` while it serves one
 * request at a time in arrival order, then `closed` once a `close` request closed the engine or after a malformed
 * message, or `failed` when the engine did not start. Requests that arrive while starting wait for the engine;
 * requests still waiting when it closes, or that arrive after, are answered with an error. A failed worker answers
 * every request with its startup error.
 */
export function createDatabaseWorkerMachine(ports: DatabaseWorkerPorts) {
  return setup({
    types: {
      context: declareType<DatabaseWorkerContext>(),
      events: declareType<DatabaseWorkerEvent>(),
    },
    actors: {
      createEngine: fromPromise<DatabaseEngine, { dialect: DatabaseDialect; template?: Blob }>(({ input }) =>
        ports.createEngine(input.dialect, input.template),
      ),
      serve: fromPromise<void, { engine: DatabaseEngine; request: DatabaseRequest }>(({ input }) =>
        ports.serve(input.engine, input.request),
      ),
      closeEngine: fromPromise<void, DatabaseEngine>(({ input }) => input.close()),
    },
    guards: {
      isSupportedDialect: ({ event }) => event.type === "client.init" && DialectSchema.safeParse(event.dialect).success,
      nextIsMalformed: ({ context }) => context.queue[0]?.kind === "malformed",
      nextIsRefused: ({ context }) => context.queue[0]?.kind === "refused",
      nextIsClose: ({ context }) => {
        const next = context.queue[0];

        return next?.kind === "call" && next.operation === "close";
      },
      nextIsCall: ({ context }) => context.queue[0]?.kind === "call",
    },
    actions: {
      queueRequest: assign(({ context, event }) => {
        if (event.type !== "client.request") {
          return {};
        }

        const queued = toQueuedRequest(event.message, context, ports);

        return {
          queue: [...context.queue, queued],
          seenIds: queued.kind === "call" ? new Set([...context.seenIds, queued.id]) : context.seenIds,
        };
      }),
      dequeue: assign(({ context }) => ({ queue: context.queue.slice(1) })),
      postRefusal: ({ context }) => {
        const next = context.queue[0];

        if (next?.kind === "refused") {
          ports.postRequestError(next.id, next.error);
        }
      },
      refuseQueue: ({ context }, error: Error) => {
        for (const request of context.queue) {
          if (request.kind === "call") {
            ports.postRequestError(request.id, error);
          } else if (request.kind === "refused") {
            ports.postRequestError(request.id, request.error);
          }
        }
      },
      refuseLateRequest: ({ event }, error: Error) => {
        const request = event.type === "client.request" ? DatabaseRequestSchema.safeParse(event.message) : undefined;

        if (request?.success) {
          ports.postRequestError(request.data.id, error);
        }
      },
      refuseSecondInit: () => ports.postStartupError(new TypeError("Database worker was initialized more than once")),
      postProtocolError: () => ports.postProtocolError(new TypeError("Invalid database worker request")),
    },
  }).createMachine({
    id: "databaseWorker",
    initial: "idle",
    context: { dialect: undefined, engine: undefined, startupError: undefined, queue: [], seenIds: new Set() },
    states: {
      idle: {
        on: {
          "client.init": [
            {
              guard: "isSupportedDialect",
              target: "starting",
              actions: assign({
                dialect: ({ event }) => DialectSchema.parse(event.dialect),
                template: ({ event }) => event.template,
              }),
            },
            { actions: () => ports.postStartupError(new TypeError("Unsupported database dialect")) },
          ],
          "client.request": { target: "answeringUninitialized", actions: "queueRequest" },
        },
      },
      answeringUninitialized: {
        always: [
          { guard: "nextIsMalformed", target: "closed", actions: ["postProtocolError", "dequeue"] },
          {
            target: "idle",
            actions: [
              { type: "refuseQueue", params: () => new Error("Database worker has not been initialized") },
              assign({ queue: [] }),
            ],
          },
        ],
      },
      starting: {
        invoke: {
          src: "createEngine",
          input: ({ context }) => {
            if (context.dialect === undefined) {
              throw new Error("Expected the database worker to know its dialect while starting");
            }

            return { dialect: context.dialect, template: context.template };
          },
          onDone: {
            target: "ready",
            actions: [assign({ engine: ({ event }) => event.output }), () => ports.postReady()],
          },
          onError: {
            target: "failed",
            actions: [
              assign({ startupError: ({ event }) => toError(event.error) }),
              ({ event }) => ports.postStartupError(event.error),
            ],
          },
        },
        on: {
          "client.init": { actions: "refuseSecondInit" },
          "client.request": { actions: "queueRequest" },
        },
      },
      ready: {
        initial: "waiting",
        on: {
          "client.init": { actions: "refuseSecondInit" },
          "client.request": { actions: "queueRequest" },
        },
        states: {
          waiting: {
            always: [
              { guard: "nextIsMalformed", target: "#databaseWorker.closed", actions: ["postProtocolError", "dequeue"] },
              { guard: "nextIsRefused", target: "waiting", reenter: true, actions: ["postRefusal", "dequeue"] },
              { guard: "nextIsClose", target: "closing" },
              { guard: "nextIsCall", target: "serving" },
            ],
          },
          serving: {
            invoke: {
              src: "serve",
              input: ({ context }) => ({ engine: getEngine(context), request: getNextCall(context) }),
              onDone: { target: "waiting", actions: "dequeue" },
            },
          },
          closing: {
            invoke: {
              src: "closeEngine",
              input: ({ context }) => getEngine(context),
              onDone: {
                target: "#databaseWorker.closed",
                actions: [({ context }) => ports.postValue(getNextCall(context).id, undefined), "dequeue"],
              },
              onError: {
                target: "waiting",
                actions: [
                  ({ context, event }) => ports.postRequestError(getNextCall(context).id, event.error),
                  "dequeue",
                ],
              },
            },
          },
        },
      },
      failed: {
        entry: [{ type: "refuseQueue", params: ({ context }) => getStartupError(context) }, assign({ queue: [] })],
        on: {
          "client.request": {
            actions: { type: "refuseLateRequest", params: ({ context }) => getStartupError(context) },
          },
        },
      },
      closed: {
        entry: [
          { type: "refuseQueue", params: () => new Error(CLOSED_ERROR_MESSAGE) },
          assign({ queue: [] }),
          () => ports.closeScope(),
        ],
        on: {
          "client.request": { actions: { type: "refuseLateRequest", params: () => new Error(CLOSED_ERROR_MESSAGE) } },
        },
      },
    },
  });
}

function toQueuedRequest(
  message: unknown,
  context: DatabaseWorkerContext,
  ports: DatabaseWorkerPorts,
): QueuedDatabaseRequest {
  const parsed = DatabaseRequestSchema.safeParse(message);

  if (!parsed.success) {
    return { kind: "malformed" };
  }

  const request = parsed.data;

  if (context.seenIds.has(request.id)) {
    return { kind: "refused", id: request.id, error: new TypeError("Database worker request ID was reused") };
  }

  const refusal = context.dialect === undefined ? null : ports.resolveRefusal(context.dialect, request);

  return refusal === null ? { kind: "call", ...request } : { kind: "refused", id: request.id, error: refusal };
}

function getStartupError(context: DatabaseWorkerContext): Error {
  if (context.startupError === undefined) {
    throw new Error("Expected the failed database worker to keep its startup error");
  }

  return context.startupError;
}

function getEngine(context: DatabaseWorkerContext): DatabaseEngine {
  if (context.engine === undefined) {
    throw new Error("Expected the ready database worker to hold its engine");
  }

  return context.engine;
}

function getNextCall(context: DatabaseWorkerContext): DatabaseRequest {
  const next = context.queue[0];

  if (next?.kind !== "call") {
    throw new Error("Expected the next queued database request to be a call");
  }

  return { id: next.id, operation: next.operation, value: next.value };
}
