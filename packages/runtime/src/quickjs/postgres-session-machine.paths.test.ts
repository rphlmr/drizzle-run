import {
  createActorSettler,
  getMachinePaths,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, StateMachine, type SnapshotFrom } from "xstate";

import { createPostgresSessionMachine, type PostgresSessionPorts } from "./postgres-session-machine.ts";

const AUTHENTICATION = 0x52;
const READY_FOR_QUERY = 0x5a;
const SYNC = 0x53;
const QUERY = 0x51;
const PARSE = 0x50;

function createPorts() {
  return { onWaiting: vi.fn(), waitingNoticeMs: 1_000 } satisfies PostgresSessionPorts;
}

const sessionMachine = createPostgresSessionMachine(createPorts());
const connectionLogic = sessionMachine.implementations.actors.connection;

if (!(connectionLogic instanceof StateMachine)) {
  throw new Error("Expected the session machine to run each connection as a state machine");
}

const connectionMachine = connectionLogic.provide({ actions: { reportReply: () => undefined } });

function readyForQuery(status: "I" | "T" | "E") {
  return { type: READY_FOR_QUERY, body: Uint8Array.of(status.charCodeAt(0)) };
}

const grant = () => undefined;
const openFirst = { type: "connection.opened", connection: 1 } as const;
const openSecond = { type: "connection.opened", connection: 2 } as const;
const closeFirst = { type: "connection.closed", connection: 1 } as const;
const requestFirst = { type: "exchange.requested", connection: 1, closing: false, grant } as const;
const requestSecond = { type: "exchange.requested", connection: 2, closing: false, grant } as const;
const requestFirstClosing = { type: "exchange.requested", connection: 1, closing: true, grant } as const;
const replyFirstCloses = { type: "reply.received", connection: 1, frames: [], closes: true } as const;
const firstHolds = { type: "connection.replied", connection: 1, holds: true } as const;
const firstReleases = { type: "connection.replied", connection: 1, holds: false } as const;
const secondHolds = { type: "connection.replied", connection: 2, holds: true } as const;
const firstWaited = { type: "waiting.noticed", connection: 1 } as const;

const sessionEventLabels = new Map<object, string>([
  [openFirst, "connection.opened the first connection"],
  [openSecond, "connection.opened the second connection"],
  [closeFirst, "connection.closed the first connection"],
  [requestFirst, "exchange.requested by the first connection"],
  [requestSecond, "exchange.requested by the second connection"],
  [requestFirstClosing, "exchange.requested by the first connection while it closes"],
  [replyFirstCloses, "reply.received that closes the first connection"],
  [firstHolds, "connection.replied the first connection holds the session"],
  [firstReleases, "connection.replied the first connection releases the session"],
  [secondHolds, "connection.replied the second connection holds the session"],
]);

function describeSessionEvent(event: ModelEvent) {
  return sessionEventLabels.get(event);
}

function toSessionModelState(snapshot: SnapshotFrom<typeof sessionMachine>) {
  return {
    value: snapshot.value,
    connections: [...snapshot.context.connections.keys()].toSorted((left, right) => left - right),
    owner: snapshot.context.owner ?? "none",
    waiting: snapshot.context.waiters.length > 0,
  };
}

function startSession() {
  return { actor: createActor(createPostgresSessionMachine(createPorts())).start(), settler: createActorSettler() };
}

const sessionPaths = getMachinePaths(sessionMachine, {
  toModelState: toSessionModelState,
  describeEvent: describeSessionEvent,
  events: () => [
    openFirst,
    openSecond,
    closeFirst,
    requestFirst,
    requestSecond,
    requestFirstClosing,
    { type: "exchange.finished" },
    replyFirstCloses,
    firstHolds,
    firstReleases,
    secondHolds,
    firstWaited,
  ],
});

describe("postgres session machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(sessionPaths)).toMatchSnapshot();
  });

  for (const path of sessionPaths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startSession();

      await expect(
        replayMachinePath(path, { actor, settler, toModelState: toSessionModelState }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});

const sendSync = { type: "frames.sent", frames: [{ type: SYNC }] } as const;
const sendQuery = { type: "frames.sent", frames: [{ type: QUERY }] } as const;
const sendParse = { type: "frames.sent", frames: [{ type: PARSE }] } as const;
const sendStartup = { type: "frames.sent", frames: [{ type: undefined }] } as const;
const receiveAuthentication = {
  type: "reply.received",
  frames: [{ type: AUTHENTICATION, body: new Uint8Array(4) }],
} as const;
const receiveIdle = { type: "reply.received", frames: [readyForQuery("I")] } as const;
const receiveInTransaction = { type: "reply.received", frames: [readyForQuery("T")] } as const;
const receiveFailedTransaction = { type: "reply.received", frames: [readyForQuery("E")] } as const;

const connectionEventLabels = new Map<object, string>([
  [sendSync, "frames.sent Sync"],
  [sendQuery, "frames.sent Query"],
  [sendParse, "frames.sent Parse"],
  [sendStartup, "frames.sent a startup packet"],
  [receiveAuthentication, "reply.received Authentication"],
  [receiveIdle, "reply.received ReadyForQuery idle"],
  [receiveInTransaction, "reply.received ReadyForQuery in a transaction"],
  [receiveFailedTransaction, "reply.received ReadyForQuery in a failed transaction"],
]);

function describeConnectionEvent(event: ModelEvent) {
  return connectionEventLabels.get(event);
}

function toConnectionModelState(snapshot: SnapshotFrom<typeof connectionMachine>) {
  return {
    value: snapshot.value,
    unsynced: snapshot.context.unsynced,
    awaitingReady: Math.min(snapshot.context.awaitingReady, 2),
    transactionStatus: snapshot.context.transactionStatus,
  };
}

const connectionPaths = getMachinePaths(connectionMachine, {
  input: { connection: 1 },
  toModelState: toConnectionModelState,
  describeEvent: describeConnectionEvent,
  events: () => [
    sendSync,
    sendQuery,
    sendParse,
    sendStartup,
    receiveAuthentication,
    receiveIdle,
    receiveInTransaction,
    receiveFailedTransaction,
  ],
});

describe("postgres connection machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(connectionPaths)).toMatchSnapshot();
  });

  for (const path of connectionPaths) {
    it(`should take ${path.description}`, async () => {
      const actor = createActor(connectionMachine, { input: { connection: 1 } }).start();

      await expect(
        replayMachinePath(path, { actor, settler: createActorSettler(), toModelState: toConnectionModelState }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
