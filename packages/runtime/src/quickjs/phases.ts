import type { ErrorActorEvent } from "xstate";
import { assign, fromPromise, setup } from "xstate";

import { declareType } from "../machines/declare-type.ts";
import type { ExecutionError, ExecutionPhase } from "./contract.ts";
import { toExecutionError } from "./errors.ts";

export const PHASE_ACTOR_ID = "executionPhase";

function createPhaseState(phase: ExecutionPhase, next: string) {
  return {
    invoke: {
      id: PHASE_ACTOR_ID,
      src: "executePhase" as const,
      input: phase,
      onDone: next,
      onError: {
        target: phase === "cleanup" ? "settled" : "cleanup",
        actions: {
          type: "recordFailure" as const,
          params: ({ event }: { event: ErrorActorEvent }) => ({ phase, cause: event.error }),
        },
      },
    },
  };
}

/** Invoke phases in order; execution failure always enters cleanup without losing the original error. */
export function createPhaseMachine(executePhase: (phase: ExecutionPhase) => Promise<void>) {
  return setup({
    types: { context: declareType<{ error: ExecutionError | null }>() },
    actors: { executePhase: fromPromise<void, ExecutionPhase>(({ input }) => executePhase(input)) },
    actions: {
      recordFailure: assign(({ context }, { phase, cause }: { phase: ExecutionPhase; cause: unknown }) => ({
        error: phase === "cleanup" ? context.error : toExecutionError({ cause, phase }),
      })),
    },
  }).createMachine({
    initial: "compile",
    context: { error: null },
    states: {
      compile: createPhaseState("compile", "setup"),
      setup: createPhaseState("setup", "schema"),
      schema: createPhaseState("schema", "sql"),
      sql: createPhaseState("sql", "database"),
      database: createPhaseState("database", "seed"),
      seed: createPhaseState("seed", "run"),
      run: createPhaseState("run", "inspect"),
      inspect: createPhaseState("inspect", "plan"),
      plan: createPhaseState("plan", "cleanup"),
      cleanup: createPhaseState("cleanup", "settled"),
      settled: { type: "final" },
    },
    output: ({ context }) => context.error,
  });
}
