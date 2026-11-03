import type { Executor } from "@drizzle-run/core/contracts";
import type {
  RunController,
  RunOutcome,
  RunSubmission,
  RunSubmitOptions,
  ComparisonController,
  ComparisonOutcome,
  ComparisonSubmitOptions,
} from "@drizzle-run/orchestration";

export { RunRefusedError, RunStoppedError } from "@drizzle-run/orchestration";

/** The app's captured submission and the runtime available in its workspace. */
export interface RequestRunOptions {
  requester: string;
  input: {
    runtime: Executor;
    submission: RunSubmission;
    prepare?: RunSubmitOptions["prepare"];
  };
  signal?: AbortSignal;
}

export function requestRun(
  execution: RunController,
  { requester, input, signal }: RequestRunOptions,
): Promise<RunOutcome> {
  return execution.submit(input.submission, { requester, runtime: input.runtime, prepare: input.prepare, signal });
}

export function requestPairRun(
  comparison: ComparisonController,
  options: ComparisonSubmitOptions,
): Promise<ComparisonOutcome> {
  return comparison.submit(options);
}
