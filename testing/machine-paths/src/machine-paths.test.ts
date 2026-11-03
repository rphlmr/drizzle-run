import { describe, expect, it } from "vitest";
import { assign, createActor, fromPromise, setup, type AnyMachineSnapshot } from "xstate";

import { createActorSettler, getMachinePaths, getSettleEvents, replayMachinePath } from "./machine-paths.ts";

function toModelState(snapshot: AnyMachineSnapshot) {
  return { value: snapshot.value, ...snapshot.context };
}

describe("getMachinePaths", () => {
  it("should retain event variants containing callbacks", () => {
    const machine = setup({
      types: { events: {} as { type: "run.request"; prepare?: () => void } },
    }).createMachine({
      initial: "idle",
      states: {
        idle: {
          on: {
            "run.request": [
              { guard: ({ event }) => event.prepare !== undefined, target: "preparing" },
              { target: "running" },
            ],
          },
        },
        preparing: {},
        running: {},
      },
    });
    const plainRequest = { type: "run.request" };
    const preparedRequest = { type: "run.request", prepare: () => undefined };

    const paths = getMachinePaths(machine, {
      toModelState,
      events: () => [plainRequest, preparedRequest],
    });

    expect(paths.some((path) => path.steps.at(-1)?.event === plainRequest && path.state.matches("running"))).toBe(true);
    expect(paths.some((path) => path.steps.at(-1)?.event === preparedRequest && path.state.matches("preparing"))).toBe(
      true,
    );
  });

  it.each(["done", "error"] as const)("should model actor identity for %s events", async (outcomeType) => {
    const outcome = { outputs: outcomeType === "done" ? [42] : [], error: new Error("Job failed") };
    const machine = setup({ actors: { job: fromPromise(async () => 42) } }).createMachine({
      initial: "running",
      states: {
        running: {
          invoke: {
            id: "job",
            src: "job",
            onDone: [
              { guard: ({ event }) => event.actorId === "job", target: "identified" },
              { target: "missingIdentity" },
            ],
            onError: [
              { guard: ({ event }) => event.actorId === "job", target: "identified" },
              { target: "missingIdentity" },
            ],
          },
        },
        identified: {},
        missingIdentity: {},
      },
    });
    const paths = getMachinePaths(machine, {
      toModelState,
      events: (snapshot) => getSettleEvents(snapshot, { job: outcome }),
    });

    for (const path of paths) {
      const settler = createActorSettler();
      const actor = createActor(machine.provide({ actors: { job: settler.fromOutcome(outcome) } })).start();

      try {
        expect(path.state.matches("identified")).toBe(true);
        await replayMachinePath(path, { actor, settler, toModelState });
      } finally {
        actor.stop();
      }
    }

    expect(paths.length).toBeGreaterThan(0);
  });

  it.each(["with_context", "value_only"])("should settle once and restart with %s model state", async (model) => {
    const outcome = { outputs: [42] };
    const machine = setup({
      types: { context: {} as { finished: boolean }, events: {} as { type: "job.restart" } },
      actors: { job: fromPromise(async () => 42) },
    }).createMachine({
      context: { finished: false },
      initial: "running",
      states: {
        running: {
          entry: assign({ finished: false }),
          invoke: { id: "job", src: "job", onDone: { actions: assign({ finished: true }) } },
          on: { "job.restart": { target: "running", reenter: true } },
        },
      },
    });
    const paths = getMachinePaths(machine, {
      toModelState: model === "with_context" ? toModelState : (snapshot) => snapshot.value,
      events: (snapshot) => [{ type: "job.restart" }, ...getSettleEvents(snapshot, { job: outcome })],
      limit: 30,
    });

    for (const path of paths) {
      const settler = createActorSettler();
      const actor = createActor(machine.provide({ actors: { job: settler.fromOutcome(outcome) } })).start();

      try {
        await replayMachinePath(path, { actor, settler, toModelState });

        expect(getSettleEvents(actor.getSnapshot(), { job: outcome })).toHaveLength(
          actor.getSnapshot().context.finished ? 0 : 1,
        );
      } finally {
        actor.stop();
      }
    }
  });
});
