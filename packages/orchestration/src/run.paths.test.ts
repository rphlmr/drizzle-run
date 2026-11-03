import type { RunResult } from "@drizzle-run/core/contracts";
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
import { createActor, fromCallback, type SnapshotFrom } from "xstate";

import { RUN_WATCHDOG_MS, runMachine, type RunCode, type RunRuntime, type RunSubmission } from "./run.ts";

const DONE_PREFIX = "xstate.done.actor.";

const runtime = {
  createRun: () => {
    throw new Error("The path test never creates a runtime run.");
  },
} satisfies RunRuntime;
const submission: RunSubmission = { manifest: projectManifest("sqlite"), revision: 1, debug: false };
const preparedCode: RunCode = { manifest: projectManifest("sqlite"), revision: 2 };
const succeeded: RunResult = fakeRunResult("succeeded", { target: { dialect: "sqlite" } });
const failed: RunResult = fakeRunResult("failed", { target: { dialect: "sqlite" } });

const prepareOutcome: ActorOutcome<RunCode> = {
  outputs: [preparedCode],
  error: new Error("The code could not be formatted."),
};
const outcomes = { prepare: prepareOutcome };

const request = { requestId: "request-1", requester: "test" } as const;
const requestRun = { type: "run.request", ...request, input: { runtime, submission } } as const;
const requestRunWithPrepare = {
  type: "run.request",
  ...request,
  input: { runtime, submission, prepare: async () => preparedCode },
} as const;
const replayRun = { type: "run.replay", submission, result: succeeded } as const;
const cancelAny = { type: "run.cancel" } as const;
const cancelCurrent = { type: "run.cancel", requestId: request.requestId } as const;
const cancelOther = { type: "run.cancel", requestId: "request-2" } as const;
const viewFirstRun = { type: "run.view", run: 1 } as const;
const viewUnknownRun = { type: "run.view", run: 99 } as const;
const reportExecuting = {
  type: "execution.state",
  snapshot: { state: "running", status: "active", sequence: 1, elapsedMs: 0 },
} as const;
const reportStarting = {
  type: "execution.state",
  snapshot: { state: "starting_guest", status: "active", sequence: 1, elapsedMs: 0 },
} as const;
const reportEvent = {
  type: "execution.event",
  event: { type: "log", sequence: 1, payload: { sequence: 1, phase: "run", level: "info", values: [] } },
} as const;
const reportSucceeded = { type: "execution.done", result: succeeded } as const;
const reportFailed = { type: "execution.done", result: failed } as const;
const reportCancelFailed = { type: "execution.cancel.failed", error: "The worker did not answer." } as const;
const reportExecutionFailed = { type: "execution.failed", error: "The worker crashed." } as const;
const watchdog = { type: "xstate.after.runWatchdog.run.running.guest.executing" } as const;

const eventLabels = new Map<object, string>([
  [requestRun, "run.request"],
  [requestRunWithPrepare, "run.request with a prepare step"],
  [cancelAny, "run.cancel"],
  [cancelCurrent, "run.cancel for the current request"],
  [cancelOther, "run.cancel for another request"],
  [viewFirstRun, "run.view the first run"],
  [viewUnknownRun, "run.view an unknown run"],
  [reportExecuting, "execution.state running"],
  [reportStarting, "execution.state starting"],
  [reportSucceeded, "execution.done succeeded"],
  [reportFailed, "execution.done failed"],
  [watchdog, "after the run watchdog"],
]);

function describeEvent(event: ModelEvent) {
  return (
    eventLabels.get(event) ??
    (event.type.startsWith(DONE_PREFIX) ? `done(${event.type.slice(DONE_PREFIX.length)}) prepared code` : undefined)
  );
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function toModelState(snapshot: SnapshotFrom<typeof runMachine>) {
  return {
    value: snapshot.value,
    hasShownRun: snapshot.context.runs.some((record) => record.number === snapshot.context.shown),
  };
}

function startRun() {
  const settler = createActorSettler();
  const machine = runMachine.provide({
    actors: { prepare: settler.fromOutcome(outcomes.prepare), execute: fromCallback(() => undefined) },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(runMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    requestRun,
    requestRunWithPrepare,
    replayRun,
    cancelAny,
    cancelCurrent,
    cancelOther,
    viewFirstRun,
    viewUnknownRun,
    reportExecuting,
    reportStarting,
    reportEvent,
    reportSucceeded,
    reportFailed,
    reportCancelFailed,
    reportExecutionFailed,
    ...(snapshot.matches({ running: { guest: "executing" } }) ? [watchdog] : []),
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("run machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startRun();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(RUN_WATCHDOG_MS),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
