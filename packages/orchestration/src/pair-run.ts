import { getPairSeedProblem, type PairManifest, type PairSideIndex } from "@drizzle-run/core/pair";
import { assign, emit, fromPromise, raise, setup, type SnapshotFrom } from "xstate";

import type { ComparisonOptions, PairSideOutcome, PairSideRun } from "./comparison-contract.ts";
import { declareType, getErrorText } from "./machine-utils.ts";
import type { RunRequest } from "./run.ts";
export type { PairSideInput, PairSideOutcome, PairSideRun } from "./comparison-contract.ts";

export interface PairRunServices extends ComparisonOptions {
  /** Wait for shared execution ownership after both side observers settle. */
  settle?(requestId: string): Promise<void>;
}

/**
 * Public events: `run.request` starts both sides, `run.cancel` stops both. A request may bring the host's step before
 * both sides start, such as formatting their code; a step that throws still runs them. Its signal aborts when the run
 * is cancelled first, and the step should then leave the code alone. A request may also bring the pair to run, which
 * `runSide` receives. A cancel with `requestId` stops only that request's run.
 */
export type PairRunEvent =
  | { type: "controller.dispose" }
  | ({
      type: "run.request";
      prepare?: (signal: AbortSignal) => Promise<void>;
      manifest?: PairManifest;
    } & RunRequest)
  | { type: "run.cancel"; requestId?: string };

/** Emitted once per run, when both sides settled or the run was cancelled */
export type PairRunSettledEvent = RunRequest & {
  type: "run.settled";
  /** Per side; a side that never started because the run was cancelled first is "cancelled". */
  outcomes: readonly [PairSideOutcome, PairSideOutcome];
  /** Per side, with the result or error `runSide` settled with. */
  runs: readonly [PairSideRun, PairSideRun];
};

/**
 * Emitted for a request nothing ran for: one that arrived while both sides ran, or one whose shared seed imports
 * something other than drizzle-seed, the runtime context or project files. `problem` says what to remove.
 */
export type PairRunRefusedEvent = RunRequest & { type: "run.refused" } & (
    | { reason: "busy" }
    | { reason: "seed_problem"; problem: string }
  );

/** What the pair run machine emits */
export type PairRunEmitted = PairRunSettledEvent | PairRunRefusedEvent;

/** The pair run machine's context */
export interface PairRunContext {
  disposeRequested: boolean;
  /** The request the run in progress, or the last run, answers; undefined before the first run. */
  request: RunRequest | undefined;
  /** The pair the request asked to run; undefined for the host's own files. */
  manifest: PairManifest | undefined;
  runs: readonly [PairSideRun | undefined, PairSideRun | undefined];
  prepare: ((signal: AbortSignal) => Promise<void>) | undefined;
  /** Aborted to cancel both sides of the run in progress, which then settle in their own time. */
  cancellation: AbortController | undefined;
}

type SideActorInput = {
  requestId: string;
  side: PairSideIndex;
  cancellation: AbortSignal;
  manifest: PairManifest | undefined;
};

const cancelledRun: PairSideRun = { outcome: "cancelled" };

type RunRequestEvent = Extract<PairRunEvent, { type: "run.request" }>;

/** Why the seed a request would run cannot seed both sides; undefined when it can, or no manifest is known. */
function resolveSeedProblem(
  event: RunRequestEvent,
  services: Pick<PairRunServices, "getManifest">,
): string | undefined {
  const manifest = event.manifest ?? services.getManifest?.();

  return manifest === undefined ? undefined : getPairSeedProblem(manifest);
}

/** The refusal for a request whose seed cannot seed both sides; throws for any other event. */
function toSeedRefusal(event: PairRunEvent, services: Pick<PairRunServices, "getManifest">): PairRunEmitted {
  const problem = event.type === "run.request" ? resolveSeedProblem(event, services) : undefined;

  if (event.type !== "run.request" || problem === undefined) {
    throw new Error(`Expected a run.request with a seed problem to refuse, but got '${event.type}'.`);
  }

  return {
    type: "run.refused",
    requestId: event.requestId,
    requester: event.requester,
    reason: "seed_problem",
    problem,
  };
}

function getRequest(context: PairRunContext): RunRequest {
  if (context.request === undefined) {
    throw new Error("Expected the pair run to hold its request, but it held none.");
  }

  return context.request;
}

function toSettledRuns(runs: PairRunContext["runs"]): PairRunSettledEvent["runs"] {
  return [runs[0] ?? cancelledRun, runs[1] ?? cancelledRun];
}

