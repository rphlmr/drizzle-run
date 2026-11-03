import type {
  Diagnostic,
  ExecutionError,
  ExecutionPhase,
  LogEvent,
  PhaseResult,
  QueryPlansReport,
  QueryPlansSettings,
  RunEvent,
  RunHandle,
  RunResult,
  RunSnapshot,
  RunTransaction,
  RunTuple,
  SerializedError,
  SerializedValue,
  TransactionStatementRole,
} from "@drizzle-run/core/contracts";
import {
  EXECUTION_PHASES,
  GUEST_STOPPED_CLEANUP_REASON,
  PLANNING_ABANDONED_CLEANUP_REASON,
  SERIALIZED_UNDEFINED,
  serializeError,
  serializeValue,
} from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { createActor, type Actor } from "xstate";

import { createErrorLocator } from "../compiler/source-location.ts";
import { BackendError, type BackendCleanup } from "../execution-contract.ts";
import { classifyStatement, toRunTransactions, type WireTransaction } from "../transactions/transactions.ts";
import { BrowserRuntimeError, reportObserverFailure } from "./errors.ts";
import { ExecutionErrorSchema, type RuntimeWorkerMessage } from "./protocol.ts";
import { createRunMachine, getRunStateName, type DatabaseReading } from "./run-machine.ts";

export type { CreateRunOptions } from "@drizzle-run/core/contracts";

/** A browser executor's run, with the shared host-independent handle contract. */
export type BrowserRun = RunHandle;

/** What a guest execution left: its report or failure, and how its guest and database were cleaned up. */
export interface ExecutionOutcome {
  report?: Extract<RuntimeWorkerMessage, { kind: "report" }>;
  failure?: unknown;
  cleanup: BackendCleanup;
}

/** What a run asks of the runtime that created it: one execution of its manifest at a time. */
export interface RunExecutor {
  execute(
    token: BrowserRunImpl,
    manifest: RunManifest,
    tuple: RunTuple,
    effectiveSeed: number,
    signal: AbortSignal,
    onMessage: (message: RuntimeWorkerMessage) => void,
    onReady: (initializationDurationMs: number) => void,
    queryPlans?: QueryPlansSettings,
  ): Promise<ExecutionOutcome>;
}

/** A run of one manifest, from creation to its settled result. */
export class BrowserRunImpl implements BrowserRun {
  readonly #runtime: RunExecutor;
  readonly #manifest: RunManifest;
  readonly #tuple: RunTuple;
  readonly #actor: Actor<ReturnType<typeof createRunMachine>>;
  readonly #stateListeners = new Set<(snapshot: RunSnapshot) => void>();
  readonly #eventListeners = new Set<(event: RunEvent) => void>();
  readonly #events: RunEvent[] = [];
  readonly #phaseMap = new Map<ExecutionPhase, PhaseResult>();
  readonly #completion: Promise<RunResult>;
  #resolveCompletion!: (result: RunResult) => void;
  #result: RunResult | undefined;
  readonly #onDone: () => void;
  readonly #startedAtIso = new Date().toISOString();
  #sourceMap: string | undefined;
  #locator: ((error: unknown) => Diagnostic | undefined) | undefined;
  #database: RunResult["database"];
  #queryPlans: QueryPlansReport | undefined;
  #transactions: RunTransaction[] | undefined;
  /** What each SQL statement did, by its `SqlEvent.sequence`. */
  readonly #statementRoles = new Map<number, TransactionStatementRole>();
  #lastValue: SerializedValue = SERIALIZED_UNDEFINED;
  readonly #queryPlansSettings: QueryPlansSettings | undefined;
  #eventSequence = 0;
  #logSequence = 0;
  #effectiveSeed: number;
  #seedSource: "provided" | "generated";
  #cleanup: BackendCleanup = { guest: { mode: "graceful" }, database: { mode: "graceful" } };
  #cleanupErrors: SerializedError[] = [];

