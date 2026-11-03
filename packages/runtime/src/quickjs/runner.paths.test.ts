import {
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, fromCallback, SimulatedClock, type SnapshotFrom } from "xstate";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { makeExecutionAssets, makeExecutionResult, makeExecutionWorker } from "../../test/quickjs/runner-fixture.ts";
import { createRunnerMachine } from "./runner.ts";
import type { ExecutionWorker } from "./worker-contract.ts";

describe("runner machine paths", () => {
  const machine = createRunnerMachine();
  const worker = makeExecutionWorker();
  const outcomes = {
    acquire: { outputs: [worker], error: new Error("acquisition failed") },
    terminate: { outputs: [undefined], error: new Error("termination failed") },
  };
  const input = { assets: makeExecutionAssets(), createWorker: () => worker };
  const toModelState = (snapshot: SnapshotFrom<typeof machine>) => ({
    value: snapshot.value,
    phase: snapshot.context.phase,
    result: snapshot.context.result?.status,
    ownsWorker: snapshot.context.worker !== null,
    ownsResources: snapshot.context.resources !== null,
  });
  const paths = getMachinePaths(machine, {
    input: () => input,
    limit: 2_000,
    toModelState,
    events: (snapshot) => [
      { type: "run.request", request: { manifest: makeExecutionManifest(), timeoutMs: 100, resolve() {} } },
      { type: "runner.close", reply() {} },
      { type: "execution.phase", phase: "run" },
      { type: "execution.result", result: makeExecutionResult() },
      { type: "execution.cancel" },
      { type: "execution.fail", cause: new Error("transport failed") },
      ...(snapshot.matches({ running: "executing" })
        ? [{ type: "xstate.after.executionDeadline.quickjsRunner.running.executing" }]
        : []),
      ...getSettleEvents(snapshot, outcomes),
    ],
  });

  it("should retain the admission, cancellation, deadline and termination transition contract", () => {
    expect(paths.length).toBeGreaterThan(50);
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should replay ${path.description}`, async () => {
      const settler = createActorSettler();
      const clock = new SimulatedClock();
      const actor = createActor(
        machine.provide({
          actors: {
            acquire: settler.fromOutcome(outcomes.acquire),
            terminate: settler.fromOutcome<void, ExecutionWorker>(outcomes.terminate),
            observe: fromCallback(() => {}),
          },
        }),
        { input: () => input, clock },
      ).start();

      try {
        await expect(
          replayMachinePath(path, {
            actor,
            settler,
            toModelState,
            async advance() {
              clock.increment(100);
            },
          }),
        ).resolves.toBeUndefined();
      } finally {
        actor.stop();
      }
    });
  }
});
