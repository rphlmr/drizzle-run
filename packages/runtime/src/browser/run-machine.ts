import type { ExecutionPhase, RunResult, RunTuple } from "@drizzle-run/core/contracts";
import { assign, fromPromise, setup, stateIn, type SnapshotFrom } from "xstate";

import { BackendError } from "../execution-contract.ts";
import { declareType } from "../machines/declare-type.ts";
import { decodeDatabaseDescription } from "./protocol.ts";
import type { ExecutionOutcome } from "./run.ts";

/** The database a succeeded run reported, read and checked against the run's dialect */
export type DatabaseReading =
  | { status: "absent" }
  | { status: "decoded"; description: NonNullable<RunResult["database"]> }
  | { status: "invalid"; error: BackendError };

/** What the execute actor gives back: the guest execution and its reported database */
export interface ExecutionOutput {
  outcome: ExecutionOutcome;
  database: DatabaseReading;
}

/** What the run machine asks of the run it drives */
export interface RunMachinePorts {
  dialect: RunTuple["target"]["dialect"];
  /** Runs the manifest once; aborting `signal` cancels it, and the promise still settles with how it stopped. */
  execute(signal: AbortSignal): Promise<ExecutionOutcome>;
  recordPhase(phase: ExecutionPhase, status: "running" | "succeeded" | "failed", durationMs?: number): void;
  finishCancelledBeforeStart(): void;
  finishCancelled(outcome: ExecutionOutcome, phase: ExecutionPhase | undefined): void;
  finishFailed(outcome: ExecutionOutcome, cause: unknown, phase: ExecutionPhase | undefined): void;
  /** Ends a run whose execution succeeded but whose database report could not be read. */
  finishWithInvalidReport(outcome: ExecutionOutcome, error: BackendError): void;
  finishSucceeded(outcome: ExecutionOutcome, database: DatabaseReading): void;
}

/** What the run hears from its caller and its execution */
export type RunMachineEvent =
  | { type: "run.start"; startedAt: number }
  | { type: "run.cancel" }
  | { type: "execution.ready"; initializationDurationMs?: number }
  | {
      type: "execution.phase";
      phase: ExecutionPhase;
      status: "running" | "succeeded" | "failed";
      durationMs?: number;
    };

interface RunMachineContext {
  sequence: number;
  phase: ExecutionPhase | undefined;
  startedAt: number | undefined;
  abortController: AbortController;
}

const GRACEFUL_CLEANUP: ExecutionOutcome["cleanup"] = { guest: { mode: "graceful" }, database: { mode: "graceful" } };

/**
 * Run machine
 *
 * `idle` until `run.start`, then `active` while its execution runs: `starting` until the guest is ready, `running`,
 * and `cancelling` once `run.cancel` aborted it. The execution's output decides the outcome: a cancelled run is
 * `cancelled` however it stopped, a failure, a failed report or a missing one is `failed`, a database report that
 * cannot be read or names another dialect is `failed`, and anything else is `succeeded`. Cancelling an idle run ends
 * it `cancelled` without executing.
 */