function toSideInput(context: PairRunContext, side: PairSideIndex): SideActorInput {
  if (context.cancellation === undefined) {
    throw new Error("Expected the pair run to hold its cancellation while a side runs.");
  }

  return {
    requestId: getRequest(context).requestId,
    side,
    cancellation: context.cancellation.signal,
    manifest: context.manifest,
  };
}

function toSideRun(settled: PairSideOutcome | PairSideRun): PairSideRun {
  return typeof settled === "string" ? { outcome: settled } : settled;
}

function withRun(runs: PairRunContext["runs"], side: PairSideIndex, run: PairSideRun): PairRunContext["runs"] {
  return side === 0 ? [run, runs[1]] : [runs[0], run];
}

/**
 * Run both sides in their own fresh runtimes, in parallel unless the host selects sequential execution.
 * Sequential execution waits for the first run and its cleanup before starting the second. Cancelling waits for
 * active sides to stop and skips any side that has not started. A run's `prepare` step runs first, inside
 * `running`, so the host shows the pair as running from the moment it is asked for. A request while both sides run, or
 * one whose shared seed could differ between the pairs, is refused with `run.refused`.
 */
export const pairRunMachine = setup({
  types: {
    context: declareType<PairRunContext>(),
    events: declareType<PairRunEvent>(),
    emitted: declareType<PairRunEmitted>(),
  },
  actors: {
    prepare: fromPromise<void, { prepare: (signal: AbortSignal) => Promise<void> }>(({ input, signal }) =>
      input.prepare(signal),
    ),
    runSide: fromPromise<PairSideRun, SideActorInput>(async () => {
      throw new Error("The pair run machine needs a runSide service. Build it with createPairRunMachine.");
    }),
    settle: fromPromise<void, RunRequest>(async () => {
      throw new Error("The pair run machine needs a settle service when shared execution owns completion.");
    }),
  },
  guards: {
    runsInParallel: () => true,
    hasSettlement: () => false,
    hasSeedProblem: ({ event }) => event.type === "run.request" && resolveSeedProblem(event, {}) !== undefined,
    hasPrepareStep: ({ event }) => event.type === "run.request" && event.prepare !== undefined,
    isCurrentRequest: ({ context, event }) =>
      event.type === "run.cancel" && (event.requestId === undefined || event.requestId === context.request?.requestId),
    isCancelled: (_, run: PairSideRun) => run.outcome === "cancelled",
    firstSideCancelled: ({ context }) => context.runs[0]?.outcome === "cancelled",
    firstSideSettled: ({ context }) => context.runs[0] !== undefined,
  },
  actions: {
    takeRequest: assign(({ event }) =>
      event.type === "run.request"
        ? {
            request: { requestId: event.requestId, requester: event.requester },
            prepare: event.prepare,
            manifest: event.manifest,
          }
        : {},
    ),
    refuse: emit(({ event }): PairRunEmitted => {
      if (event.type !== "run.request") {
        throw new Error(`Expected a run.request to refuse, but got '${event.type}'.`);
      }

      return { type: "run.refused", requestId: event.requestId, requester: event.requester, reason: "busy" };
    }),
    refuseSeedProblem: emit(({ event }) => toSeedRefusal(event, {})),
    recordRun: assign(({ context }, { side, run }: { side: PairSideIndex; run: PairSideRun }) => ({
      runs: withRun(context.runs, side, run),
    })),
    cancelSides: ({ context }) => context.cancellation?.abort(),
    emitSettled: emit(({ context }): PairRunEmitted => {
      const runs = toSettledRuns(context.runs);

      return {
        type: "run.settled",
        ...getRequest(context),
        outcomes: [runs[0].outcome, runs[1].outcome],
        runs,
      };
    }),
  },
}).createMachine({
  id: "pairRun",
  initial: "idle",
  context: {
    disposeRequested: false,
    request: undefined,
    manifest: undefined,
    runs: [undefined, undefined],
    prepare: undefined,
    cancellation: undefined,
  },
  on: {
    "controller.dispose": {
      guard: ({ context }) => !context.disposeRequested,
      actions: [assign({ disposeRequested: true }), raise({ type: "run.cancel" })],
    },
  },
  states: {
    disposed: { type: "final" },
    idle: {
      always: { guard: ({ context }) => context.disposeRequested, target: "disposed" },
      on: {
        "run.request": [
          { guard: "hasSeedProblem", actions: "refuseSeedProblem" },
          { guard: "hasPrepareStep", target: "running.preparing", actions: "takeRequest" },
          { target: "running", actions: "takeRequest" },
        ],
      },
    },
    running: {
      initial: "sides",
      on: { "run.request": { actions: "refuse" } },
      entry: assign({ runs: [undefined, undefined], cancellation: () => new AbortController() }),
      exit: ["cancelSides", assign({ cancellation: undefined })],
      states: {
        preparing: {
          on: { "run.cancel": { guard: "isCurrentRequest", target: "#pairRun.settled" } },
          invoke: {
            src: "prepare",
            input: ({ context }) => {
              if (!context.prepare) {
                throw new Error("Missing the pair run's prepare step.");
              }

              return { prepare: context.prepare };
            },
            onDone: "sides",
            onError: "sides",
          },
        },
        sides: {
          type: "parallel",
          onDone: [{ guard: "hasSettlement", target: "settling" }, { target: "#pairRun.settled" }],
          on: { "run.cancel": { guard: "isCurrentRequest", actions: "cancelSides" } },
          states: {
            first: {
              initial: "running",
              states: {
                running: {
                  invoke: {
                    src: "runSide",
                    input: ({ context }) => toSideInput(context, 0),
                    onDone: [
                      {
                        guard: { type: "isCancelled", params: ({ event }) => event.output },
                        target: "done",
                        actions: [
                          { type: "recordRun", params: ({ event }) => ({ side: 0, run: event.output }) },
                          "cancelSides",
                        ],
                      },
                      {
                        target: "done",
                        actions: { type: "recordRun", params: ({ event }) => ({ side: 0, run: event.output }) },
                      },
                    ],
                    onError: {
                      target: "done",
                      actions: {
                        type: "recordRun",
                        params: ({ event }) => ({
                          side: 0,
                          run: { outcome: "failed", error: getErrorText(event.error) },
                        }),
                      },
                    },
                  },
                },
                done: { type: "final" },
              },
            },
            second: {
              initial: "waiting",
              states: {
                waiting: {
                  on: {
                    "run.cancel": { guard: "isCurrentRequest", target: "done", actions: "cancelSides" },
                  },
                  always: [
                    { guard: "runsInParallel", target: "running" },
                    { guard: "firstSideCancelled", target: "done" },
                    { guard: "firstSideSettled", target: "running" },
                  ],
                },
                running: {
                  invoke: {
                    src: "runSide",
                    input: ({ context }) => toSideInput(context, 1),
                    onDone: [
                      {
                        guard: { type: "isCancelled", params: ({ event }) => event.output },
                        target: "done",
                        actions: [
                          { type: "recordRun", params: ({ event }) => ({ side: 1, run: event.output }) },
                          "cancelSides",
                        ],
                      },
                      {
                        target: "done",
                        actions: { type: "recordRun", params: ({ event }) => ({ side: 1, run: event.output }) },
                      },
                    ],
                    onError: {
                      target: "done",
                      actions: {
                        type: "recordRun",
                        params: ({ event }) => ({
                          side: 1,
                          run: { outcome: "failed", error: getErrorText(event.error) },
                        }),
                      },
                    },
                  },
                },
                done: { type: "final" },
              },
            },
          },
        },
        settling: {
          on: { "run.cancel": { guard: "isCurrentRequest", actions: "cancelSides" } },
          invoke: {
            src: "settle",
            input: ({ context }) => getRequest(context),
            onDone: "#pairRun.settled",
          },
        },
      },
    },
    settled: {
      always: { guard: ({ context }) => context.disposeRequested, target: "disposed" },
      entry: "emitSettled",
      on: {
        "run.request": [
          { guard: "hasSeedProblem", actions: "refuseSeedProblem" },
          { guard: "hasPrepareStep", target: "running.preparing", actions: "takeRequest" },
          { target: "running", actions: "takeRequest" },
        ],
      },
    },
  },
});

/** A snapshot of the pair run machine */
export type PairRunSnapshot = SnapshotFrom<typeof pairRunMachine>;

/** Builds the pair run machine with the host's way to run one side. */
export function createPairRunMachine(services: PairRunServices) {
  return pairRunMachine.provide({
    guards: {
      runsInParallel: () => services.execution !== "sequential",
      hasSettlement: () => services.settle !== undefined,
      hasSeedProblem: ({ event }) => event.type === "run.request" && resolveSeedProblem(event, services) !== undefined,
    },
    actions: { refuseSeedProblem: emit(({ event }) => toSeedRefusal(event, services)) },
    actors: {
      settle: fromPromise<void, RunRequest>(async ({ input }) => {
        await services.settle?.(input.requestId);
      }),
      runSide: fromPromise<PairSideRun, SideActorInput>(async ({ input, signal }) =>
        toSideRun(
          await services.runSide({
            requestId: input.requestId,
            comparisonSignal: input.cancellation,
            side: input.side,
            signal: AbortSignal.any([signal, input.cancellation]),
            manifest: input.manifest,
          }),
        ),
      ),
    },
  });
}
