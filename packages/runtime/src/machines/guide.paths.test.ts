import type { RunResult } from "@drizzle-run/core/contracts";
import { parseGuideManifest } from "@drizzle-run/core/guide";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { guideMachine, guideProgressSaverMachine, type GuideProgress, type GuideRunResult } from "./guide.ts";

const PROGRESS_LOAD_TIMEOUT_MS = 5_000;
const DONE_PREFIX = "xstate.done.actor.";

const manifest = parseGuideManifest({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "first-run",
  title: "Your first run",
  project: projectManifest(),
  steps: [
    { type: "walkthrough", id: "01-read", label: "Read", title: "Read the files", body: "Look around.", run: "none" },
    {
      type: "walkthrough",
      id: "02-display",
      label: "Display",
      title: "Show rows",
      body: "Press **Run**.",
      edits: [{ file: "query.ts", replace: { anchor: "// next", with: '$.display("Rows", [1]);' } }],
      run: "required",
    },
    {
      type: "walkthrough",
      id: "03-helper",
      label: "Helper",
      title: "A helper",
      body: "Optional run.",
      edits: [{ file: "helper.ts", write: "export const one = 1;\n" }],
      run: "optional",
    },
  ],
});

const savedOnSecondStep: GuideProgress = {
  guideId: manifest.id,
  stepId: "02-display",
  completed: ["01-read"],
  finished: false,
};
const savedFinished: GuideProgress = {
  guideId: manifest.id,
  stepId: "03-helper",
  completed: ["01-read", "02-display", "03-helper"],
  finished: true,
};
const savedForAnotherGuide = { ...savedOnSecondStep, guideId: "another-guide" };
const succeeded: RunResult = fakeRunResult("succeeded");
const failed: RunResult = fakeRunResult("failed");
const cancelled: RunResult = fakeRunResult("cancelled");

const loadProgressOutcome: ActorOutcome<unknown> = {
  outputs: [undefined, savedOnSecondStep, savedFinished, savedForAnotherGuide],
  error: new Error("The progress store could not be read."),
};
const runStepOutcome: ActorOutcome<GuideRunResult> = {
  outputs: [succeeded, failed, cancelled],
  error: new Error("The run service failed."),
};
const guideOutcomes = { loadProgress: loadProgressOutcome, runStep: runStepOutcome };

const outputLabels = new Map<unknown, string>([
  [undefined, "without saved progress"],
  [savedOnSecondStep, "with progress saved on the second step"],
  [savedFinished, "with a finished guide saved"],
  [savedForAnotherGuide, "with progress saved for another guide"],
  [succeeded, "succeeded"],
  [failed, "failed"],
  [cancelled, "cancelled"],
]);

const selectFirstStep = { type: "step.select", index: 0 } as const;
const selectLastStep = { type: "step.select", index: 2 } as const;
const selectUnknownStep = { type: "step.select", index: 3 } as const;
const progressLoadTimeout = { type: "xstate.after.progressLoadTimeout.guide.loading" } as const;
const eventLabels = new Map<object, string>([
  [selectFirstStep, "step.select the first step"],
  [selectLastStep, "step.select the last step"],
  [selectUnknownStep, "step.select an unknown step"],
  [progressLoadTimeout, "after the progress load timeout"],
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

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function toGuideModelState(snapshot: SnapshotFrom<typeof guideMachine>) {
  const step = manifest.steps[snapshot.context.index];

  return {
    value: snapshot.value,
    index: snapshot.context.index,
    stepCompleted: snapshot.context.completed.includes(step.id),
  };
}

function startGuide() {
  const settler = createActorSettler();
  const machine = guideMachine.provide({
    actors: {
      loadProgress: settler.fromOutcome(guideOutcomes.loadProgress),
      runStep: settler.fromOutcome(guideOutcomes.runStep),
    },
  });

  return { actor: createActor(machine, { input: { manifest } }).start(), settler };
}

const guidePaths = getMachinePaths(guideMachine, {
  input: { manifest },
  toModelState: toGuideModelState,
  describeEvent,
  events: (snapshot) => [
    { type: "run.start" },
    { type: "run.cancel" },
    { type: "step.next" },
    { type: "step.back" },
    selectFirstStep,
    selectLastStep,
    selectUnknownStep,
    { type: "guide.leave" },
    { type: "guide.resume" },
    { type: "guide.restart" },
    ...(snapshot.matches("loading") ? [progressLoadTimeout] : []),
    ...getSettleEvents(snapshot, guideOutcomes),
  ],
});

describe("guide machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(guidePaths)).toMatchSnapshot();
  });

  for (const path of guidePaths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startGuide();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState: toGuideModelState,
          advance: () => advanceTimers(PROGRESS_LOAD_TIMEOUT_MS),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});

const saveProgressOutcome: ActorOutcome<void> = {
  outputs: [undefined],
  error: new Error("The progress store could not be written."),
};
const saverOutcomes = { saveProgress: saveProgressOutcome };

function toSaverModelState(snapshot: SnapshotFrom<typeof guideProgressSaverMachine>) {
  return {
    value: snapshot.value,
    current: snapshot.context.current !== undefined,
    pending: snapshot.context.pending !== undefined,
  };
}

function startSaver() {
  const settler = createActorSettler();
  const machine = guideProgressSaverMachine.provide({
    actors: { saveProgress: settler.fromOutcome(saverOutcomes.saveProgress) },
  });

  return { actor: createActor(machine).start(), settler };
}

const saverPaths = getMachinePaths(guideProgressSaverMachine, {
  toModelState: toSaverModelState,
  events: (snapshot) => [
    { type: "progress.save", progress: savedOnSecondStep },
    ...getSettleEvents(snapshot, saverOutcomes),
  ],
});

describe("guide progress saver machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(saverPaths)).toMatchSnapshot();
  });

  for (const path of saverPaths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startSaver();

      await expect(
        replayMachinePath(path, { actor, settler, toModelState: toSaverModelState }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