export function createRunMachine(ports: RunMachinePorts) {
  return setup({
    types: {
      context: declareType<RunMachineContext>(),
      events: declareType<RunMachineEvent>(),
    },
    actors: {
      execute: fromPromise<ExecutionOutput, AbortSignal>(async ({ input }) => {
        const outcome = await ports.execute(input);

        return { outcome, database: readReportedDatabase(outcome, ports.dialect) };
      }),
    },
    guards: {
      isCancelling: stateIn({ active: "cancelling" }),
      executionFailed: (_, output: ExecutionOutput) => isFailedExecution(output.outcome),
      databaseInvalid: (_, output: ExecutionOutput) => output.database.status === "invalid",
    },
    actions: {
      tick: assign({ sequence: ({ context }) => context.sequence + 1 }),
      recordReady: ({ event }) => {
        if (event.type === "execution.ready" && event.initializationDurationMs !== undefined) {
          ports.recordPhase("load_artifacts", "succeeded", event.initializationDurationMs);
        }
      },
      recordPhase: ({ event }) => {
        if (event.type === "execution.phase") {
          ports.recordPhase(event.phase, event.status, event.durationMs);
        }
      },
      setPhase: assign({
        sequence: ({ context }) => context.sequence + 1,
        phase: ({ context, event }) => (event.type === "execution.phase" ? event.phase : context.phase),
      }),
      abortExecution: ({ context }) => context.abortController.abort(),
    },
  }).createMachine({
    id: "browserRun",
    initial: "idle",
    context: () => ({ sequence: 0, phase: undefined, startedAt: undefined, abortController: new AbortController() }),
    states: {
      idle: {
        on: {
          "run.start": {
            target: "active",
            actions: [
              () => ports.recordPhase("load_artifacts", "running"),
              assign({
                sequence: ({ context }) => context.sequence + 1,
                phase: "load_artifacts",
                startedAt: ({ event }) => event.startedAt,
              }),
            ],
          },
          "run.cancel": {
            target: "cancelled",
            actions: ["tick", () => ports.finishCancelledBeforeStart()],
          },
        },
      },
      active: {
        initial: "starting",
        invoke: {
          id: "execute",
          src: "execute",
          input: ({ context }) => context.abortController.signal,
          onDone: [
            {
              guard: "isCancelling",
              target: "cancelled",
              actions: ["tick", ({ context, event }) => ports.finishCancelled(event.output.outcome, context.phase)],
            },
            {
              guard: { type: "executionFailed", params: ({ event }) => event.output },
              target: "failed",
              actions: [
                "tick",
                ({ context, event }) =>
                  ports.finishFailed(event.output.outcome, getExecutionFailure(event.output.outcome), context.phase),
              ],
            },
            {
              guard: { type: "databaseInvalid", params: ({ event }) => event.output },
              target: "failed",
              actions: [
                "tick",
                ({ event }) =>
                  ports.finishWithInvalidReport(event.output.outcome, getDatabaseError(event.output.database)),
              ],
            },
            {
              target: "succeeded",
              actions: ["tick", ({ event }) => ports.finishSucceeded(event.output.outcome, event.output.database)],
            },
          ],
          onError: [
            {
              guard: "isCancelling",
              target: "cancelled",
              actions: ["tick", ({ context }) => ports.finishCancelled({ cleanup: GRACEFUL_CLEANUP }, context.phase)],
            },
            {
              target: "failed",
              actions: [
                "tick",
                ({ context, event }) =>
                  ports.finishFailed({ failure: event.error, cleanup: GRACEFUL_CLEANUP }, event.error, context.phase),
              ],
            },
          ],
        },
        on: {
          "execution.ready": { actions: "recordReady" },
          "execution.phase": { actions: ["recordPhase", "setPhase"] },
        },
        states: {
          starting: {
            on: {
              "execution.ready": { target: "running", actions: ["recordReady", "tick"] },
              "run.cancel": { target: "cancelling", actions: "tick" },
            },
          },
          running: {
            on: {
              "run.cancel": { target: "cancelling", actions: "tick" },
            },
          },
          cancelling: {
            entry: "abortExecution",
          },
        },
      },
      succeeded: { type: "final" },
      failed: { type: "final" },
      cancelled: { type: "final" },
    },
  });
}

/** The run's state as `RunSnapshot.state` names it */
export type RunStateName = "idle" | "starting" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

/** Reads the `RunSnapshot.state` name from a run machine snapshot. */
export function getRunStateName(snapshot: SnapshotFrom<ReturnType<typeof createRunMachine>>): RunStateName {
  const { value } = snapshot;

  return typeof value === "string" ? value : value.active;
}

function isFailedExecution(outcome: ExecutionOutcome): boolean {
  return outcome.failure !== undefined || outcome.report?.outcome !== "succeeded";
}

function getExecutionFailure(outcome: ExecutionOutcome): unknown {
  return outcome.report?.error ?? outcome.failure ?? new Error("Execution worker returned no report.");
}

function getDatabaseError(database: DatabaseReading): BackendError {
  if (database.status !== "invalid") {
    throw new Error(`Expected an invalid database reading, but got '${database.status}'`);
  }

  return database.error;
}

function readReportedDatabase(outcome: ExecutionOutcome, dialect: RunTuple["target"]["dialect"]): DatabaseReading {
  const reported = outcome.report?.database;

  if (isFailedExecution(outcome) || reported === undefined) {
    return { status: "absent" };
  }

  try {
    const description = decodeDatabaseDescription(reported);

    if (description.dialect !== dialect) {
      throw new TypeError("Database report does not match the selected dialect.");
    }

    return { status: "decoded", description };
  } catch (cause) {
    return {
      status: "invalid",
      error: new BackendError(
        "invalid_report",
        cause instanceof Error ? cause.message : "Invalid database description.",
        { cause, phase: "inspect" },
      ),
    };
  }
}
