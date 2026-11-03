import { assign, enqueueActions, sendParent, setup, type ActorRefFrom, type SnapshotFrom } from "xstate";

import { declareType } from "../machines/declare-type.ts";

const AUTHENTICATION = 0x52;
const READY_FOR_QUERY = 0x5a;
const SYNC = 0x53;
const QUERY = 0x51;
const FLUSH = 0x48;
const TERMINATE = 0x58;

/** A frame a client sent; a startup packet or an encryption request has no type byte. */
export interface SentFrame {
  type: number | undefined;
}

/** A typed frame of the host's reply. */
export interface ReceivedFrame {
  type: number;
  body: Uint8Array;
}

/** The last ReadyForQuery's status: idle, inside a transaction, or inside a failed one. */
export type TransactionStatus = "I" | "T" | "E";

interface ConnectionContext {
  connection: number;
  unsynced: boolean;
  awaitingReady: number;
  transactionStatus: TransactionStatus;
}

type ConnectionEvent =
  | { type: "frames.sent"; frames: SentFrame[] }
  | { type: "reply.received"; frames: ReceivedFrame[] };

/**
 * PostgreSQL connection machine
 *
 * `startup` until the host authenticates the connection, then `ready`. It counts the Sync and Query frames that wait
 * for their ReadyForQuery, notes frames sent without their Sync, and keeps the last transaction status. After each
 * reply it tells the session whether it holds the session: once `ready`, while its last ReadyForQuery says `T` or
 * `E`, while frames it sent wait for their Sync, or while a Sync or Query waits for its ReadyForQuery.
 */
const connectionMachine = setup({
  types: {
    context: declareType<ConnectionContext>(),
    events: declareType<ConnectionEvent>(),
    input: declareType<{ connection: number }>(),
  },
  guards: {
    authenticates: ({ event }) =>
      event.type === "reply.received" && event.frames.some(({ type }) => type === AUTHENTICATION),
  },
  actions: {
    readSentFrames: assign(({ context, event }) =>
      event.type === "frames.sent" ? readSentFrames(context, event.frames) : {},
    ),
    readReceivedFrames: assign(({ context, event }) =>
      event.type === "reply.received" ? readReceivedFrames(context, event.frames) : {},
    ),
    reportReply: sendParent(({ context }, params: { ready: boolean }) => ({
      type: "connection.replied",
      connection: context.connection,
      holds: params.ready && holdsSession(context),
    })),
  },
}).createMachine({
  id: "postgresConnection",
  context: ({ input }) => ({
    connection: input.connection,
    unsynced: false,
    awaitingReady: 0,
    transactionStatus: "I",
  }),
  initial: "startup",
  on: {
    "frames.sent": { actions: "readSentFrames" },
  },
  states: {
    startup: {
      on: {
        "reply.received": [
          {
            guard: "authenticates",
            target: "ready",
            actions: ["readReceivedFrames", { type: "reportReply", params: { ready: true } }],
          },
          { actions: ["readReceivedFrames", { type: "reportReply", params: { ready: false } }] },
        ],
      },
    },
    ready: {
      on: {
        "reply.received": { actions: ["readReceivedFrames", { type: "reportReply", params: { ready: true } }] },
      },
    },
  },
});

/** A connection's phase; one the session no longer knows is closed. */
export type ConnectionPhase = "startup" | "ready" | "closed";

interface WaitingNoticeInput {
  connection: number;
  delayMs: number;
}

/** Tells the session, once `delayMs` passed, that a ready connection is still waiting for the session's holder. */
const waitingNoticeMachine = setup({
  types: {
    context: declareType<WaitingNoticeInput>(),
    input: declareType<WaitingNoticeInput>(),
  },
  delays: {
    notice: ({ context }) => context.delayMs,
  },
}).createMachine({
  id: "postgresWaitingNotice",
  context: ({ input }) => input,
  initial: "waiting",
  states: {
    waiting: {
      after: {
        notice: {
          target: "noticed",
          actions: sendParent(({ context }) => ({ type: "waiting.noticed", connection: context.connection })),
        },
      },
    },
    noticed: { type: "final" },
  },
});

/** Starts a granted exchange with its connection's phase, which holds until the exchange finishes. */
type GrantExchange = (phase: ConnectionPhase) => void;

interface Waiter {
  id: number;
  connection: number;
  closing: boolean;
  grant: GrantExchange;
}

