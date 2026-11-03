import type { ComparisonHandle, Executor, QueryPlansSettings, Runtime } from "@drizzle-run/core/contracts";
import { pairSide } from "@drizzle-run/core/pair";
import type { PairManifest, PairSideIndex } from "@drizzle-run/core/pair";
import { createActor, setup } from "xstate";

import type { ComparisonOptions, PairSideInput } from "./comparison-contract.ts";
import { createComparisonController } from "./comparison.ts";
import { declareType } from "./machine-utils.ts";

/** The runtime owns execution; runSide connects optional per-side history and subscriptions. */
export interface RuntimeComparisonOptions extends Omit<ComparisonOptions, "runSide"> {
  getRuntime(): Pick<Runtime, "createComparison"> | Promise<Pick<Runtime, "createComparison">>;
  queryPlans?: QueryPlansSettings;
  getQueryPlans?(): QueryPlansSettings | undefined;
  /** Attach history with the captured pair and this side's SDK execution port. */
  runSide(input: PairSideInput & { runtime: Executor }): ReturnType<ComparisonOptions["runSide"]>;
}

const readinessMachine = setup({
  types: { events: declareType<{ type: "side.ready"; side: PairSideIndex }>() },
  actions: { startComparison() {} },
}).createMachine({
  initial: "waiting",
  states: {
    waiting: {
      type: "parallel",
      states: {
        a: {
          initial: "waiting",
          states: {
            waiting: { on: { "side.ready": { guard: ({ event }) => event.side === 0, target: "ready" } } },
            ready: { type: "final" },
          },
        },
        b: {
          initial: "waiting",
          states: {
            waiting: { on: { "side.ready": { guard: ({ event }) => event.side === 1, target: "ready" } } },
            ready: { type: "final" },
          },
        },
      },
      onDone: "ready",
    },
    ready: { type: "final", entry: "startComparison" },
  },
});

interface ComparisonRequest {
  manifest: PairManifest;
  comparison: ComparisonHandle;
  ready: ReturnType<typeof createActor<typeof readinessMachine>>;
  settlement: Promise<PromiseSettledResult<void>>;
}

/**
 * Preserve independent side histories while Runtime owns execution and aggregate cleanup.
 * An aggregate cleanup failure closes admission and rejects pending operations, including disposal.
 */
export function createRuntimeComparisonController(options: RuntimeComparisonOptions) {
  const requests = new Map<string, Promise<ComparisonRequest | undefined>>();

  return createComparisonController({
    getManifest: options.getManifest,
    execution: "parallel",
    async settle(requestId) {
      try {
        const request = await requests.get(requestId);

        if (!request) {
          return;
        }

        try {
          const settled = await request.settlement;

          if (settled.status === "rejected") {
            throw settled.reason;
          }
        } finally {
          request.ready.stop();
        }
      } finally {
        requests.delete(requestId);
      }
    },
    async runSide(input) {
      let request = requests.get(input.requestId);

      if (!request) {
        request = (async () => {
          const current = input.manifest ?? options.getManifest?.();

          if (!current) {
            throw new Error("Runtime comparison requires a pair manifest");
          }

          const manifest = structuredClone(current);
          const runtime = await options.getRuntime();

          if (input.comparisonSignal.aborted) {
            return;
          }

          const comparison = runtime.createComparison(
            { a: pairSide(manifest, 0), b: pairSide(manifest, 1) },
            {
              execution: options.execution,
              signal: input.comparisonSignal,
              queryPlans: options.getQueryPlans?.() ?? options.queryPlans,
            },
          );
          const ready = createActor(
            readinessMachine.provide({ actions: { startComparison: () => comparison.start() } }),
          ).start();
          const settlement: ComparisonRequest["settlement"] = comparison.result.then(
            (): PromiseFulfilledResult<void> => ({ status: "fulfilled", value: undefined }),
            (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
          );

          return { manifest, comparison, ready, settlement };
        })().catch((cause: unknown) => {
          requests.delete(input.requestId);
          throw cause;
        });
        requests.set(input.requestId, request);
      }

      const attached = await request;

      if (!attached) {
        return "cancelled";
      }

      const { manifest, comparison, ready } = attached;

      if (input.signal.aborted) {
        await comparison.cancel();

        return "cancelled";
      }

      const side = input.side === 0 ? "a" : "b";
      const handle = comparison.sides[side];

      try {
        return await options.runSide({
          ...input,
          manifest,
          runtime: {
            createRun: () => ({
              ...handle,
              start: () => ready.send({ type: "side.ready", side: input.side }),
              cancel: () => comparison.cancel(),
            }),
          },
        });
      } catch (cause) {
        await comparison.cancel();
        throw cause;
      } finally {
        const snapshot = ready.getSnapshot();

        if (!snapshot.matches("ready") && !snapshot.matches({ waiting: { [side]: "ready" } })) {
          await comparison.cancel();
        }
      }
    },
  });
}
