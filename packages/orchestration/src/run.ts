import type { Executor, RunEvent, RunResult, RunSnapshot } from "@drizzle-run/core/contracts";
import { and, assign, emit, fromCallback, fromPromise, raise, sendTo, setup } from "xstate";

import { declareType, getErrorText } from "./machine-utils.ts";
import type { RunCode, RunLanding, RunRecord, RunSubmission } from "./run-contract.ts";
export type { RunCode, RunLanding, RunRecord, RunSubmission } from "./run-contract.ts";

/** The part of the runtime the run machine needs; tests and other hosts can pass a fake. */
export type RunRuntime = Executor;

/** The runtime and submission of one run */
export interface RunMachineInput {
  runtime: RunRuntime;
  submission: RunSubmission;
  /**
   * The host's step before the guest starts, such as formatting the code, while the run already shows as running.
   * It returns the code to run in place of the submission's; a step that throws runs the submission as it is. Its
   * signal aborts when the run is cancelled first, and the step should then leave the code alone.
   */
  prepare?: (signal: AbortSignal) => Promise<RunCode>;
}

/** Who asked for a run and the id its `run.settled` or `run.refused` answers with */
export interface RunRequest {
  /** Unique per request; the emitted answer carries it, so a waiter takes only its own. */
  requestId: string;
  /** Who asked, such as the Run button, a guide or an agent. */
  requester: string;
}

/** The reports the run actor sends back while a run executes */
type RunExecutionEvent =
  | { type: "execution.state"; snapshot: RunSnapshot }
  | { type: "execution.event"; event: RunEvent }
  | { type: "execution.done"; result: RunResult }
  | { type: "execution.cancel.failed"; error: string }
  | { type: "execution.failed"; error: string };

/** Public `run.request`, `run.replay`, `run.cancel` and `run.view` events, plus the reports the run actor sends back */
export type RunMachineEvent =
  | { type: "controller.dispose" }
  | ({ type: "run.request"; input: RunMachineInput } & RunRequest)
  /** Shows a run that settled elsewhere, such as an author's recorded run, as this tab's run; no runtime needed. */
  | { type: "run.replay"; submission: RunSubmission; result: RunResult }
  /** Cancels the run in progress; with `requestId`, only when that request's run is the one in progress. */
  | { type: "run.cancel"; requestId?: string }
  | RunExecutionEvent
  | { type: "run.view"; run: number };

/**
 * A run still going this long after its guest started executing is stopped and settles as failed. The runtime fails
 * its own runs after 30 seconds; this catches a run that hangs outside that limit, such as while its workers close.
 * Startup is left to the runtime's own deadlines, since a first run may still be downloading the runtime.
 */
export const RUN_WATCHDOG_MS = 45_000;

/** Older runs are dropped past this, so a long session does not keep every result in memory. */
export const RUN_HISTORY_LIMIT = 20;

/**
 * `result` is absent when the run failed before the runtime returned one; `error` then says why.
 * `opens` is absent for a cancelled run, which leaves the view where it was.
 */
export type RunSettledEvent = RunRequest & {
  type: "run.settled";
  outcome: "succeeded" | "failed" | "cancelled";
  opens?: RunLanding;
  result?: RunResult;
  error?: string;
};

/** A `run.request` that arrived while another run was in progress; nothing ran for it. */
export type RunRefusedEvent = RunRequest & { type: "run.refused" };

/** What the run machine emits */
export type RunEmitted = RunSettledEvent | RunRefusedEvent;

/**
 * Get the output view a settled run lands on
 *
 * A failed or thrown run, or one that reports an error diagnostic, lands on Problems; any other settled run on
 * Results. A cancelled run, or no result and no error, lands nowhere.
 */
export function runLanding(
  result: Pick<RunResult, "outcome" | "diagnostics"> | undefined,
  error?: string,
): RunLanding | undefined {
  if (!result) {
    return error ? "problems" : undefined;
  }

  if (result.outcome === "cancelled") {
    return undefined;
  }

  const hasErrorDiagnostic = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return result.outcome === "failed" || hasErrorDiagnostic ? "problems" : "results";
}

