import { describe, expect, it } from "vitest";
import type { SnapshotFrom } from "xstate";
import { createActor, waitFor } from "xstate";
import { getAdjacencyMap, getShortestPaths } from "xstate/graph";

import type { ExecutionPhase } from "./contract.ts";
import { executionPhases } from "./contract.ts";
import { createPhaseMachine, PHASE_ACTOR_ID } from "./phases.ts";

describe("createPhaseMachine", () => {
  it("should route every phase failure through cleanup without replacing the execution error", async () => {
    for (const failedPhase of [null, ...executionPhases]) {
      const visited: ExecutionPhase[] = [];
      const actor = createActor(
        createPhaseMachine(async (phase) => {
          visited.push(phase);

          if (phase === failedPhase || phase === "cleanup") {
            throw new Error(`${phase} failed`);
          }
        }),
      ).start();
      await waitFor(actor, (snapshot) => snapshot.status === "done");

      expect(visited.at(-1)).toBe("cleanup");
      expect(actor.getSnapshot().context.error?.phase ?? null).toBe(failedPhase === "cleanup" ? null : failedPhase);
      actor.stop();
    }
  });

  it("should replay every bounded shortest path with controlled phase actors", async () => {
    const machine = createPhaseMachine(() => new Promise(() => {}));
    const options = {
      limit: 2_000,
      events: [
        { type: `xstate.done.actor.${PHASE_ACTOR_ID}`, output: undefined },
        { type: `xstate.error.actor.${PHASE_ACTOR_ID}`, error: new Error("failed") },
      ],
      serializeState: (snapshot: SnapshotFrom<typeof machine>) =>
        JSON.stringify([snapshot.value, snapshot.context.error?.phase]),
    };
    const paths = getShortestPaths(machine, options);

    expect(paths.length).toBeGreaterThan(executionPhases.length);
    expect(Object.keys(getAdjacencyMap(machine, options))).toHaveLength(paths.length);
    expect(JSON.parse(JSON.stringify(machine.config.states))).toMatchSnapshot();

    for (const path of paths) {
      const pending = new Map<string, PromiseWithResolvers<void>>();
      const actor = createActor(
        createPhaseMachine((phase) => {
          const work = Promise.withResolvers<void>();
          pending.set(phase, work);

          return work.promise;
        }),
      ).start();

      for (const { event } of path.steps) {
        if (event.type === "xstate.init") {
          continue;
        }

        const phase = actor.getSnapshot().value;
        const work = pending.get(phase);

        if (!work) {
          throw new Error(`Missing pending phase: ${phase}`);
        }

        if (event.type.startsWith("xstate.done")) {
          work.resolve();
        } else {
          work.reject(new Error("failed"));
        }

        await waitFor(actor, (snapshot) => snapshot.value !== phase);
      }

      expect(options.serializeState(actor.getSnapshot())).toBe(options.serializeState(path.state));
      actor.stop();
    }
  });
});
