import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import type { DatabaseEngine } from "./database-engine.ts";
import {
  createDatabaseWorkerMachine,
  type DatabaseWorkerPorts,
  type QueuedDatabaseRequest,
} from "./database-worker-machine.ts";

const UNSUPPORTED_OPERATION = "pg.unsupported";

const engine = {
  call: async () => undefined,
  close: async () => undefined,
} satisfies DatabaseEngine;

const createEngineOutcome: ActorOutcome<DatabaseEngine> = {
  outputs: [engine],
  error: new Error("The database could not start."),
};
const serveOutcome: ActorOutcome<void> = { outputs: [undefined] };
const closeEngineOutcome: ActorOutcome<void> = {
  outputs: [undefined],
  error: new Error("The database could not close."),
};
const outcomes = { createEngine: createEngineOutcome, serve: serveOutcome, closeEngine: closeEngineOutcome };

const initPostgres = { type: "client.init", dialect: "postgresql" } as const;
const initUnknownDialect = { type: "client.init", dialect: "oracle" } as const;
const malformedRequest = { type: "client.request", message: { id: "one" } } as const;
const eventLabels = new WeakMap<object, string>([
  [initPostgres, "client.init postgresql"],
  [initUnknownDialect, "client.init an unsupported dialect"],
  [malformedRequest, "client.request malformed"],
]);

function describeEvent(event: ModelEvent) {
  return eventLabels.get(event);
}

function createPorts() {
  return {
    createEngine: vi.fn(async () => engine),
    resolveRefusal: (_dialect, request) =>
      request.operation === UNSUPPORTED_OPERATION ? new TypeError("The dialect has no such operation.") : null,
    serve: vi.fn(async () => undefined),
    postValue: vi.fn(),
    postReady: vi.fn(),
    postStartupError: vi.fn(),
    postProtocolError: vi.fn(),
    postRequestError: vi.fn(),
    closeScope: vi.fn(),
  } satisfies DatabaseWorkerPorts;
}

const databaseWorkerMachine = createDatabaseWorkerMachine(createPorts());

function toJobName(request: QueuedDatabaseRequest) {
  return request.kind === "call" && request.operation === "close" ? "close" : request.kind;
}

function toModelState(snapshot: SnapshotFrom<typeof databaseWorkerMachine>) {
  return {
    value: snapshot.value,
    queue: snapshot.context.queue.slice(0, 2).map(toJobName),
  };
}

function label<TEvent extends object>(event: TEvent, name: string) {
  eventLabels.set(event, name);

  return event;
}

function getRequestEvents(snapshot: SnapshotFrom<typeof databaseWorkerMachine>) {
  const nextId = Math.max(0, ...snapshot.context.seenIds) + 1;

  return [
    label(
      { type: "client.request", message: { id: nextId, operation: "pg.query", value: "select 1" } } as const,
      "client.request a call",
    ),
    label({ type: "client.request", message: { id: nextId, operation: "close" } } as const, "client.request close"),
    label(
      { type: "client.request", message: { id: nextId, operation: UNSUPPORTED_OPERATION } } as const,
      "client.request an operation the dialect refuses",
    ),
    label(
      { type: "client.request", message: { id: Math.max(1, nextId - 1), operation: "pg.query" } } as const,
      "client.request with a seen id",
    ),
  ];
}

function startDatabaseWorker() {
  const settler = createActorSettler();
  const machine = createDatabaseWorkerMachine(createPorts()).provide({
    actors: {
      createEngine: settler.fromOutcome(outcomes.createEngine),
      serve: settler.fromOutcome(outcomes.serve),
      closeEngine: settler.fromOutcome(outcomes.closeEngine),
    },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(databaseWorkerMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    initPostgres,
    initUnknownDialect,
    ...getRequestEvents(snapshot),
    malformedRequest,
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("database worker machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startDatabaseWorker();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