function getElapsedMs(startedAt: number | undefined) {
  return startedAt === undefined ? undefined : Math.max(0, Math.round(performance.now() - startedAt));
}

/** The output fields that show a settled run again. */
function toShownRun(record: RunRecord) {
  return {
    submission: record.submission,
    result: record.result,
    error: record.error,
    durationMs: record.durationMs,
    progress: record.progress,
    states: record.states,
    events: record.events,
    shown: record.number,
  };
}

function getRequest(context: RunMachineContext): RunRequest {
  if (context.request === undefined) {
    throw new Error("Expected the run to hold its request, but it held none.");
  }

  return context.request;
}

interface RunMachineContext {
  disposeRequested: boolean;
  /** The request the run in progress, or the last run, answers; undefined before the first run. */
  request: RunRequest | undefined;
  startedAt: number | undefined;
  durationMs: number | undefined;
  runtime: RunRuntime | undefined;
  submission: RunSubmission | undefined;
  prepare: RunMachineInput["prepare"];
  result: RunResult | undefined;
  progress: string;
  error: string;
  states: RunSnapshot[];
  events: RunEvent[];
  /** Settled runs, oldest first. */
  runs: RunRecord[];
  /** The number of the run whose output the fields above hold, once one settled. */
  shown: number | undefined;
}

/**
 * Run machine
 *
 * Runs one submission at a time through the host's runtime and keeps the last `RUN_HISTORY_LIMIT` settled runs,
 * so `run.view` can show an older run's output again. Emits `run.settled` once per run, with the request's id, and
 * `run.refused` for a request that arrives while a run is in progress. A run still going
 * `RUN_WATCHDOG_MS` after the runtime started executing it is cancelled and settles as failed, so a hung run never
 * keeps the host waiting. A run's `prepare` step, such as formatting the code, runs inside `running` before the guest
 * starts, so the host shows the run as running from the moment it is asked for.
 */
