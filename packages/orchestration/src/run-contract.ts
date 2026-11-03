import type { Executor, QueryPlansSettings, RunEvent, RunResult, RunSnapshot } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";

/** Code and options captured when a run starts. */
export interface RunSubmission {
  manifest: RunManifest;
  revision: number;
  debug: boolean;
  queryPlans?: QueryPlansSettings;
  startedBy?: string;
}

export type RunCode = Pick<RunSubmission, "manifest" | "revision">;
export type RunLanding = "results" | "problems";

/** One retained execution, including optional debug traces. */
export interface RunRecord {
  number: number;
  settledAt: number;
  submission: RunSubmission;
  result: RunResult | undefined;
  error: string;
  durationMs: number | undefined;
  progress: string;
  states: RunSnapshot[];
  events: RunEvent[];
}

/** Completion of one submission. Execution failures resolve; refused submissions reject. */
export interface RunOutcome {
  requestId: string;
  requester: string;
  outcome: "succeeded" | "failed" | "cancelled";
  opens?: RunLanding;
  result?: RunResult;
  error?: string;
}

export interface Subscription {
  unsubscribe(): void;
}

/** Stable public view of the controller, independent of its implementation. */
export interface RunState {
  status: "idle" | "running" | "settled" | "disposing" | "disposed" | "failed";
  startedAt: number | undefined;
  submission: RunSubmission | undefined;
  result: RunResult | undefined;
  error: string;
  durationMs: number | undefined;
  progress: string;
  states: readonly RunSnapshot[];
  events: readonly RunEvent[];
  history: readonly RunRecord[];
  selectedHistoryEntry: number | undefined;
}

export interface RunControllerOptions {
  /** Default executor; a submission may supply another one. The caller owns its disposal. */
  runtime?: Executor;
}

export interface RunSubmitOptions {
  runtime?: Executor;
  requester?: string;
  /** Cancels only this submission and waits for its outcome. An already aborted signal rejects before admission. */
  signal?: AbortSignal;
  /** Optional formatting step. A failure preserves the original submission; cancellation aborts the step. */
  prepare?: (signal: AbortSignal) => Promise<RunCode>;
}

/** Manage submissions, cancellation and history without owning the injected runtime. */
export interface RunController {
  getState(): RunState;
  /** Observes subsequent changes. Read getState for the current value. */
  subscribe(listener: (state: RunState) => void): Subscription;
  onSettled(listener: (outcome: RunOutcome) => void): Subscription;
  submit(submission: RunSubmission, options?: RunSubmitOptions): Promise<RunOutcome>;
  /** Cancels the current submission and waits for settlement. */
  cancel(): Promise<void>;
  selectHistoryEntry(number: number): void;
  replay(input: { submission: RunSubmission; result: RunResult }): void;
  /** Refuses further submissions, cancels active work and waits before releasing subscriptions. Idempotent. */
  dispose(): Promise<void>;
}
