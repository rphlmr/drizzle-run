import {
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
  type ActorOutcome,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { makeRuntimeDependencies } from "../../test/quickjs/runtime-fixture.ts";
import { createRuntimeMachine } from "./runtime.ts";
import { selectGuest } from "./selection.ts";

describe("QuickJS runtime paths", () => {
  it.each(["retained", "on_demand"] as const)(
    "should replay every bounded %s lifecycle transition",
    async (preparation) => {
      const dependencies = makeRuntimeDependencies(preparation === "on_demand" ? { preparation } : {});
      const machine = createRuntimeMachine(dependencies);
      const manifest = makeExecutionManifest();
      const task = {
        manifest,
        selection: selectGuest(manifest),
        controller: new AbortController(),
        execute: async () => {},
        complete() {},
        fail() {},
      };
      const runner = await dependencies.createRunner(task.selection, task.controller.signal);
      const capabilities = await dependencies.checkCapabilities();
      const failure = new Error("controlled failure");
      const voidOutcome: ActorOutcome<void> = { outputs: [undefined], error: failure };
      const outcomes = {
        check: { outputs: [capabilities], error: failure },
        load: { outputs: [runner], error: failure },
        work: voidOutcome,
        close: voidOutcome,
      };
      function toModelState(snapshot: SnapshotFrom<typeof machine>) {
        return {
          value: snapshot.value,
          queued: snapshot.context.requests.length,
          active: Boolean(snapshot.context.task),
          key: snapshot.context.key,
          disposition: snapshot.context.disposition,
          failure: Boolean(snapshot.context.failure),
          error: Boolean(snapshot.context.error),
        };
      }
      const paths = getMachinePaths(machine, {
        limit: 5_000,
        toModelState,
        events: (snapshot) => [
          ...(snapshot.context.requests.length === 0 ? [{ type: "task.request", task }] : []),
          { type: "task.cancel", task },
          { type: "runtime.dispose" },
          ...getSettleEvents(snapshot, outcomes),
        ],
      });
      expect(paths.length).toBeGreaterThan(50);
      expect(toTransitionTable(paths)).toMatchSnapshot();

      for (const path of paths) {
        const settler = createActorSettler();
        const actor = createActor(
          machine.provide({
            actors: {
              check: settler.fromOutcome(outcomes.check),
              load: settler.fromOutcome(outcomes.load),
              work: settler.fromOutcome(outcomes.work),
              close: settler.fromOutcome(outcomes.close),
            },
          }),
        ).start();

        await replayMachinePath(path, { actor, settler, toModelState });
        actor.stop();
      }
    },
  );
});