  constructor(
    runtime: RunExecutor,
    manifest: RunManifest,
    tuple: RunTuple,
    timing: { validationDurationMs: number; resolutionDurationMs: number },
    onDone: () => void,
    queryPlans: QueryPlansSettings | undefined,
  ) {
    this.#runtime = runtime;
    this.#queryPlansSettings = queryPlans;
    this.#manifest = manifest;
    this.#tuple = tuple;
    this.#onDone = onDone;
    this.#seedSource = manifest.randomSeed === undefined ? "generated" : "provided";
    this.#effectiveSeed = manifest.randomSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
    this.#phaseMap.set("validate", {
      phase: "validate",
      status: "succeeded",
      startedAt: this.#startedAtIso,
      durationMs: timing.validationDurationMs,
    });
    this.#phaseMap.set("resolve", {
      phase: "resolve",
      status: "succeeded",
      startedAt: this.#startedAtIso,
      durationMs: timing.resolutionDurationMs,
    });

    if (manifest.entrypoints.seed === undefined) {
      this.#phaseMap.set("seed", { phase: "seed", status: "skipped" });
    }

    if (manifest.entrypoints.run === undefined) {
      this.#phaseMap.set("run", { phase: "run", status: "skipped" });
    }

    this.#completion = new Promise<RunResult>((resolve) => {
      this.#resolveCompletion = resolve;
    });
    this.#actor = createActor(
      createRunMachine({
        dialect: tuple.target.dialect,
        execute: (signal) =>
          this.#runtime.execute(
            this,
            this.#manifest,
            this.#tuple,
            this.#effectiveSeed,
            signal,
            (message) => this.#receive(message),
            (initializationDurationMs) => this.#actor.send({ type: "execution.ready", initializationDurationMs }),
            this.#queryPlansSettings,
          ),
        recordPhase: (phase, status, durationMs) => this.#recordPhase(phase, status, durationMs),
        finishCancelledBeforeStart: () => {
          this.#result = this.#buildResult({
            outcome: "cancelled",
            error: { name: "AbortError", message: "Run cancelled.", phase: "validate", code: "cancelled" },
          });
        },
        finishCancelled: (outcome, phase) => {
          this.#recordOutcome(outcome, "stopped_on_purpose");
          this.#finishActivePhase("cancelled");
          this.#result = this.#buildResult({
            outcome: "cancelled",
            error: { name: "AbortError", message: "Run cancelled.", phase: phase ?? "run", code: "cancelled" },
          });
        },
        finishFailed: (outcome, cause) => {
          const timedOut = outcome.failure instanceof BackendError && outcome.failure.code === "run_timeout";
          this.#recordOutcome(outcome, timedOut ? "stopped_on_purpose" : "stopped_by_itself");
          const error = this.#executionError(cause);
          const diagnostic = this.#locateDiagnostic(cause);
          this.#finishActivePhase("failed");

          if (diagnostic !== undefined) {
            this.#publishEvent({ type: "diagnostic", payload: diagnostic });
          }

          this.#result = this.#buildResult({ outcome: "failed", error });
        },
        finishWithInvalidReport: (outcome, invalidReport) => {
          this.#recordOutcome(outcome, "stopped_by_itself");
          this.#result = this.#buildResult({ outcome: "failed", error: this.#executionError(invalidReport) });
        },
        finishSucceeded: (outcome, database) => {
          this.#recordOutcome(outcome, "stopped_by_itself");
          this.#database = toRunDatabase(database);
          this.#queryPlans = outcome.report?.queryPlans;
          this.#result = this.#buildResult({ outcome: "succeeded" });
        },
      }),
    );
    this.#actor.subscribe((snapshot) => {
      const runSnapshot = this.#getSnapshot();

      for (const listener of this.#stateListeners) {
        try {
          listener(runSnapshot);
        } catch (cause) {
          this.#stateListeners.delete(listener);
          reportObserverFailure(cause);
        }
      }

      if (snapshot.status === "done") {
        this.#complete();
      }
    });
    this.#actor.start();
  }

  get result(): Promise<RunResult> {
    return this.#completion;
  }

  start(): void {
    this.#actor.send({ type: "run.start", startedAt: Date.now() });
  }

  async cancel(): Promise<void> {
    this.#actor.send({ type: "run.cancel" });
    await this.#completion;
  }

  subscribe(listener: (snapshot: RunSnapshot) => void): { unsubscribe(): void } {
    if (this.#isSettled()) {
      listener(this.#getSnapshot());

      return { unsubscribe() {} };
    }

    this.#stateListeners.add(listener);

    try {
      listener(this.#getSnapshot());
    } catch (cause) {
      this.#stateListeners.delete(listener);
      reportObserverFailure(cause);
    }

    return {
      unsubscribe: () => {
        this.#stateListeners.delete(listener);
      },
    };
  }

  subscribeEvent(listener: (event: RunEvent) => void): { unsubscribe(): void } {
    if (this.#isSettled()) {
      return { unsubscribe() {} };
    }

    this.#eventListeners.add(listener);

    return {
      unsubscribe: () => {
        this.#eventListeners.delete(listener);
      },
    };
  }

  /**
   * Keep what every outcome records: the cleanup, the returned value and the transactions
   *
   * A cancel or the time limit stops a run by closing its workers, so a forced close is how it stopped, not a cleanup
   * problem: the run's own error says why, and `cleanup` still records it. A database whose planning was abandoned is
   * recorded as forced too, but its plans already report it.
   */
  #recordOutcome(outcome: ExecutionOutcome, stop: "stopped_on_purpose" | "stopped_by_itself"): void {
    const { cleanup, report } = outcome;

    this.#cleanup = cleanup;
    this.#cleanupErrors = [
      ...(cleanup.guest.mode === "forced" && cleanup.guest.reason !== GUEST_STOPPED_CLEANUP_REASON
        ? [serializeError(`Guest worker was forcefully closed: ${cleanup.guest.reason ?? "unknown reason"}.`)]
        : []),
      ...(cleanup.database.mode === "forced" &&
      cleanup.database.reason !== PLANNING_ABANDONED_CLEANUP_REASON &&
      !(stop === "stopped_on_purpose" && cleanup.database.reason === GUEST_STOPPED_CLEANUP_REASON)
        ? [serializeError(`Database worker was forcefully closed: ${cleanup.database.reason ?? "unknown reason"}.`)]
        : []),
    ];
    this.#lastValue = report?.value ?? SERIALIZED_UNDEFINED;
    this.#transactions = report?.transactions === undefined ? undefined : this.#toTransactions(report.transactions);
  }

  #receive(message: RuntimeWorkerMessage): void {
    switch (message.kind) {
      case "phase":
        this.#actor.send({
          type: "execution.phase",
          phase: message.phase,
          status: message.status,
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
        });

        return;

      case "event":
        if (message.type === "log") {
          this.#publishEvent({
            type: "log",
            payload: { ...this.#withCallSite(message.payload), sequence: ++this.#logSequence },
          });

          return;
        }

        if (message.type === "sql") {
          const { commandTags, ...event } = message.payload;
          this.#statementRoles.set(event.sequence, classifyStatement(event.sql, commandTags));
          this.#publishEvent({ type: "sql", payload: this.#withCallSite(event) });
          return;
        }

        if (message.type === "display") {
          this.#publishEvent({ type: "display", payload: this.#withCallSite(message.payload) });
          return;
        }

        this.#publishEvent({ type: message.type, payload: message.payload });

        return;

      case "console": {
        const event: LogEvent = {
          sequence: ++this.#logSequence,
          phase: toLogPhase(this.#currentPhase()),
          level: message.level,
          values: [serializeValue(message.text)],
        };
        this.#publishEvent({ type: "log", payload: event });

        return;
      }

      case "compiled":
        this.#sourceMap = message.sourceMap;
        this.#locator = undefined;

        return;

      // The run hears its guest only once it is ready, and `execute` reports the ready itself.
      case "ready":
      case "progress":
      case "report":
      case "failure":
      case "database_opened":
      case "database_closed":
      case "closed":
        return;
    }
  }

  #recordPhase(phase: ExecutionPhase, status: "running" | "succeeded" | "failed", durationMs?: number): void {
    const current = this.#phaseMap.get(phase);
    const item: PhaseResult = {
      phase,
      status,
      ...(status === "running"
        ? { startedAt: new Date().toISOString() }
        : current?.startedAt === undefined
          ? {}
          : { startedAt: current.startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };

    this.#phaseMap.set(phase, item);
  }

  #finishActivePhase(status: "failed" | "cancelled"): void {
    const phase = this.#currentPhase();

    if (phase === undefined) {
      return;
    }

    const current = this.#phaseMap.get(phase);

    if (current?.status === "running") {
      this.#phaseMap.set(phase, {
        phase,
        status,
        ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt }),
      });
    }
  }

  /**
   * Keeps an event on the result and sends it to the listeners. The execution session already stops a run past 16 MiB
   * of logs, queries and events, so the result holds all of them.
   */
  #publishEvent(published: UnsequencedRunEvent): void {
    const event: RunEvent = { ...published, sequence: ++this.#eventSequence };
    this.#events.push(event);

    for (const listener of this.#eventListeners) {
      try {
        listener(event);
      } catch (cause) {
        this.#eventListeners.delete(listener);
        reportObserverFailure(cause);
      }
    }
  }

  #locateDiagnostic(error: unknown): Diagnostic | undefined {
    if (this.#sourceMap === undefined) {
      return undefined;
    }

    try {
      this.#locator ??= createErrorLocator(this.#sourceMap);

      return this.#locator(error);
    } catch {
      return undefined;
    }
  }

  /** The project file and line the guest's bundle frames point at, innermost first. */
  #locateFrames(frames: string): { source: string; line: number } | undefined {
    const stack = frames
      .split(" ")
      .map((frame) => `at drizzle-run-bundle.js:${frame}`)
      .join("\n");
    const location = this.#locateDiagnostic({ message: "", stack });

    return location?.source === undefined || location.line === undefined
      ? undefined
      : { source: location.source, line: location.line };
  }

  #toTransactions(transactions: readonly WireTransaction[]): RunTransaction[] | undefined {
    const resolved = toRunTransactions({
      transactions,
      roles: this.#statementRoles,
      locate: (frames) => this.#locateFrames(frames),
    });

    return resolved.length === 0 ? undefined : resolved;
  }

  /** Swaps the guest's bundle frames for the project file and line they point at. */
  #withCallSite<Payload extends { frames?: string }>(
    payload: Payload,
  ): Omit<Payload, "frames"> & { source?: string; line?: number } {
    const { frames, ...event } = payload;

    if (frames === undefined) {
      return event;
    }

    const location = this.#locateFrames(frames);

    if (location === undefined) {
      return event;
    }

    return { ...event, source: location.source, line: location.line };
  }

  #executionError(input: unknown): ExecutionError & { code?: string } {
    const reported = ExecutionErrorSchema.safeParse(input);

    if (reported.success) {
      const code =
        reported.data.code === "run_timeout"
          ? "run_timeout"
          : reported.data.phase === "compile"
            ? "compile_error"
            : "user_execution_error";

      return { ...reported.data, code };
    }

    const error = serializeError(input);
    const phase =
      input instanceof BackendError
        ? (input.phase ?? this.#currentPhase() ?? "run")
        : input instanceof BrowserRuntimeError &&
            ["capability_unsupported", "asset_configuration", "unsupported_tuple"].includes(input.code)
          ? "load_artifacts"
          : (this.#currentPhase() ?? "run");
    const code =
      input instanceof BackendError
        ? input.code === "worker_failure" && phase === "compile"
          ? "compile_error"
          : input.code
        : phase === "compile"
          ? "compile_error"
          : input instanceof BrowserRuntimeError
            ? input.code
            : "execution_failed";

    return { ...error, phase, code };
  }

  #buildResult(settlement: RunSettlement): RunResult {
    const events = [...this.#events];
    const phases = [...this.#phaseMap.values()].toSorted(
      (left, right) => EXECUTION_PHASES.indexOf(left.phase) - EXECUTION_PHASES.indexOf(right.phase),
    );
    const { startedAt } = this.#actor.getSnapshot().context;
    const timings: Partial<Record<ExecutionPhase | "total", number>> = {
      total: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
    };

    for (const phase of phases) {
      if (phase.durationMs !== undefined) {
        timings[phase.phase] = phase.durationMs;
      }
    }

    const evidence: RunEvidence = {
      version: 1,
      target: this.#tuple.target,
      tuple: this.#tuple,
      random: {
        effectiveSeed: this.#effectiveSeed,
        source: this.#seedSource,
        derivation: "crypto-u32-v1",
        generator: "mulberry32-v1",
      },
      phases,
      diagnostics: events
        .filter((event): event is Extract<RunEvent, { type: "diagnostic" }> => event.type === "diagnostic")
        .map((event) => event.payload),
      sql: events
        .filter((event): event is Extract<RunEvent, { type: "sql" }> => event.type === "sql")
        .map((event) => event.payload),
      logs: events
        .filter((event): event is Extract<RunEvent, { type: "log" }> => event.type === "log")
        .map((event) => event.payload),
      value: this.#lastValue,
      displays: events
        .filter((event): event is Extract<RunEvent, { type: "display" }> => event.type === "display")
        .map((event) => event.payload),
      events,
      ...(this.#database === undefined ? {} : { database: this.#database }),
      ...(this.#transactions === undefined ? {} : { transactions: this.#transactions }),
      ...(this.#queryPlans === undefined ? {} : { queryPlans: this.#queryPlans }),
      cleanupErrors: [...this.#cleanupErrors],
      cleanup: this.#cleanup,
      timings,
    };

    // Keys keep the order results always had: version, ok and outcome first, the error last.
    const { version, ...details } = evidence;

    return settlement.outcome === "succeeded"
      ? { version, ok: true, outcome: settlement.outcome, ...details }
      : { version, ok: false, outcome: settlement.outcome, ...details, error: settlement.error };
  }

  /** True once the run reached its outcome, or was cancelled before it started. */
  #isSettled(): boolean {
    return this.#actor.getSnapshot().status === "done";
  }

  /** Settles the result the machine's final transition built, once its listeners heard the final state. */
  #complete(): void {
    if (this.#result === undefined) {
      throw new Error("Expected the run to build its result before it settled");
    }

    this.#resolveCompletion(this.#result);
    this.#onDone();
    this.#stateListeners.clear();
    this.#eventListeners.clear();
  }

  #currentPhase(): ExecutionPhase | undefined {
    return this.#actor.getSnapshot().context.phase;
  }

  #getSnapshot(): RunSnapshot {
    const snapshot = this.#actor.getSnapshot();
    const { phase, sequence, startedAt } = snapshot.context;

    return {
      state: getRunStateName(snapshot),
      status: snapshot.status === "done" ? "done" : "active",
      sequence,
      ...(phase === undefined ? {} : { phase }),
      elapsedMs: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
    };
  }
}

/** What every run result records, whatever its outcome. */
type RunEvidence = Omit<RunResult, "ok" | "outcome" | "error">;

/** How a run ended: a failed run always has its error, a cancelled one names why it stopped. */
type RunSettlement =
  | { outcome: "succeeded" }
  | { outcome: "failed" | "cancelled"; error: ExecutionError & { code?: string } };

/** A run event before the run numbers it: each event type keeps its own payload. */
type UnsequencedRunEvent = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "sequence">
    : never
  : never;

/** Cancel a run when `signal` aborts, and stop listening once the run settles. */
export function cancelRunOnAbort(run: BrowserRun, signal: AbortSignal): void {
  const cancel = () => {
    void run.cancel();
  };

  if (signal.aborted) {
    cancel();

    return;
  }

  signal.addEventListener("abort", cancel, { once: true });
  void run.result.then(() => signal.removeEventListener("abort", cancel));
}

function toRunDatabase(database: DatabaseReading): RunResult["database"] {
  return database.status === "decoded" ? database.description : undefined;
}

function toLogPhase(phase: ExecutionPhase | undefined): LogEvent["phase"] {
  if (phase === "seed") {
    return "seed";
  }

  if (phase === "evaluate_schema") {
    return "schema";
  }

  return "run";
}
