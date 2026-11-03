import { assign, createActor, fromPromise, setup, toPromise } from "xstate";

import { declareType } from "../machines/declare-type.ts";
import type {
  ComparisonOptions,
  ComparisonResults,
  ComparisonSide,
  ExecutionResult,
  QuickjsRunner,
} from "./contract.ts";
import { notifyObserver, toExecutionError } from "./errors.ts";

interface CoordinatorInput<Result> {
  manifests: Record<ComparisonSide, unknown>;
  mode?: "parallel" | "sequential";
  signal?: AbortSignal;
  onSide?: (side: ComparisonSide, result: Result) => void;
}
type ComparisonContext<Result> = CoordinatorInput<Result> & {
  results: Record<ComparisonSide, Result | null>;
  controllers: Record<ComparisonSide, AbortController>;
};
type SideInput = { side: ComparisonSide; manifest: unknown; controller: AbortController };

export const COMPARISON_ACTOR_IDS = { a: "comparisonA", b: "comparisonB" } as const;

function createCancelledResult(): ExecutionResult {
  return { status: "cancelled", error: { phase: "admission", message: "Comparison cancelled before side started" } };
}

/** Coordinate two owned executions. The injected actor must settle only after releasing its child. */
export function createComparisonMachine(executeSide: (input: SideInput) => Promise<ExecutionResult>) {
  return createCoordinatorMachine<ExecutionResult>({
    executeSide,
    cancelPending: () => createCancelledResult(),
    failSide: (cause) => ({ status: "error", error: toExecutionError({ cause, phase: "supervision" }) }),
  });
}

/** Coordinate owned children with shared scheduling, cancellation, and independent publication. */
export function createCoordinatorMachine<Result>({
  executeSide,
  cancelPending,
  failSide,
}: {
  executeSide: (input: SideInput) => Promise<Result>;
  cancelPending: (side: ComparisonSide) => Result;
  failSide: (cause: unknown, side: ComparisonSide) => Result;
}) {
  const machineSetup = setup({
    types: {
      context: declareType<ComparisonContext<Result>>(),
      input: declareType<CoordinatorInput<Result>>(),
      events: declareType<{ type: "comparison.cancel" }>(),
      output: declareType<Record<ComparisonSide, Result>>(),
    },
    actors: { executeSide: fromPromise<Result, SideInput>(({ input }) => executeSide(input)) },
    guards: { aborted: ({ context }) => context.signal?.aborted === true },
    actions: {
      abortSide: ({ context }, { side }: { side: ComparisonSide }) => context.controllers[side].abort(),
      cancelPending: assign(({ context }, { side }: { side: ComparisonSide }) => ({
        results: { ...context.results, [side]: cancelPending(side) },
      })),
      finishSide: assign(({ context }, { side, result }: { side: ComparisonSide; result: Result }) => ({
        results: { ...context.results, [side]: result },
      })),
      publishSide: ({ context }, { side }: { side: ComparisonSide }) => {
        const result = context.results[side];

        if (result) {
          notifyObserver(context.onSide, side, result);
        }
      },
    },
  });

  function createSideState(side: ComparisonSide) {
    return machineSetup.createStateConfig({
      initial: "pending",
      states: {
        pending: {
          always: [
            { guard: "aborted", target: "settled", actions: { type: "cancelPending", params: { side } } },
            {
              guard: ({ context }) => side === "a" || context.mode !== "sequential" || context.results.a !== null,
              target: "active",
            },
          ],
          on: { "comparison.cancel": { target: "settled", actions: { type: "cancelPending", params: { side } } } },
        },
        active: {
          initial: "executing",
          invoke: {
            id: COMPARISON_ACTOR_IDS[side],
            src: "executeSide",
            input: ({ context }) => ({
              side,
              manifest: context.manifests[side],
              controller: context.controllers[side],
            }),
            onDone: {
              target: "settled",
              actions: { type: "finishSide", params: ({ event }) => ({ side, result: event.output }) },
            },
            onError: {
              target: "settled",
              actions: {
                type: "finishSide",
                params: ({ event }) => ({
                  side,
                  result: failSide(event.error, side),
                }),
              },
            },
          },
          states: {
            executing: {
              on: { "comparison.cancel": { target: "cancelling", actions: { type: "abortSide", params: { side } } } },
            },
            cancelling: {},
          },
        },
        settled: { type: "final", entry: { type: "publishSide", params: { side } } },
      },
    });
  }

  return machineSetup.createMachine({
    id: "quickjsComparison",
    type: "parallel",
    context: ({ input }) => ({
      ...input,
      results: { a: null, b: null },
      controllers: { a: new AbortController(), b: new AbortController() },
    }),
    states: { a: createSideState("a"), b: createSideState("b") },
    output: ({ context }): Record<ComparisonSide, Result> => {
      if (!context.results.a || !context.results.b) {
        throw new Error("Comparison completed without both side results");
      }

      return { a: context.results.a, b: context.results.b };
    },
  });
}

/** Deliver each side after release; sequential mode allocates B only after A has settled. */
export async function runComparison({
  createChild,
  manifests,
  options = {},
}: {
  createChild: (manifest: unknown, signal: AbortSignal) => QuickjsRunner | Promise<QuickjsRunner>;
  manifests: Record<ComparisonSide, unknown>;
  options?: ComparisonOptions;
}): Promise<ComparisonResults> {
  const machine = createComparisonMachine(async ({ side, manifest, controller }) => {
    let child: QuickjsRunner;

    try {
      child = await createChild(manifest, controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) {
        return createCancelledResult();
      }

      throw cause;
    }

    try {
      return controller.signal.aborted
        ? createCancelledResult()
        : await child.run(manifest, {
            signal: controller.signal,
            debug: options.debug,
            timeoutMs: options.timeoutMs,
            queryPlans: options.queryPlans,
            onMessage: options.onMessage,
            onPhase: (phase) => notifyObserver(options.onPhase, side, phase),
          });
    } finally {
      try {
        await child.close();
      } catch (cause) {
        if (options.debug) {
          console.warn("QuickJS comparison child close failed", cause);
        }
      }
    }
  });
  const actor = createActor(machine, { input: { ...options, manifests } });
  const cancel = () => actor.send({ type: "comparison.cancel" });
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    actor.start();

    return await toPromise(actor);
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    actor.stop();
  }
}
