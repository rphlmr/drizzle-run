import { findSupportedTuple } from "@drizzle-run/core/catalog";
import type {
  Runtime,
  RuntimeCapabilities,
  RuntimeSnapshot,
  RunTuple,
  CreateRunOptions,
  PrepareOptions,
  ComparisonHandle,
  ComparisonManifest,
  CreateComparisonOptions,
  RunHandle,
} from "@drizzle-run/core/contracts";
import { serializeError } from "@drizzle-run/core/contracts";
import { GUEST_STOPPED_CLEANUP_REASON } from "@drizzle-run/core/contracts";
import { parseRunManifest, type RunManifest } from "@drizzle-run/core/manifest";
import { assign, createActor, fromPromise, setup, waitFor, toPromise } from "xstate";

import { assertCapabilitiesAvailable } from "../browser/capabilities.ts";
import { BrowserRuntimeError, reportObserverFailure } from "../browser/errors.ts";
import type { RuntimePreparation } from "../browser/preparation.ts";
import { BrowserRunImpl, cancelRunOnAbort, type ExecutionOutcome, type RunExecutor } from "../browser/run.ts";
import { BackendError } from "../execution-contract.ts";
import { declareType } from "../machines/declare-type.ts";
import { parseQueryPlansSettings } from "../query-plans/sizes.ts";
import { createCoordinatorMachine } from "./comparison.ts";
import type { QuickjsRunner } from "./contract.ts";
import { guestAssetPrefix, selectGuest, type GuestSelection } from "./selection.ts";

interface RuntimeTask {
  manifest: RunManifest;
  selection: GuestSelection;
  controller: AbortController;
  execute(runner: QuickjsRunner, signal: AbortSignal): Promise<void>;
  complete(): void;
  fail(cause: unknown): void;
}

interface RuntimeContext {
  requests: RuntimeTask[];
  task: RuntimeTask | null;
  runner: QuickjsRunner | null;
  key: string | null;
  disposition: "open" | "closing";
  capabilities?: RuntimeCapabilities;
  error?: ReturnType<typeof serializeError>;
  failure?: Error;
}

interface RuntimeDependencies {
  preparation?: RuntimePreparation;
  checkCapabilities(): Promise<RuntimeCapabilities>;
  createRunner(selection: GuestSelection, signal: AbortSignal): Promise<QuickjsRunner>;
}

export const RUNTIME_ACTOR_IDS = {
  check: "runtimeCheck",
  replace: "runtimeReplace",
  load: "runtimeLoad",
  work: "runtimeWork",
  release: "runtimeRelease",
  dispose: "runtimeDispose",
} as const;

function disposedError() {
  return new BrowserRuntimeError("runtime_disposed", "This runtime has been disposed.");
}

function requireTask(task: RuntimeTask | null): RuntimeTask {
  if (!task) {
    throw new Error("Missing active runtime task");
  }

  return task;
}

function throwCleanupFailures(results: PromiseSettledResult<unknown>[]): void {
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) =>
      result.reason instanceof Error
        ? result.reason
        : new Error("Runtime resource cleanup failed", { cause: result.reason }),
    );

  if (failures.length === 1) {
    throw failures[0];
  }

  if (failures.length > 1) {
    throw new AggregateError(failures, "Runtime resource cleanup failed");
  }
}

