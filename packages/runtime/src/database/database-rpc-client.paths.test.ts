import {
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ActorOutcome,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createDatabaseClientMachine } from "./database-rpc-client.ts";

type DatabaseClientPorts = Parameters<typeof createDatabaseClientMachine>[0];

/** Two calls cover a reply to a sent call, to an unknown id and to a call already answered. */
const MAX_CALLS = 2;

const call = {
  type: "client.call",
  call: { operation: "sqlite.execute", value: "SELECT 1", resolve: () => undefined, reject: () => undefined },
} as const;
const replyToFirst = { type: "worker.replied", id: 1, result: { ok: true, value: [] } } as const;
const failSecond = {
  type: "worker.replied",
  id: 2,
  result: { ok: false, error: new Error("The statement failed.") },
} as const;
const workerFailed = { type: "worker.failed", error: new Error("The database worker crashed.") } as const;

const eventLabels = new Map<object, string>([
  [replyToFirst, "worker.replied to call 1"],
  [failSecond, "worker.replied with an error to call 2"],
]);

function describeEvent(event: ModelEvent) {
  return eventLabels.get(event);
}

function createPorts() {
  return {
    send: vi.fn<DatabaseClientPorts["send"]>(),
    terminate: vi.fn<() => void>(),
    onFailure: vi.fn<DatabaseClientPorts["onFailure"]>(),
  } satisfies DatabaseClientPorts;
}

const databaseClientMachine = createDatabaseClientMachine(createPorts());

type DatabaseClientSnapshot = SnapshotFrom<typeof databaseClientMachine>;

function toModelState(snapshot: DatabaseClientSnapshot) {
  const { waiting, sent, lastRequestId, failure } = snapshot.context;

  return {
    value: snapshot.value,
    waiting: waiting.length,
    sent: sent.map((sentCall) => sentCall.id),
    lastRequestId,
    failed: failure !== undefined,
  };
}

function getCallEvents(snapshot: DatabaseClientSnapshot) {
  const { waiting, lastRequestId } = snapshot.context;
  const queuesCalls = snapshot.matches("starting") || snapshot.matches("ready");

  return queuesCalls && lastRequestId + waiting.length >= MAX_CALLS ? [] : [call];
}

const terminationOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("Termination failed") };
const outcomes = { terminate: terminationOutcome };

const paths = getMachinePaths(databaseClientMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    ...getCallEvents(snapshot),
    replyToFirst,
    failSecond,
    { type: "worker.ready" },
    workerFailed,
    { type: "client.dispose" },
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("database client machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const settler = createActorSettler();
      const actor = createActor(
        createDatabaseClientMachine(createPorts()).provide({
          actors: {
            terminate: settler.fromOutcome(terminationOutcome),
          },
        }),
      ).start();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
