import type { RunManifest } from "../manifest/index.ts";
import type { QueryPlansSettings } from "./query-plans.ts";
import type { RunEvent, RunResult, RunSnapshot, RuntimeCapabilities, RuntimeSnapshot } from "./runtime.ts";

/** Options shared by executors, independent of the host that owns execution. */
export interface CreateRunOptions {
  /** Inspect query plans against this run's database before it is disposed. */
  queryPlans?: QueryPlansSettings;
  /** An already aborted signal cancels the run before it starts. */
  signal?: AbortSignal;
}

/**
 * One fresh execution of a manifest. Created idle; start begins it at most once.
 * The result carries the execution outcome and cleanup evidence. Cancel requests
 * termination and waits for settlement; inspect the result for cleanup failures.
 * Subscriptions may emit synchronously.
 */
export interface RunHandle {
  readonly result: Promise<RunResult>;
  start(): void;
  cancel(): Promise<void>;
  subscribe(listener: (snapshot: RunSnapshot) => void): { unsubscribe(): void };
  subscribeEvent(listener: (event: RunEvent) => void): { unsubscribe(): void };
}

/**
 * Creates independent runs, each with one fresh database for its manifest's dialect.
 * The implementation owns validation, admission, isolation and resource cleanup.
 * Creating a handle does not start execution. Invalid input may throw synchronously.
 */
export interface Executor {
  createRun(manifest: RunManifest, options?: CreateRunOptions): RunHandle;
}

export interface PrepareOptions {
  /** Stops waiting; preparation may still finish for a later run or be closed by disposal. */
  signal?: AbortSignal;
}

export type ComparisonSide = "a" | "b";
export type ComparisonManifest = Record<ComparisonSide, RunManifest>;
export type ComparisonResult = Record<ComparisonSide, RunResult>;

/** Scheduling and cancellation of two independently isolated executions. */
export interface CreateComparisonOptions extends CreateRunOptions {
  execution?: "parallel" | "sequential";
}

/** Each side exposes the ordinary run subscriptions and result; aggregate completion waits for both. */
export interface ComparisonHandle {
  readonly sides: Record<ComparisonSide, Pick<RunHandle, "result" | "subscribe" | "subscribeEvent">>;
  readonly result: Promise<ComparisonResult>;
  start(): void;
  cancel(): Promise<void>;
}

/** The complete SDK contract supplied by both browser and Node factories. */
export interface Runtime extends Executor {
  createComparison(manifests: ComparisonManifest, options?: CreateComparisonOptions): ComparisonHandle;
  checkCapabilities(): Promise<RuntimeCapabilities>;
  getSnapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): { unsubscribe(): void };
  prepare(manifest: RunManifest, options?: PrepareOptions): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
