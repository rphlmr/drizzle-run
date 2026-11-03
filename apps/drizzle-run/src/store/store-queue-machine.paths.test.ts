import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createStoreQueueMachine, EMPTY_REVISIONS, type StoreTask, type StoreTaskOutcome } from "./store-queue-machine";

const storeQueueMachine = createStoreQueueMachine();
const writtenOutcome: StoreTaskOutcome = {
  revisions: { known: new Map([["p1", 2]]), reloads: new Map() },
  settle: () => {},
};
const outcomes = {
  runTask: { outputs: [writtenOutcome], error: new Error("The store worker failed to start.") },
} satisfies Record<string, ActorOutcome<StoreTaskOutcome>>;
const writeTask: StoreTask = {
  type: "write",
  run: async () => ({ revisions: EMPTY_REVISIONS, settle: () => {} }),
  fail: () => {},
};
const queueTask = { type: "task.queued", task: writeTask } as const;
const queueWrite = { type: "write.queued", projects: [], createTask: () => writeTask } as const;
const MAX_QUEUED_TASKS = 2;

function describeEvent(event: { type: string; output?: unknown }) {
  if (event === queueTask) {
    return "task.queued";
  }

  if (event === queueWrite) {
    return "write.queued";
  }

  if (event.output === writtenOutcome) {
    return "done(runTask) with a written project";
  }

  return undefined;
}

function toModelState(snapshot: SnapshotFrom<typeof storeQueueMachine>) {
  return {
    value: snapshot.value,
    tasks: snapshot.context.tasks.length,
    known: snapshot.context.revisions.known.size,
  };
}

function startStoreQueue() {
  const settler = createActorSettler();
  const machine = storeQueueMachine.provide({ actors: { runTask: settler.fromOutcome(outcomes.runTask) } });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(storeQueueMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    ...(snapshot.context.tasks.length < MAX_QUEUED_TASKS ? [queueTask, queueWrite] : []),
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("store queue machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startStoreQueue();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
