import {
  SerializedValueSchema as CoreSerializedValueSchema,
  serializeError,
  PLANNING_ABANDONED_CLEANUP_REASON,
  type ExecutionPhase as RuntimePhase,
  type SqlEvent,
} from "@drizzle-run/core/contracts";
import type { Deferred, HostFunction, JSValueHandle } from "quickjs-wasi";
import { EvalFlags } from "quickjs-wasi";
import type { ActorRefFrom } from "xstate";
import { createActor } from "xstate";
import * as z from "zod/mini";

import { parseRuntimeWorkerMessage, type RuntimeWorkerMessage } from "../browser/protocol.ts";
import { createErrorLocator } from "../compiler/source-location.ts";
import { encodeDatabaseValue, decodeDatabaseValue } from "../database/database-codec.ts";
import type { DatabaseEngine } from "../database/database-engine.ts";
import { serializeDatabaseError } from "../database/database-engine.ts";
import type { BackendCleanup } from "../execution-contract.ts";
import { planQueries } from "../query-plans/planner.ts";
import { parseSchemaTableKeys, type SchemaTableKeys } from "../query-plans/schema.ts";
import { bundlePath, compileManifest, stopCompiler } from "./compiler.ts";
import type { Diagnostic, ExecutionPhase, ExecutionResult, SerializedValue } from "./contract.ts";
import { DisplaysSchema, SerializedValueSchema } from "./contract.ts";
import { QuickjsTimeoutError, toExecutionError } from "./errors.ts";
import { createPhaseMachine } from "./phases.ts";
import { createExecutionVm } from "./vm.ts";
import type { WorkerMessage, WorkerRequest } from "./worker-contract.ts";

function readGuestError(handle: JSValueHandle, seen = new Map<number, Error>()): Error {
  if (!handle.isObject) {
    return new Error(handle.toString());
  }

  const previous = seen.get(handle.identity);

  if (previous) {
    return previous;
  }

  function readString(key: string): string | undefined {
    const property = handle.getProp(key);

    try {
      return property.isString ? property.toString() : undefined;
    } finally {
      property.dispose();
    }
  }

  const error = new Error(readString("message") ?? handle.toString());
  seen.set(handle.identity, error);
  error.name = readString("name") ?? "Error";
  error.stack = readString("stack");
  const code = readString("code");

  if (code !== undefined) {
    Object.assign(error, { code });
  }

  const cause = handle.getProp("cause");

  try {
    if (!cause.isUndefined) {
      error.cause = seen.size >= 8 ? new Error("Maximum error cause depth exceeded") : readGuestError(cause, seen);
    }
  } finally {
    cause.dispose();
  }

  return error;
}