export const runMachine = setup({
  types: {
    emitted: declareType<RunEmitted>(),
    context: declareType<RunMachineContext>(),
    events: declareType<RunMachineEvent>(),
  },
  actions: {
    emitCancelled: emit(({ context }): RunEmitted => ({
      type: "run.settled",
      ...getRequest(context),
      outcome: "cancelled",
    })),
    refuse: emit(({ event }): RunEmitted => {
      if (event.type !== "run.request") {
        throw new Error(`Expected a run.request to refuse, but got '${event.type}'.`);
      }

      return { type: "run.refused", requestId: event.requestId, requester: event.requester };
    }),
    submit: assign(({ event }) =>
      event.type === "run.request"
        ? {
            request: { requestId: event.requestId, requester: event.requester },
            runtime: event.input.runtime,
            submission: structuredClone(event.input.submission),
            prepare: event.input.prepare,
            startedAt: performance.now(),
            durationMs: undefined,
            result: undefined,
            error: "",
            states: [],
            events: [],
            progress: "Preparing runtime…",
          }
        : {},
    ),
    replay: assign(({ event }) =>
      event.type === "run.replay"
        ? {
            runtime: undefined,
            submission: structuredClone(event.submission),
            prepare: undefined,
            startedAt: undefined,
            durationMs: event.result.timings.total,
            result: event.result,
            error: "",
            states: [],
            events: [],
            progress: event.result.outcome === "cancelled" ? "Cancelled" : event.result.outcome,
          }
        : {},
    ),
    recordRun: assign(({ context }) => {
      if (!context.submission) {
        return {};
      }

      const record: RunRecord = {
        number: (context.runs.at(-1)?.number ?? 0) + 1,
        settledAt: Date.now(),
        submission: context.submission,
        result: context.result,
        error: context.error,
        durationMs: context.durationMs,
        progress: context.progress,
        states: context.states,
        events: context.events,
      };

      return { runs: [...context.runs, record].slice(-RUN_HISTORY_LIMIT), shown: record.number };
    }),
    recordState: assign(({ context, event }) =>
      event.type === "execution.state"
        ? {
            progress: event.snapshot.state.replaceAll("-", " "),
            states: context.submission?.debug ? [...context.states, event.snapshot] : [],
          }
        : {},
    ),
  },
  guards: {
    hasPrepareStep: ({ event }) => event.type === "run.request" && event.input.prepare !== undefined,
    hasShownRun: ({ context }) => context.runs.some((record) => record.number === context.shown),
    isExecuting: ({ event }) => event.type === "execution.state" && event.snapshot.state === "running",
    isCurrentRequest: ({ context, event }) =>
      event.type === "run.cancel" && (event.requestId === undefined || event.requestId === context.request?.requestId),
  },
  actors: {
    prepare: fromPromise<RunCode, { prepare: NonNullable<RunMachineInput["prepare"]> }>(({ input, signal }) =>
      input.prepare(signal),
    ),
    execute: fromCallback<RunMachineEvent, RunMachineInput>(({ input, sendBack, receive }) => {
      let isActive = true;
      let isSettled = false;
      let stateSubscription: { unsubscribe(): void } | undefined;
      let eventSubscription: { unsubscribe(): void } | undefined;
      let cancel: (() => Promise<void>) | undefined;

      try {
        const run = input.runtime.createRun(
          input.submission.manifest,
          input.submission.queryPlans === undefined ? undefined : { queryPlans: input.submission.queryPlans },
        );
        stateSubscription = run.subscribe((snapshot) => {
          if (isActive) {
            sendBack({ type: "execution.state", snapshot });
          }
        });
        eventSubscription = run.subscribeEvent((event) => {
          if (isActive && input.submission.debug) {
            sendBack({ type: "execution.event", event });
          }
        });
        cancel = () => run.cancel();

        receive((event) => {
          if (event.type === "run.cancel") {
            void run.cancel().catch((cause) => {
              if (isActive) {
                sendBack({ type: "execution.cancel.failed", error: getErrorText(cause) });
              }
            });
          }
        });

        run.start();
        void run.result.then(
          (result) => {
            isSettled = true;

            if (isActive) {
              sendBack({ type: "execution.done", result });
            }
          },
          (cause) => {
            isSettled = true;

            if (isActive) {
              sendBack({ type: "execution.failed", error: getErrorText(cause) });
            }
          },
        );
      } catch (cause) {
        isSettled = true;
        sendBack({ type: "execution.failed", error: getErrorText(cause) });
      }

      return () => {
        isActive = false;
        stateSubscription?.unsubscribe();
        eventSubscription?.unsubscribe();

        if (!isSettled) {
          void cancel?.().catch((cause) => {
            sendBack({ type: "execution.cancel.failed", error: getErrorText(cause) });
          });
        }
      };
    }),
  },
  delays: {
    runWatchdog: RUN_WATCHDOG_MS,
  },
}).createMachine({
  id: "run",
  initial: "idle",
  context: {
    disposeRequested: false,
    request: undefined,
    startedAt: undefined,
    durationMs: undefined,
    runtime: undefined,
    submission: undefined,
    prepare: undefined,
    result: undefined,
    progress: "Ready to run",
    error: "",
    states: [],
    events: [],
    runs: [],
    shown: undefined,
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
          { guard: "hasPrepareStep", target: "running.preparing", actions: "submit" },
          { target: "running", actions: "submit" },
        ],
        // A replay settles at once and emits no run.settled: nothing ran, so hosts waiting on runs are not told.
        "run.replay": { target: "settled", actions: ["replay", "recordRun"] },
      },
    },
    settled: {
      always: { guard: ({ context }) => context.disposeRequested, target: "disposed" },
      on: {
        "run.view": {
          actions: assign(({ context, event }) => {
            const record = context.runs.find((item) => item.number === event.run);

            return record ? toShownRun(record) : {};
          }),
        },
        "run.request": [
          { guard: "hasPrepareStep", target: "running.preparing", actions: "submit" },
          { target: "running", actions: "submit" },
        ],
        "run.replay": { target: "settled", actions: ["replay", "recordRun"] },
      },
    },
    running: {
      initial: "guest",
      states: {
        preparing: {
          invoke: {
            src: "prepare",
            input: ({ context }) => {
              if (!context.prepare) {
                throw new Error("Missing the run's prepare step.");
              }

              return { prepare: context.prepare };
            },
            onDone: {
              target: "guest",
              actions: assign(({ context, event }) => ({
                submission: context.submission && { ...context.submission, ...structuredClone(event.output) },
              })),
            },
            onError: { target: "guest" },
          },
          on: {
            "run.cancel": [
              {
                guard: and(["isCurrentRequest", "hasShownRun"]),
                target: "#run.settled",
                actions: [
                  "emitCancelled",
                  assign(({ context }) => {
                    const record = context.runs.find((item) => item.number === context.shown);

                    return record ? { ...toShownRun(record), prepare: undefined } : {};
                  }),
                ],
              },
              {
                guard: "isCurrentRequest",
                target: "#run.idle",
                actions: [
                  "emitCancelled",
                  assign({
                    runtime: undefined,
                    submission: undefined,
                    prepare: undefined,
                    startedAt: undefined,
                    progress: "Ready to run",
                  }),
                ],
              },
            ],
          },
        },
        guest: {
          invoke: {
            id: "run",
            src: "execute",
            input: ({ context }) => {
              if (!context.runtime || !context.submission) {
                throw new Error("Missing runtime or run snapshot.");
              }

              return { runtime: context.runtime, submission: context.submission };
            },
          },
          initial: "starting",
          states: {
            // The runtime prepares a guest; its own startup deadlines bound this.
            starting: {
              on: {
                "execution.state": { guard: "isExecuting", target: "executing", actions: "recordState" },
              },
            },
            executing: {
              // Leaving `running` stops the run actor, which cancels the runtime's run.
              after: {
                runWatchdog: {
                  actions: raise({
                    type: "execution.failed",
                    error: `The run did not finish within ${RUN_WATCHDOG_MS / 1_000} seconds, so it was stopped.`,
                  }),
                },
              },
            },
          },
        },
      },
      on: {
        "run.request": { actions: "refuse" },
        "run.cancel": {
          guard: "isCurrentRequest",
          actions: [sendTo("run", { type: "run.cancel" }), assign({ progress: "Cancelling…" })],
        },
        "execution.cancel.failed": {
          actions: assign(({ event }) => ({
            error: `Cancellation could not be confirmed: ${event.error}`,
            progress: "Waiting for runtime termination…",
          })),
        },
        "execution.state": { actions: "recordState" },
        "execution.event": {
          actions: assign(({ context, event }) => ({ events: [...context.events, event.event] })),
        },
        "execution.done": {
          target: "settled",
          actions: [
            assign(({ context, event }) => ({
              result: event.result,
              durationMs: event.result.timings.total ?? getElapsedMs(context.startedAt),
              progress: event.result.outcome === "cancelled" ? "Cancelled" : event.result.outcome,
            })),
            "recordRun",
            emit(({ context, event }): RunSettledEvent => {
              const opens = runLanding(event.result);

              return {
                type: "run.settled",
                ...getRequest(context),
                outcome: event.result.outcome,
                ...(opens ? { opens } : {}),
                result: event.result,
              };
            }),
          ],
        },
        "execution.failed": {
          target: "settled",
          actions: [
            assign(({ context, event }) => ({
              error: event.error,
              durationMs: getElapsedMs(context.startedAt),
              progress: "Run failed",
            })),
            "recordRun",
            emit(({ context, event }): RunSettledEvent => ({
              type: "run.settled",
              ...getRequest(context),
              outcome: "failed",
              opens: "problems",
              error: event.error,
            })),
          ],
        },
      },
    },
  },
});