interface SessionContext {
  connections: Map<number, ActorRefFrom<typeof connectionMachine>>;
  owner: number | undefined;
  waiters: Waiter[];
  nextWaiterId: number;
}

/** What the session hears from its connections' streams and from its own children */
export type PostgresSessionEvent =
  | { type: "connection.opened"; connection: number }
  | { type: "connection.closed"; connection: number }
  | { type: "exchange.requested"; connection: number; closing: boolean; grant: GrantExchange }
  | { type: "exchange.finished" }
  | { type: "frames.sent"; connection: number; frames: SentFrame[] }
  | { type: "reply.received"; connection: number; frames: ReceivedFrame[]; closes: boolean }
  | { type: "connection.replied"; connection: number; holds: boolean }
  | { type: "waiting.noticed"; connection: number };

/** What the session asks of the runner */
export interface PostgresSessionPorts {
  onWaiting(waiting: { connection: number; owner: number | undefined }): void;
  waitingNoticeMs: number;
}

/**
 * PostgreSQL session machine
 *
 * The session's lock is `free` or `exchanging`: one exchange runs at a time. A connection may start one when the lock
 * is free and it is closing, still in its startup, or no other connection holds the session; otherwise it waits in
 * line, and each finished exchange grants the first waiter that may go. A ready connection that waited
 * `waitingNoticeMs` is reported through `onWaiting`. Each connection runs its own machine, which tells the session
 * after each reply whether it holds the session. Events for a connection the session no longer knows are ignored.
 */
export function createPostgresSessionMachine(ports: PostgresSessionPorts) {
  return setup({
    types: {
      context: declareType<SessionContext>(),
      events: declareType<PostgresSessionEvent>(),
    },
    actors: {
      connection: connectionMachine,
      waitingNotice: waitingNoticeMachine,
    },
    guards: {
      mayExchange: ({ context }, params: { connection: number; closing: boolean }) =>
        mayExchange(context, params.connection, params.closing),
      hasGrantableWaiter: ({ context }) =>
        context.waiters.some((waiter) => mayExchange(context, waiter.connection, waiter.closing)),
    },
    actions: {
      grant: ({ context }, params: { connection: number; grant: GrantExchange }) =>
        params.grant(getPhase(context, params.connection)),
      noticeWaiting: ({ context }, params: { connection: number }) =>
        ports.onWaiting({ connection: params.connection, owner: context.owner }),
      enqueueWaiter: enqueueActions(({ context, event, enqueue }) => {
        const waiter = createWaiter(context, event);

        if (!waiter.closing && getPhase(context, waiter.connection) === "ready") {
          enqueue.spawnChild("waitingNotice", {
            id: getWaitingNoticeId(waiter.id),
            input: { connection: waiter.connection, delayMs: ports.waitingNoticeMs },
          });
        }

        enqueue.assign({ waiters: [...context.waiters, waiter], nextWaiterId: waiter.id + 1 });
      }),
    },
  }).createMachine({
    id: "postgresSession",
    context: { connections: new Map(), owner: undefined, waiters: [], nextWaiterId: 0 },
    initial: "free",
    on: {
      "connection.opened": {
        actions: assign({
          connections: ({ context, event, spawn }) =>
            new Map(context.connections).set(
              event.connection,
              spawn("connection", {
                id: getConnectionActorId(event.connection),
                input: { connection: event.connection },
              }),
            ),
        }),
      },
      "connection.closed": {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const connection = context.connections.get(event.connection);

          if (connection !== undefined) {
            enqueue.stopChild(connection);
            enqueue.assign(withoutConnection(context, event.connection));
          }
        }),
      },
      "frames.sent": {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const connection = context.connections.get(event.connection);

          if (connection !== undefined) {
            enqueue.sendTo(connection, { type: "frames.sent", frames: event.frames });
          }
        }),
      },
      "reply.received": {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const connection = context.connections.get(event.connection);

          if (connection === undefined) {
            return;
          }

          if (event.closes) {
            enqueue.stopChild(connection);
            enqueue.assign(withoutConnection(context, event.connection));
            return;
          }

          enqueue.sendTo(connection, { type: "reply.received", frames: event.frames });
        }),
      },
      "connection.replied": {
        actions: assign({
          owner: ({ context, event }) => {
            if (!context.connections.has(event.connection)) {
              return context.owner;
            }

            if (event.holds) {
              return event.connection;
            }

            return context.owner === event.connection ? undefined : context.owner;
          },
        }),
      },
      "waiting.noticed": {
        actions: { type: "noticeWaiting", params: ({ event }) => ({ connection: event.connection }) },
      },
    },
    states: {
      free: {
        on: {
          "exchange.requested": [
            {
              guard: {
                type: "mayExchange",
                params: ({ event }) => ({ connection: event.connection, closing: event.closing }),
              },
              target: "exchanging",
              actions: { type: "grant", params: ({ event }) => ({ connection: event.connection, grant: event.grant }) },
            },
            { actions: "enqueueWaiter" },
          ],
        },
      },
      exchanging: {
        on: {
          "exchange.requested": { actions: "enqueueWaiter" },
          "exchange.finished": [
            {
              guard: "hasGrantableWaiter",
              actions: enqueueActions(({ context, enqueue }) => {
                const waiter = context.waiters.find((candidate) =>
                  mayExchange(context, candidate.connection, candidate.closing),
                );

                if (waiter === undefined) {
                  return;
                }

                enqueue.stopChild(getWaitingNoticeId(waiter.id));
                enqueue.assign({ waiters: context.waiters.filter((candidate) => candidate !== waiter) });
                enqueue({ type: "grant", params: { connection: waiter.connection, grant: waiter.grant } });
              }),
            },
            { target: "free" },
          ],
        },
      },
    },
  });
}