/** Own the selected immutable assets and snapshot. A runner itself allocates a fresh container for every run. */
export function createRuntimeMachine(dependencies: RuntimeDependencies) {
  return setup({
    types: {
      context: declareType<RuntimeContext>(),
      events: declareType<
        | { type: "task.request"; task: RuntimeTask }
        | { type: "task.cancel"; task: RuntimeTask }
        | { type: "runtime.dispose" }
      >(),
    },
    actors: {
      check: fromPromise(async () => {
        const capabilities = await dependencies.checkCapabilities();
        assertCapabilitiesAvailable(capabilities);

        return capabilities;
      }),
      close: fromPromise<void, QuickjsRunner | null>(async ({ input }) => {
        await input?.close();
      }),
      load: fromPromise<QuickjsRunner, RuntimeTask>(async ({ input }) => {
        input.controller.signal.throwIfAborted();
        const runner = await dependencies.createRunner(input.selection, input.controller.signal);

        if (input.controller.signal.aborted) {
          await runner.close();
          input.controller.signal.throwIfAborted();
        }

        return runner;
      }),
      work: fromPromise<void, { task: RuntimeTask; runner: QuickjsRunner | null }>(async ({ input }) => {
        input.task.controller.signal.throwIfAborted();

        if (!input.runner) {
          throw new Error("Missing prepared QuickJS runner");
        }

        await input.task.execute(input.runner, input.task.controller.signal);
      }),
    },
    actions: {
      enqueue: assign(({ context, event }) =>
        event.type === "task.request" ? { requests: [...context.requests, event.task] } : {},
      ),
      cancelQueued: assign(({ context, event }) => {
        if (event.type !== "task.cancel" || !context.requests.includes(event.task)) {
          return {};
        }

        event.task.fail(event.task.controller.signal.reason);

        return { requests: context.requests.filter((task) => task !== event.task) };
      }),
      take: assign(({ context }) => ({
        task: context.requests[0],
        requests: context.requests.slice(1),
        error: undefined,
      })),
      settleTask: ({ context }) => {
        if (context.failure) {
          context.task?.fail(context.failure);
        } else {
          context.task?.complete();
        }
      },
      clearTask: assign({ task: null, failure: undefined }),
      clearRunner: assign({ runner: null, key: null }),
      fail: assign(({ context }, cause: unknown) => {
        const failure = cause instanceof Error ? cause : new Error("Runtime task failed", { cause });

        return { error: serializeError(failure), failure: context.failure ?? failure };
      }),
      refuseQueue: assign(({ context }) => {
        for (const request of context.requests) {
          request.fail(context.failure ?? disposedError());
        }

        return { requests: [] };
      }),
      refuse: ({ event }) => {
        if (event.type === "task.request") {
          event.task.fail(disposedError());
        }
      },
      dispose: assign(({ context }) => {
        context.task?.controller.abort();

        for (const request of context.requests) {
          request.fail(disposedError());
        }

        return { disposition: "closing" as const, requests: [] };
      }),
    },
  }).createMachine({
    id: "runtime",
    initial: "idle",
    context: { requests: [], task: null, runner: null, key: null, disposition: "open" },
    on: {
      "task.cancel": { actions: "cancelQueued" },
      "task.request": [
        { guard: ({ context }) => context.disposition === "open", actions: "enqueue" },
        { actions: "refuse" },
      ],
      "runtime.dispose": { actions: "dispose" },
    },
    states: {
      idle: {
        always: [
          { guard: ({ context }) => context.disposition === "closing", target: "disposing" },
          { guard: ({ context }) => context.requests.length > 0, target: "active", actions: "take" },
        ],
      },
      active: {
        initial: "checking",
        states: {
          checking: {
            invoke: {
              id: RUNTIME_ACTOR_IDS.check,
              src: "check",
              onDone: { target: "selecting", actions: assign({ capabilities: ({ event }) => event.output }) },
              onError: {
                target: "releasing",
                actions: { type: "fail", params: ({ event }: { event: { error: unknown } }) => event.error },
              },
            },
          },
          selecting: {
            always: [
              {
                guard: ({ context }) =>
                  context.runner !== null && context.key === guestAssetPrefix(requireTask(context.task).selection),
                target: "working",
              },
              { target: "replacing" },
            ],
          },
          replacing: {
            invoke: {
              id: RUNTIME_ACTOR_IDS.replace,
              src: "close",
              input: ({ context }) => context.runner,
              onDone: { target: "loading", actions: "clearRunner" },
              onError: {
                target: "failed",
                actions: { type: "fail", params: ({ event }: { event: { error: unknown } }) => event.error },
              },
            },
          },
          loading: {
            invoke: {
              id: RUNTIME_ACTOR_IDS.load,
              src: "load",
              input: ({ context }) => requireTask(context.task),
              onDone: {
                target: "working",
                actions: assign({
                  runner: ({ event }) => event.output,
                  key: ({ context }) => guestAssetPrefix(requireTask(context.task).selection),
                }),
              },
              onError: {
                target: "releasing",
                actions: { type: "fail", params: ({ event }: { event: { error: unknown } }) => event.error },
              },
            },
          },
          working: {
            invoke: {
              id: RUNTIME_ACTOR_IDS.work,
              src: "work",
              input: ({ context }) => ({ task: requireTask(context.task), runner: context.runner }),
              onDone: "releasing",
              onError: {
                target: "releasing",
                actions: { type: "fail", params: ({ event }: { event: { error: unknown } }) => event.error },
              },
            },
          },
          releasing: {
            always: [
              {
                guard: ({ context }) => dependencies.preparation === "on_demand" || context.disposition === "closing",
                target: "closing",
              },
              { target: "#runtime.idle", actions: ["settleTask", "clearTask"] },
            ],
          },
          closing: {
            invoke: {
              id: RUNTIME_ACTOR_IDS.release,
              src: "close",
              input: ({ context }) => context.runner,
              onDone: { target: "#runtime.idle", actions: ["clearRunner", "settleTask", "clearTask"] },
              onError: {
                target: "failed",
                actions: { type: "fail", params: ({ event }: { event: { error: unknown } }) => event.error },
              },
            },
          },
          // Failed teardown must not admit another execution or claim successful disposal.
          failed: { entry: ["settleTask", "refuseQueue", "clearTask"], on: { "task.request": { actions: "refuse" } } },
        },
      },
      disposing: {
        invoke: {
          id: RUNTIME_ACTOR_IDS.dispose,
          src: "close",
          input: ({ context }) => context.runner,
          onDone: { target: "disposed", actions: "clearRunner" },
          onError: {
            target: "disposeFailed",
            actions: { type: "fail", params: ({ event }: { event: { error: unknown } }) => event.error },
          },
        },
      },
      disposeFailed: { entry: "refuseQueue", on: { "task.request": { actions: "refuse" } } },
      disposed: { type: "final" },
    },
  });
}

