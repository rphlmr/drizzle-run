import type { RunResult } from "@drizzle-run/core/contracts";
import type { PairManifest, PairSideIndex } from "@drizzle-run/core/pair";

import type { RunOutcome, Subscription } from "./run-contract.ts";

export type PairSideOutcome = RunOutcome["outcome"];

export interface PairSideRun {
  outcome: PairSideOutcome;
  result?: RunResult;
  error?: string;
}

export interface PairSideInput {
  requestId: string;
  /** Shared request cancellation, independent of either observer invocation's lifetime. */
  comparisonSignal: AbortSignal;
  side: PairSideIndex;
  signal: AbortSignal;
  manifest: PairManifest | undefined;
}

/** Host callbacks for running both sides. Each side owns one independent run. */
export interface ComparisonOptions {
  runSide(input: PairSideInput): Promise<PairSideOutcome | PairSideRun>;
  execution?: "parallel" | "sequential";
  getManifest?(): PairManifest;
}

export interface ComparisonSubmitOptions {
  requester?: string;
  manifest?: PairManifest;
  prepare?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export interface ComparisonOutcome {
  requestId: string;
  requester: string;
  outcomes: readonly [PairSideOutcome, PairSideOutcome];
  runs: readonly [PairSideRun, PairSideRun];
}

export interface ComparisonState {
  status: "idle" | "running" | "settled" | "disposing" | "disposed" | "failed";
  runs: readonly [PairSideRun | undefined, PairSideRun | undefined];
  error: string;
}

export interface ComparisonController {
  getState(): ComparisonState;
  subscribe(listener: (state: ComparisonState) => void): Subscription;
  onSettled(listener: (outcome: ComparisonOutcome) => void): Subscription;
  submit(options?: ComparisonSubmitOptions): Promise<ComparisonOutcome>;
  cancel(): Promise<void>;
  /** Cancels active sides and waits for settlement; never disposes the host's runtimes. */
  dispose(): Promise<void>;
}
