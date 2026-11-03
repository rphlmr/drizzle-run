import type { CleanupEvidence, ExecutionPhase } from "@drizzle-run/core/contracts";

/** Evidence from releasing the execution container and database. */
export interface BackendCleanup {
  guest: CleanupEvidence;
  database: CleanupEvidence;
}

export type BackendErrorCode =
  | "backend_consumed"
  | "cleanup_failed"
  | "invalid_report"
  | "protocol_error"
  | "run_timeout"
  | "startup_timeout"
  | "worker_closed"
  | "worker_error"
  | "worker_failure";

export interface BackendErrorOptions extends ErrorOptions {
  phase?: ExecutionPhase;
}

/** An execution failure with a stable code and an attributed phase. */
export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly phase: ExecutionPhase | undefined;

  constructor(code: BackendErrorCode, message: string, options: BackendErrorOptions = {}) {
    super(message, options);
    this.name = "BackendError";
    this.code = code;
    this.phase = options.phase;
  }
}