/** Public SDK controller shared by Node and browser composition roots. */
export function createQuickjsRuntime(dependencies: RuntimeDependencies): Runtime {
  const actor = createActor(createRuntimeMachine(dependencies)).start();
  const handles = new Set<BrowserRunImpl>();
  const comparisons = new Set<ComparisonHandle>();
  const executor: RunExecutor = { execute };
  let disposal: Promise<void> | undefined;

  function assertOpen() {
    if (actor.getSnapshot().context.disposition !== "open" || actor.getSnapshot().matches({ active: "failed" })) {
      throw disposedError();
    }
  }

  function request(
    manifest: RunManifest,
    signal: AbortSignal | undefined,
    executeTask: RuntimeTask["execute"],
  ): Promise<void> {
    assertOpen();
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const task = {
      manifest,
      selection: selectGuest(manifest),
      controller,
      fail: completion.reject,
      complete: completion.resolve,
      execute: executeTask,
    };
    const cancel = () => {
      controller.abort();
      actor.send({ type: "task.cancel", task });
    };
    signal?.addEventListener("abort", cancel, { once: true });

    if (signal?.aborted) {
      controller.abort();
      completion.reject(controller.signal.reason);
    } else {
      actor.send({ type: "task.request", task });
    }

    return completion.promise.finally(() => signal?.removeEventListener("abort", cancel));
  }

  async function execute(
    ...[, manifest, , effectiveSeed, signal, onMessage, onReady, queryPlans]: Parameters<RunExecutor["execute"]>
  ): Promise<ExecutionOutcome> {
    let report: ExecutionOutcome["report"];
    let failure: unknown;
    let cleanup: ExecutionOutcome["cleanup"] = { guest: { mode: "graceful" }, database: { mode: "graceful" } };
    const started = performance.now();

    try {
      await request(manifest, signal, async (runner, executionSignal) => {
        onReady(performance.now() - started);
        const result = await runner.run(
          { ...manifest, randomSeed: effectiveSeed },
          {
            signal: executionSignal,
            queryPlans,
            onMessage(message) {
              if (message.kind === "report") {
                report = message;
              }

              onMessage(message);
            },
          },
        );

        if (result.status !== "success" && (!report || result.error.code === "cleanup_failed")) {
          failure = new BackendError(
            result.error.code === "cleanup_failed"
              ? "cleanup_failed"
              : result.error.code === "run_timeout"
                ? "run_timeout"
                : "worker_failure",
            result.error.message,
          );
        }

        if (result.cleanup) {
          cleanup = result.cleanup;
        } else if (result.workerTerminated) {
          cleanup = {
            guest: { mode: "forced", reason: GUEST_STOPPED_CLEANUP_REASON },
            database: { mode: "forced", reason: GUEST_STOPPED_CLEANUP_REASON },
          };
        }
      });
    } catch (cause) {
      failure = cause;
    }

    return { report, failure, cleanup };
  }

  function getSnapshot(): RuntimeSnapshot {
    const snapshot = actor.getSnapshot();
    const { capabilities, error } = snapshot.context;
    const state: RuntimeSnapshot["state"] =
      snapshot.status === "done"
        ? "disposed"
        : snapshot.context.disposition === "closing"
          ? "disposing"
          : error
            ? "failed"
            : snapshot.matches({ active: "checking" })
              ? "checking"
              : snapshot.matches({ active: "loading" })
                ? "acquiring"
                : snapshot.context.runner
                  ? "ready"
                  : "idle";

    return { state, ...(capabilities ? { capabilities } : {}), ...(error ? { error } : {}) };
  }

  function subscribe(listener: (snapshot: RuntimeSnapshot) => void) {
    function notify() {
      try {
        listener(getSnapshot());
      } catch (cause) {
        reportObserverFailure(cause);
      }
    }

    const subscription = actor.subscribe(notify);
    notify();

    return subscription;
  }

  function createRun(input: RunManifest, options: CreateRunOptions = {}) {
    assertOpen();
    const started = performance.now();
    const manifest = parseRunManifest(input);
    const validated = performance.now();
    const selected = findSupportedTuple({
      target: manifest.target,
      ormVersion: manifest.dependencies["drizzle-orm"],
      kitVersion: manifest.dependencies["drizzle-kit"],
    });

    if (!selected) {
      throw new BrowserRuntimeError("unsupported_tuple", "Unsupported ORM/Kit composition");
    }

    const tuple: RunTuple = {
      id: selected.id,
      target: manifest.target,
      ormVersion: selected.ormVersion,
      kitVersion: selected.kitVersion,
    };
    const handle = new BrowserRunImpl(
      executor,
      manifest,
      tuple,
      { validationDurationMs: validated - started, resolutionDurationMs: performance.now() - validated },
      () => handles.delete(handle),
      options.queryPlans ? parseQueryPlansSettings(options.queryPlans) : undefined,
    );
    handles.add(handle);

    if (options.signal) {
      cancelRunOnAbort(handle, options.signal);
    }

    return handle;
  }

  async function prepare(input: RunManifest, options: PrepareOptions = {}) {
    await request(parseRunManifest(input), options.signal, async () => {});
  }

  function createComparison(manifests: ComparisonManifest, options: CreateComparisonOptions = {}): ComparisonHandle {
    assertOpen();
    const parsed = { a: parseRunManifest(manifests.a), b: parseRunManifest(manifests.b) };
    const children = {
      a: createQuickjsRuntime({ ...dependencies, preparation: "on_demand" }),
      b: createQuickjsRuntime({ ...dependencies, preparation: "on_demand" }),
    };
    const sides = {
      a: children.a.createRun(parsed.a, { queryPlans: options.queryPlans }),
      b: children.b.createRun(parsed.b, { queryPlans: options.queryPlans }),
    };
    const cancellation = new AbortController();
    const coordinator = createActor(
      createCoordinatorMachine<RunHandle>({
        async executeSide({ side, controller }) {
          const handle = sides[side];
          const cancelSide = () => void handle.cancel();
          controller.signal.addEventListener("abort", cancelSide, { once: true });

          try {
            if (controller.signal.aborted) {
              await handle.cancel();
            } else {
              handle.start();
            }

            await handle.result;

            return handle;
          } finally {
            controller.signal.removeEventListener("abort", cancelSide);
            await children[side].dispose();
          }
        },
        cancelPending(side) {
          void sides[side].cancel();

          return sides[side];
        },
        failSide(_cause, side) {
          return sides[side];
        },
      }),
      { input: { manifests: parsed, mode: options.execution, signal: cancellation.signal } },
    );
    function start() {
      coordinator.start();
    }

    function requestCancellation() {
      cancellation.abort();
      coordinator.send({ type: "comparison.cancel" });
      start();
    }

    async function cancel() {
      requestCancellation();
      await result;
    }

    async function finishComparison() {
      try {
        await toPromise(coordinator);
        const [a, b] = await Promise.all([sides.a.result, sides.b.result]);

        return { a, b };
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        const cleanup = await Promise.allSettled([children.a.dispose(), children.b.dispose()]);
        throwCleanupFailures(cleanup);
        comparisons.delete(comparison);
      }
    }
    const result = finishComparison();
    const comparison: ComparisonHandle = {
      sides: {
        a: {
          result: sides.a.result,
          subscribe: (listener) => sides.a.subscribe(listener),
          subscribeEvent: (listener) => sides.a.subscribeEvent(listener),
        },
        b: {
          result: sides.b.result,
          subscribe: (listener) => sides.b.subscribe(listener),
          subscribeEvent: (listener) => sides.b.subscribeEvent(listener),
        },
      },
      result,
      start,
      cancel,
    };
    function onAbort() {
      requestCancellation();
    }
    comparisons.add(comparison);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.signal?.aborted) {
      onAbort();
    }

    return comparison;
  }

  async function checkCapabilities() {
    assertOpen();

    return dependencies.checkCapabilities();
  }

  function dispose(): Promise<void> {
    disposal ??= (async () => {
      const cancellations = [
        ...[...handles].map((handle) => handle.cancel()),
        ...[...comparisons].map((comparison) => comparison.cancel()),
      ];
      actor.send({ type: "runtime.dispose" });
      const ownCleanup = waitFor(
        actor,
        (state) => state.status === "done" || state.matches("disposeFailed") || state.matches({ active: "failed" }),
      ).then((snapshot) => {
        if (snapshot.status !== "done") {
          throw new Error(snapshot.context.error?.message ?? "Runtime disposal failed");
        }

        return;
      });
      const cleanup = await Promise.allSettled([...cancellations, ownCleanup]);
      throwCleanupFailures(cleanup);
    })();

    return disposal;
  }

  return {
    createRun,
    createComparison,
    prepare,
    checkCapabilities,
    getSnapshot,
    subscribe,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
