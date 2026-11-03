import {
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import type { SnapshotFrom } from "xstate";
import { createActor } from "xstate";

import { makeExecutionResult } from "../../test/quickjs/runner-fixture.ts";
import { createComparisonMachine } from "./comparison.ts";

describe("comparison machine paths", () => {
  for (const mode of ["parallel", "sequential"] as const) {
    const machine = createComparisonMachine(() => new Promise(() => {}));
    const outcome = { outputs: [makeExecutionResult()], error: new Error("side failed") };
    const outcomes = { executeSide: outcome };
    const input = { mode, manifests: { a: {}, b: {} } };
    const toModelState = (snapshot: SnapshotFrom<typeof machine>) => ({
      value: snapshot.value,
      a: snapshot.context.results.a?.status,
      b: snapshot.context.results.b?.status,
    });
    const paths = getMachinePaths(machine, {
      input,
      limit: 2_000,
      toModelState,
      events: (snapshot) => [{ type: "comparison.cancel" }, ...getSettleEvents(snapshot, outcomes)],
    });

    it(`should retain the ${mode} transition contract`, () => {
      expect(paths.length).toBeGreaterThan(10);
      expect(toTransitionTable(paths)).toMatchSnapshot();
    });

    for (const path of paths) {
      it(`should replay ${mode} ${path.description}`, async () => {
        const settler = createActorSettler();
        const actor = createActor(machine.provide({ actors: { executeSide: settler.fromOutcome(outcome) } }), {
          input,
        }).start();

        await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
        actor.stop();
      });
    }
  }
});