/** One worker owns all live resources. The supervisor forcibly terminates it before publishing its result. */
export async function executeWorkerRun({
  request: { manifest, assets, template: dependencyTemplate, mode, debug, queryPlans },
  send,
  createDatabase,
}: {
  request: WorkerRequest;
  send: (message: WorkerMessage, transfer?: ArrayBuffer[]) => void;
  createDatabase: (
    dialect: WorkerRequest["manifest"]["target"]["dialect"],
    template?: Blob,
  ) => DatabaseEngine & { terminate(): Promise<void> };
}): Promise<ExecutionResult> {
  let template = dependencyTemplate;
  const started = performance.now();
  const timings: Record<string, number> = {};
  const memory: Record<string, number | boolean> = {};
  const modules = new Map<string, string>();
  let context: Awaited<ReturnType<typeof createExecutionVm>> | undefined;
  let database: (DatabaseEngine & { terminate(): Promise<void> }) | undefined;
  let sql: string[] = [];
  let schemaKeys: SchemaTableKeys[] = [];
  let value: SerializedValue = { type: "undefined" };
  let displays: z.output<typeof DisplaysSchema> = [];
  const cleanupDiagnostics: string[] = [];
  const cleanup: BackendCleanup = { guest: { mode: "graceful" }, database: { mode: "graceful" } };
  const pending = new Set<Deferred>();
  const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; callback: JSValueHandle }>();
  const rejections = new Map<number, { cause: Error; timer: ReturnType<typeof setTimeout> }>();
  const asynchronousFailure = Promise.withResolvers<Error>();
  let uncaughtError: Error | undefined;
  let nextTimer = 0;
  let actor: ActorRefFrom<ReturnType<typeof createPhaseMachine>>;
  let compiled: Awaited<ReturnType<typeof compileManifest>> | undefined;
  let locateError: ReturnType<typeof createErrorLocator> | undefined;
  let warnings: Diagnostic[] = [];
  const sqlEvents: SqlEvent[] = [];
  let outputBytes = 0;
  let report: Extract<RuntimeWorkerMessage, { kind: "report" }> | undefined;

  function failAsynchronously(cause: unknown) {
    uncaughtError ??= cause instanceof Error ? cause : new Error(String(cause));
    asynchronousFailure.resolve(uncaughtError);
  }

  function emit(message: RuntimeWorkerMessage) {
    const parsed = parseRuntimeWorkerMessage(message);
    outputBytes += new TextEncoder().encode(JSON.stringify(parsed)).byteLength;

    if (outputBytes > 16 * 1024 * 1024) {
      throw new RangeError("Execution output exceeds 16 MiB");
    }

    if (parsed.kind === "event" && parsed.type === "sql") {
      sqlEvents.push(parsed.payload);
    }

    send({ type: "message", message: parsed });
  }

  function getContext() {
    if (!context) {
      throw new Error("QuickJS execution VM is unavailable in this phase");
    }

    return context;
  }

  function evaluateValue(source: string): unknown {
    const handle = getContext().vm.evalCode(`JSON.stringify(${source})`);

    try {
      return JSON.parse(handle.toString());
    } finally {
      handle.dispose();
    }
  }

  async function evaluate(source: string, name: string) {
    const handle = getContext().vm.evalCode(source, name, EvalFlags.TYPE_MODULE);

    try {
      getContext().vm.markPromiseHandled(handle);
      const promise = getContext().vm.resolvePromise(handle);
      getContext().vm.executePendingJobs();
      const result = await Promise.race([
        promise,
        asynchronousFailure.promise.then((cause) => {
          throw cause;
        }),
      ]);

      if ("error" in result) {
        let error: Error;

        try {
          error = readGuestError(result.error);
        } finally {
          result.error.dispose();
        }

        throw error;
      }

      result.value.dispose();
    } finally {
      handle.dispose();
    }
  }

  const effects: Record<ExecutionPhase, () => Promise<void>> = {
    async compile() {
      compiled = await compileManifest({
        manifest,
        compilerBytes: assets.compilerBytes,
        compilerModule: assets.compilerModule,
        catalog: assets.catalog,
      });
      locateError = createErrorLocator(compiled.sourceMap);
      warnings = compiled.warnings;
      emit({ kind: "compiled", sourceMap: compiled.sourceMap });

      for (const warning of warnings) {
        emit({ kind: "event", type: "diagnostic", payload: warning });
      }
    },
    async setup() {
      const wasm = await WebAssembly.compile(new Uint8Array(assets.wasmBytes));
      const extensions = await Promise.all(
        assets.extensionBytes.map(async ({ name, bytes }) => ({
          name,
          wasm: await WebAssembly.compile(new Uint8Array(bytes)),
        })),
      );
      context = await createExecutionVm({
        wasm,
        extensions,
        modules,
        startedAtMs: started,
        template,
        onUnhandledRejection(promise, reason, handled) {
          const previous = rejections.get(promise.identity);

          if (previous) {
            clearTimeout(previous.timer);
            rejections.delete(promise.identity);
          }

          if (!handled) {
            const cause = readGuestError(reason);
            const timer = setTimeout(() => failAsynchronously(cause), 1_000);
            rejections.set(promise.identity, { cause, timer });
          }
        },
      });

      if (!template) {
        getContext().vm.evalCode(assets.bundle, "dependencies.js").dispose();
      }

      memory.guestDependencyLinearBytes = getContext().vm._getMemory().buffer.byteLength;
      memory.guestDependencyMallocBytes = getContext().vm.getMemoryUsage().mallocSize;

      if (!template && mode === "snapshot") {
        if (context.intlFormatters.length || modules.size) {
          throw new Error("Snapshot contains host resources or project modules");
        }

        const captureStarted = performance.now();
        const captured = getContext().vm.snapshot();
        timings.captureMs = performance.now() - captureStarted;
        memory.templateBytes = captured.memory.byteLength;

        if (!(captured.memory.buffer instanceof ArrayBuffer)) {
          throw new Error("QuickJS snapshot must own a transferable ArrayBuffer");
        }

        const snapshotMemory = new Uint8Array(
          captured.memory.buffer,
          captured.memory.byteOffset,
          captured.memory.byteLength,
        );
        send({ type: "template", template: { ...captured, memory: snapshotMemory } }, [snapshotMemory.buffer]);
      } else {
        memory.templateBytes = template?.memory.byteLength ?? 0;
      }

      memory.restored = Boolean(template);
      memory.firstUsesOriginalVm = !template && mode === "snapshot";
      template = undefined;
      const vm = getContext().vm;
      const timerCallbacks: [string, HostFunction][] = [
        [
          "setTimeout",
          (fn, delay) => {
            const id = ++nextTimer;
            const callback = fn.dup();
            const timer = setTimeout(
              () => {
                timers.delete(id);

                try {
                  vm.callFunction(callback, vm.undefined).dispose();
                  vm.executePendingJobs();
                } catch (cause) {
                  failAsynchronously(cause);
                } finally {
                  callback.dispose();
                }
              },
              Math.max(0, delay?.toNumber() ?? 0),
            );
            timers.set(id, { timer, callback });

            return vm.newNumber(id);
          },
        ],
        [
          "clearTimeout",
          (id) => {
            const entry = timers.get(id?.toNumber());

            if (entry) {
              clearTimeout(entry.timer);
              entry.callback.dispose();
              timers.delete(id.toNumber());
            }

            return vm.undefined;
          },
        ],
      ];

      for (const [name, callback] of timerCallbacks) {
        const handle = vm.newFunction(name, callback);
        vm.setProp(vm.global, name, handle);
        handle.dispose();
      }

      const databaseCallback = vm.newFunction("hostDatabaseCall", (operation, encoded) => {
        if (
          !database ||
          !(["database", "seed", "run", "inspect"] as const).some((phase) => actor.getSnapshot().matches(phase))
        ) {
          throw new Error("Database callbacks are not admitted in this phase");
        }

        const deferred = vm.newPromise();
        pending.add(deferred);
        database
          .call(operation.toString(), decodeDatabaseValue(JSON.parse(encoded.toString())))
          .then(
            (reply) =>
              settle({
                deferred,
                result: JSON.stringify({ ok: true, value: encodeDatabaseValue(reply) }),
                status: "fulfilled",
              }),
            (cause) =>
              settle({
                deferred,
                result: JSON.stringify({ ok: false, error: serializeDatabaseError(cause) }),
                status: "fulfilled",
              }),
          )
          .catch(failAsynchronously);

        return deferred.handle;
      });
      vm.setProp(vm.global, "hostDatabaseCall", databaseCallback);
      databaseCallback.dispose();
      const eventCallback = vm.newFunction("hostRuntimeEvent", (encoded) => {
        emit(parseRuntimeWorkerMessage(JSON.parse(encoded.toString())));

        return vm.undefined;
      });
      vm.setProp(vm.global, "hostRuntimeEvent", eventCallback);
      eventCallback.dispose();
      const seed = manifest.randomSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
      vm.evalCode(`kitProbe.initializeExecution(${JSON.stringify(manifest)}, ${seed});`).dispose();

      if (!compiled) {
        throw new Error("Missing compiled QuickJS project");
      }

      modules.set(bundlePath, compiled.code);
      compiled = undefined;
      await evaluate(`import * as project from "./${bundlePath}"; globalThis.__project = project;`, "runtime:project");
    },
    async schema() {
      await evaluate("globalThis.__schema = await __project.evaluateSchema();", "runtime:schema");

      if (queryPlans) {
        schemaKeys = parseSchemaTableKeys(
          evaluateValue(`(() => {
          const orm = kitProbe.modules["drizzle-orm"];
          const core = kitProbe.modules[${JSON.stringify(manifest.target.dialect === "sqlite" ? "drizzle-orm/sqlite-core" : "drizzle-orm/pg-core")}];
          return Object.values(__schema).filter(value => orm.is(value, orm.Table)).map(table => {
            const config = core.getTableConfig(table);
            return {
              name: config.name,
              ...(config.schema === undefined ? {} : { schema: config.schema }),
              columns: Object.fromEntries(Object.entries(orm.getTableColumns(table)).map(([key, column]) => [column.name, key])),
            };
          });
        })()`),
        );
      }
    },
    async sql() {
      await evaluate("globalThis.__sql = await kitProbe.generateSql(__schema, 'postgresql');", "runtime:sql");
      sql = z.array(z.string()).parse(evaluateValue("__sql"));
      if (sql.some((statement) => /\bPOLICY\b|ROW LEVEL SECURITY/i.test(statement))) {
        emit({
          kind: "event",
          type: "diagnostic",
          payload: {
            severity: "info",
            code: "RLS_NOT_ENFORCED",
            message:
              "RLS declarations are supported. Playground results do not demonstrate authorization or RLS enforcement.",
          },
        });
      }
      await evaluate("for (const statement of __sql) __observation.generated(statement);", "runtime:generated");
    },
    async database() {
      database = createDatabase(manifest.target.dialect, assets.databaseTemplate);
      memory.databaseRestored = manifest.target.dialect === "postgresql" && Boolean(assets.databaseTemplate);
      memory.databaseTemplateBytes = assets.databaseTemplate?.size ?? 0;
      await evaluate(
        "__observation.setPhase('bootstrap'); globalThis.__runContext = await kitProbe.initializeRun(__schema, __runManifest.env ?? {}, __observation); __project.initializeContext(__runContext);",
        "runtime:database",
      );

      if (manifest.target.dialect === "sqlite") {
        await evaluate("await __runContext.client.batch(__sql, 'write');", "runtime:bootstrap");
      } else {
        if (sql.some((statement) => /\bvector\s*\(/i.test(statement))) {
          await database.call("pg.enable-vector", undefined);
        }

        await evaluate(
          "await kitProbe.applyPostgresBootstrap({ client: __runContext.client, statements: __sql });",
          "runtime:bootstrap",
        );
      }
    },
    async seed() {
      await evaluate("__observation.setPhase('seed');", "runtime:seed-phase");
      if (manifest.entrypoints.seed) {
        await evaluate("await __project.evaluateSeed();", "runtime:seed");
      }
    },
    async run() {
      await evaluate("__observation.setPhase('run');", "runtime:run-phase");
      if (manifest.entrypoints.run) {
        await evaluate("globalThis.__value = (await __project.evaluateRun()).default;", "runtime:run");
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const rejection = rejections.values().next().value;
      const failure = uncaughtError ?? rejection?.cause;

      if (failure) {
        throw failure;
      }

      value = SerializedValueSchema.parse(evaluateValue("kitProbe.encodeResult(globalThis.__value)"));
      displays = DisplaysSchema.parse(evaluateValue("__displays"));

      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) {
        throw new RangeError("Serialized result exceeds 2 MiB. Log or return less of it.");
      }

      memory.guestFinalLinearBytes = getContext().vm._getMemory().buffer.byteLength;
      const runtimeValue = CoreSerializedValueSchema.parse(
        evaluateValue("__observation.serializeValue(globalThis.__value)"),
      );
      const completed = parseRuntimeWorkerMessage({
        kind: "report",
        outcome: "succeeded",
        value: runtimeValue,
        transactions: evaluateValue("__observation.reportTransactions() ?? null") ?? undefined,
      });

      if (completed.kind !== "report") {
        throw new Error("Expected a completed run report");
      }

      report = completed;
    },
    async inspect() {
      await evaluate("__observation.setPhase('inspect'); await __runContext.close();", "runtime:connections-close");

      if (!database || !report) {
        throw new Error("Missing execution resources before inspection");
      }

      report = { ...report, database: encodeDatabaseValue(await database.call("inspect", undefined)) };
    },
    async plan() {
      if (!queryPlans) {
        return;
      }

      if (!database || !report) {
        throw new Error("Missing execution resources before query planning");
      }

      let pendingPlans = 0;
      const planningDatabase = database;
      report = {
        ...report,
        queryPlans: await planQueries({
          database: {
            async call(operation, requestValue) {
              pendingPlans += 1;

              try {
                return await planningDatabase.call(operation, requestValue);
              } finally {
                pendingPlans -= 1;
              }
            },
          },
          dialect: manifest.target.dialect,
          settings: queryPlans,
          events: sqlEvents,
          keys: schemaKeys,
        }),
      };

      if (pendingPlans > 0) {
        cleanup.database = { mode: "forced", reason: PLANNING_ABANDONED_CLEANUP_REASON };
        // Native planning may block worker termination; the supervisor kills the container before publishing.
        database = undefined;
      }
    },
    async cleanup() {
      for (const rejection of rejections.values()) {
        clearTimeout(rejection.timer);
      }

      rejections.clear();
      pending.clear();

      try {
        await stopCompiler();
      } catch (cause) {
        cleanupDiagnostics.push(`Compiler: ${toExecutionError({ cause, phase: "cleanup" }).message}`);
        cleanup.guest = { mode: "forced", reason: "compiler_close_failed" };
      }

      for (const { timer, callback } of timers.values()) {
        clearTimeout(timer);

        try {
          callback.dispose();
        } catch (cause) {
          cleanupDiagnostics.push(`Timer: ${toExecutionError({ cause, phase: "cleanup" }).message}`);
          cleanup.guest = { mode: "forced", reason: "timer_close_failed" };
        }
      }

      timers.clear();

      try {
        context?.vm.dispose();
      } catch (cause) {
        cleanupDiagnostics.push(`VM: ${toExecutionError({ cause, phase: "cleanup" }).message}`);
        cleanup.guest = { mode: "forced", reason: "vm_close_failed" };
      }

      if (database) {
        try {
          await database.close();
        } catch (cause) {
          cleanupDiagnostics.push(`Database: ${toExecutionError({ cause, phase: "cleanup" }).message}`);
          cleanup.database = { mode: "forced", reason: "database_close_failed" };
        }
      }
    },
  };

  function settle({
    deferred,
    result,
    status,
  }: {
    deferred: Deferred;
    result: number[] | string;
    status: "fulfilled" | "rejected";
  }) {
    if (!pending.delete(deferred) || actor.getSnapshot().matches("cleanup") || actor.getSnapshot().status === "done") {
      return;
    }

    const handle = getContext().vm.hostToHandle(result);

    try {
      if (status === "rejected") {
        deferred.reject(handle);
      } else {
        deferred.resolve(handle);
      }

      getContext().vm.executePendingJobs();
    } finally {
      handle.dispose();
    }
  }

  const machine = createPhaseMachine(async (phase) => {
    const phaseStarted = performance.now();
    send({ type: "phase", phase });
    const runtimePhases: Record<ExecutionPhase, RuntimePhase> = {
      compile: "compile",
      setup: "load_artifacts",
      schema: "evaluate_schema",
      sql: "generate_bootstrap",
      database: "apply_bootstrap",
      seed: "seed",
      run: "run",
      inspect: "inspect",
      plan: "plan",
      cleanup: "cleanup",
    };
    emit({ kind: "phase", phase: runtimePhases[phase], status: "running" });

    try {
      await effects[phase]();
      emit({
        kind: "phase",
        phase: runtimePhases[phase],
        status: "succeeded",
        durationMs: performance.now() - phaseStarted,
      });
    } catch (failure) {
      const cause = context?.wasInterrupted() ? new QuickjsTimeoutError(failure) : failure;

      if (debug) {
        console.warn(`QuickJS ${phase} failed`, cause);
      }

      const diagnostic = locateError?.(cause);
      if (phase === "compile") {
        for (const compilationDiagnostic of toExecutionError({ cause, phase }).diagnostics ?? []) {
          emit({ kind: "event", type: "diagnostic", payload: compilationDiagnostic });
        }
      }
      if (uncaughtError || rejections.size > 0) {
        emit({
          kind: "event",
          type: "diagnostic",
          payload: {
            severity: "error",
            code: "UNHANDLED_ERROR",
            message:
              "The run left a promise rejection or a timer error unhandled. Await the promise, or catch its error.",
          },
        });
      }
      emit({
        kind: "phase",
        phase: runtimePhases[phase],
        status: "failed",
        durationMs: performance.now() - phaseStarted,
      });
      report = {
        kind: "report",
        outcome: "failed",
        value: report?.value ?? { type: "undefined" },
        error: {
          ...serializeError(cause),
          phase: runtimePhases[phase],
          ...(cause instanceof QuickjsTimeoutError ? { code: "run_timeout" as const } : {}),
        },
      };

      if (diagnostic) {
        const details = toExecutionError({ cause, phase });

        throw Object.assign(new Error(details.message, { cause }), details, { diagnostics: [diagnostic] });
      }

      throw cause;
    } finally {
      timings[`${phase}Ms`] = performance.now() - phaseStarted;
    }
  });

  return new Promise<ExecutionResult>((resolve) => {
    actor = createActor(machine);
    actor.subscribe({
      complete() {
        const error = actor.getSnapshot().context.error;
        if (report) {
          emit(report);
        }
        resolve({
          ...(error ? ({ status: "error", error } as const) : ({ status: "success", sql, value, displays } as const)),
          logs: context?.logs ?? [],
          warnings,
          timings: { ...timings, workerTotalMs: performance.now() - started },
          memory,
          cleanupDiagnostics,
          cleanup,
        });
      },
    });
    actor.start();
  });
}
