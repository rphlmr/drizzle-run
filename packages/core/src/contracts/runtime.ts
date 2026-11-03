import type { RunManifestTarget } from "../manifest/types.ts";
import type { QueryPlansReport } from "./query-plans.ts";
import type {
  DatabaseDescription,
  Diagnostic,
  DisplayResult,
  ExecutionError,
  ExecutionPhase,
  LogEvent,
  PhaseResult,
  PhaseTimings,
  RunTransaction,
  SqlEvent,
} from "./result.ts";
import type { SerializedError, SerializedValue } from "./serialization.ts";

/** The runtime tuple a run used: target and ORM and Kit versions. */
export interface RunTuple {
  id: string;
  target: RunManifestTarget;
  ormVersion: string;
  kitVersion: string;
}

/** How a run resource was released: on request, or forced after a failure or timeout. */
export interface CleanupEvidence {
  mode: "graceful" | "forced";
  reason?: string;
}

/**
 * The `reason` of a forced database close when query planning ran out of time with a statement still running. The
 * plans already say so, so a run report does not list it as a cleanup problem too.
 */
export const PLANNING_ABANDONED_CLEANUP_REASON = "planning_abandoned";

/**
 * The `reason` of a forced guest close when the run stopped before the guest finished: a compile error, a failure, a
 * cancel or the time limit. Closing the guest is how the run stops, and the run's error already says why, so a run
 * report does not list it as a cleanup problem.
 */
export const GUEST_STOPPED_CLEANUP_REASON = "guest_killed_on_close";

interface RunEvidence {
  version: 1;
  target: RunManifestTarget;
  tuple: RunTuple;
  random: {
    effectiveSeed: number;
    source: "provided" | "derived" | "generated";
    derivation: "run-manifest-sha256-u32-v1" | "crypto-u32-v1";
    generator: "mulberry32-v1";
  };
  phases: readonly PhaseResult[];
  diagnostics: readonly Diagnostic[];
  sql: readonly SqlEvent[];
  logs: readonly LogEvent[];
  value: SerializedValue;
  displays: readonly DisplayResult[];
  /** The retained events above in the order they happened, across types; `sequence` is that order. */
  events: readonly RunEvent[];
  /**
   * The transactions and savepoints the project code opened, in the order they began. Absent when it opened none,
   * when two transactions ran interleaved (their statements could not be told apart), or when the run stopped
   * before its report.
   */
  transactions?: readonly RunTransaction[];
  database?: DatabaseDescription;
  /** Present when the run submission turned Query plans on and the run succeeded. */
  queryPlans?: QueryPlansReport;
  cleanupErrors: readonly SerializedError[];
  cleanup: { guest: CleanupEvidence; database: CleanupEvidence };
  timings: PhaseTimings;
}

/** Everything a finished run produced, with its outcome. */
export type RunResult = RunEvidence &
  (
    | { ok: true; outcome: "succeeded"; error?: never }
    | { ok: false; outcome: "failed"; error: ExecutionError & { code?: string } }
    | { ok: false; outcome: "cancelled"; error?: ExecutionError & { code?: string } }
  );

/** The live state of a run, emitted while it progresses. */
export interface RunSnapshot {
  state: string;
  status: "active" | "done";
  sequence: number;
  phase?: ExecutionPhase;
  elapsedMs: number;
}

/** One retained run event, ordered across types by `sequence`. */
export type RunEvent =
  | { type: "diagnostic"; sequence: number; payload: Diagnostic }
  | { type: "sql"; sequence: number; payload: SqlEvent }
  | { type: "log"; sequence: number; payload: LogEvent }
  | { type: "display"; sequence: number; payload: DisplayResult };

/** Why the browser or embedding context cannot run Drizzle Run. */
export type CapabilityReasonCode =
  | "unsupported_host"
  | "no_dedicated_worker"
  | "no_webassembly"
  | "no_wasm_threads"
  | "no_wasm_exception_handling"
  | "no_wasm_simd"
  | "no_decompression"
  | "insecure_context"
  | "no_asset_verification"
  | "no_shared_memory"
  | "embedding_isolation"
  | "missing_isolation_headers";

/** One capability problem with its user-facing message. */
export interface CapabilityReason {
  code: CapabilityReasonCode;
  message: string;
}

/** The result of the runtime capability check. */
export interface RuntimeCapabilities {
  status: "available" | "embedding_context_unsupported" | "browser_unsupported" | "configuration_error";
  reasons: readonly CapabilityReason[];
}

/**
 * Format capability reasons as one sentence
 *
 * Plain text for callers that only show a sentence, not per-reason copy. Returns an empty string when there are no
 * reasons.
 */
export function formatCapabilityReasons(capabilities: RuntimeCapabilities): string {
  return capabilities.reasons.map((reason) => reason.message).join(" ");
}

/** The live state of the runtime itself: capability check, asset download, warm-up and disposal. */
export interface RuntimeSnapshot {
  state: "idle" | "checking" | "acquiring" | "warming" | "ready" | "failed" | "disposing" | "disposed";
  capabilities?: RuntimeCapabilities;
  error?: SerializedError;
  progress?: { downloadedBytes: number; totalBytes: number | null };
}
