import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { pairManifest } from "@drizzle-run/test-fixtures/pair";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { pairRunMachine, type PairSideRun } from "./pair-run.ts";

const DONE_PREFIX = "xstate.done.actor.";

const succeededSide: PairSideRun = { outcome: "succeeded" };
const failedSide: PairSideRun = { outcome: "failed", error: "The side failed." };
const cancelledSide: PairSideRun = { outcome: "cancelled" };

const prepareOutcome: ActorOutcome<void> = {
  outputs: [undefined],
  error: new Error("The code could not be formatted."),
};
const runSideOutcome: ActorOutcome<PairSideRun> = {
  outputs: [succeededSide, failedSide, cancelledSide],
  error: new Error("The side's runtime crashed."),
};
const settlementOutcome: ActorOutcome<void> = { outputs: [undefined] };
const outcomes = { prepare: prepareOutcome, runSide: runSideOutcome, settle: settlementOutcome };

const outputLabels = new Map<unknown, string>([
  [succeededSide, "succeeded"],
  [failedSide, "failed"],
  [cancelledSide, "cancelled"],
]);

const request = { requestId: "request-1", requester: "test" } as const;
const requestRun = { type: "run.request", ...request } as const;
const requestRunWithPrepare = { type: "run.request", ...request, prepare: async () => undefined } as const;
const seededPair = pairManifest(undefined, { seed: true });
const requestRunWithSeedProblem = {
  type: "run.request",
  ...request,
  manifest: { ...seededPair, files: { ...seededPair.files, "seed.ts": 'import "zod";\n' } },
} as const;
const cancelAny = { type: "run.cancel" } as const;
const cancelCurrent = { type: "run.cancel", requestId: request.requestId } as const;
const cancelOther = { type: "run.cancel", requestId: "request-2" } as const;

const eventLabels = new Map<object, string>([
  [requestRun, "run.request"],
  [requestRunWithPrepare, "run.request with a prepare step"],
  [requestRunWithSeedProblem, "run.request whose seed imports another package"],
  [cancelAny, "run.cancel"],
  [cancelCurrent, "run.cancel for the current request"],
  [cancelOther, "run.cancel for another request"],
]);

function describeEvent(event: ModelEvent) {
  const label = eventLabels.get(event);

  if (label !== undefined) {
    return label;
  }

  if (event.type.startsWith(DONE_PREFIX) && outputLabels.has(event.output)) {
    return `done(${event.type.slice(DONE_PREFIX.length)}) ${outputLabels.get(event.output)}`;
  }

  return undefined;
}

function toModelState(snapshot: SnapshotFrom<typeof pairRunMachine>) {
  const [first, second] = snapshot.context.runs;

  return { value: snapshot.value, first: first?.outcome ?? "none", second: second?.outcome ?? "none" };
}

function startPairRun(machine: typeof pairRunMachine) {
  const settler = createActorSettler();
  const provided = machine.provide({
    actors: {
      prepare: settler.fromOutcome(outcomes.prepare),
      runSide: settler.fromOutcome(outcomes.runSide),
      settle: settler.fromOutcome(outcomes.settle),
    },
  });

  return { actor: createActor(provided).start(), settler };
}

describe.each([
  { execution: "parallel", hasSettlement: false },
  { execution: "sequential", hasSettlement: false },
  { execution: "parallel", hasSettlement: true },
  { execution: "sequential", hasSettlement: true },
] as const)("pair run machine paths ($execution, shared settlement $hasSettlement)", ({ execution, hasSettlement }) => {
  const machine = pairRunMachine.provide({
    guards: { runsInParallel: () => execution === "parallel", hasSettlement: () => hasSettlement },
  });
  const paths = getMachinePaths(machine, {
    toModelState,
    describeEvent,
    events: (snapshot) => [
      requestRun,
      requestRunWithPrepare,
      requestRunWithSeedProblem,
      cancelAny,
      cancelCurrent,
      cancelOther,
      ...getSettleEvents(snapshot, outcomes),
    ],
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startPairRun(machine);

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
