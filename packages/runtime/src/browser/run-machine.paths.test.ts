import { SERIALIZED_UNDEFINED } from "@drizzle-run/core/contracts";
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

import { BackendError } from "../execution-contract.ts";
import { createRunMachine, type ExecutionOutput, type RunMachinePorts } from "./run-machine.ts";
import type { ExecutionOutcome } from "./run.ts";

const DONE_PREFIX = "xstate.done.actor.";

const gracefulCleanup: ExecutionOutcome["cleanup"] = { guest: { mode: "graceful" }, database: { mode: "graceful" } };
const succeededOutcome: ExecutionOutcome = {
  report: { kind: "report", outcome: "succeeded", value: SERIALIZED_UNDEFINED },
  cleanup: gracefulCleanup,
};
const failedOutcome: ExecutionOutcome = { failure: new Error("The guest crashed."), cleanup: gracefulCleanup };

const succeeded: ExecutionOutput = { outcome: succeededOutcome, database: { status: "absent" } };
const failed: ExecutionOutput = { outcome: failedOutcome, database: { status: "absent" } };
const invalidReport: ExecutionOutput = {
  outcome: succeededOutcome,
  database: {
    status: "invalid",
    error: new BackendError("invalid_report", "Database report does not match the selected dialect.", {
      phase: "inspect",
    }),
  },
};

const executeOutcome: ActorOutcome<ExecutionOutput> = {
  outputs: [succeeded, failed, invalidReport],
  error: new Error("The execution worker could not start."),
};
const outcomes = { execute: executeOutcome };

const outputLabels = new Map<unknown, string>([
  [succeeded, "succeeded"],
  [failed, "with a failed execution"],
  [invalidReport, "with an invalid database report"],
]);

function describeEvent(event: ModelEvent) {
  if (event.type.startsWith(DONE_PREFIX) && outputLabels.has(event.output)) {
    return `done(${event.type.slice(DONE_PREFIX.length)}) ${outputLabels.get(event.output)}`;
  }

  return undefined;
}

function createPorts() {
  return {
    dialect: "postgresql",
    execute: vi.fn(async () => succeededOutcome),
    recordPhase: vi.fn(),
    finishCancelledBeforeStart: vi.fn(),
    finishCancelled: vi.fn(),
    finishFailed: vi.fn(),
    finishWithInvalidReport: vi.fn(),
    finishSucceeded: vi.fn(),
  } satisfies RunMachinePorts;
}

const runMachine = createRunMachine(createPorts());

function toModelState(snapshot: SnapshotFrom<typeof runMachine>) {
  return { value: snapshot.value };
}

function startRunMachine() {
  const settler = createActorSettler();
  const machine = createRunMachine(createPorts()).provide({
    actors: { execute: settler.fromOutcome(outcomes.execute) },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(runMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    { type: "run.start", startedAt: 10 },
    { type: "run.cancel" },
    { type: "execution.ready", initializationDurationMs: 5 },
    { type: "execution.phase", phase: "compile", status: "running" },
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("browser run machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startRunMachine();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