function createWaiter(context: SessionContext, event: PostgresSessionEvent): Waiter {
  if (event.type !== "exchange.requested") {
    throw new Error(`Expected an exchange request to queue, but got '${event.type}'`);
  }

  return { id: context.nextWaiterId, connection: event.connection, closing: event.closing, grant: event.grant };
}

function withoutConnection(context: SessionContext, connectionId: number): Partial<SessionContext> {
  const connections = new Map(context.connections);
  connections.delete(connectionId);

  return { connections, owner: context.owner === connectionId ? undefined : context.owner };
}

/** Reads a connection's phase from a session snapshot. */
export function getConnectionPhase(
  snapshot: SnapshotFrom<ReturnType<typeof createPostgresSessionMachine>>,
  connection: number,
): ConnectionPhase {
  return getPhase(snapshot.context, connection);
}

function getPhase(context: SessionContext, connectionId: number): ConnectionPhase {
  const connection = context.connections.get(connectionId);

  if (connection === undefined) {
    return "closed";
  }

  return connection.getSnapshot().matches("ready") ? "ready" : "startup";
}

function mayExchange(context: SessionContext, connection: number, closing: boolean): boolean {
  return (
    closing || getPhase(context, connection) !== "ready" || context.owner === undefined || context.owner === connection
  );
}

function getConnectionActorId(connection: number): string {
  return `connection-${connection}`;
}

function getWaitingNoticeId(waiterId: number): string {
  return `waiting-notice-${waiterId}`;
}

function readSentFrames(connection: ConnectionContext, frames: SentFrame[]): Partial<ConnectionContext> {
  let { unsynced, awaitingReady } = connection;

  for (const { type } of frames) {
    if (type === undefined || type === FLUSH || type === TERMINATE) {
      continue;
    }

    if (type === SYNC) {
      unsynced = false;
      awaitingReady += 1;
    } else if (type === QUERY) {
      awaitingReady += 1;
    } else {
      unsynced = true;
    }
  }

  return { unsynced, awaitingReady };
}

function readReceivedFrames(connection: ConnectionContext, frames: ReceivedFrame[]): Partial<ConnectionContext> {
  let { awaitingReady, transactionStatus } = connection;

  for (const { type, body } of frames) {
    if (type === READY_FOR_QUERY) {
      awaitingReady = Math.max(0, awaitingReady - 1);
      transactionStatus = toTransactionStatus(body[0]);
    }
  }

  return { awaitingReady, transactionStatus };
}

/** Reads a ReadyForQuery status byte; anything but idle or a transaction counts as a failed transaction. */
function toTransactionStatus(byte: number | undefined): TransactionStatus {
  const status = String.fromCharCode(byte ?? 0);

  return status === "I" || status === "T" ? status : "E";
}

function holdsSession(connection: ConnectionContext): boolean {
  return connection.unsynced || connection.awaitingReady > 0 || connection.transactionStatus !== "I";
}
