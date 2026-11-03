import { GUEST_STOPPED_CLEANUP_REASON } from "@drizzle-run/core/contracts";
import { assign, createActor, fromCallback, fromPromise, setup } from "xstate";

import { parseRuntimeWorkerMessage, type RuntimeWorkerMessage } from "../browser/protocol.ts";
import { BackendError } from "../execution-contract.ts";
import { declareType } from "../machines/declare-type.ts";
import type { ExecutionPhase, ExecutionResult, QuickjsManifest, RunOptions } from "./contract.ts";
import { QuickjsManifestSchema } from "./contract.ts";
import { notifyObserver, toExecutionError } from "./errors.ts";
import { guestAssetPrefix, selectGuest } from "./selection.ts";
import type { DependencyTemplate, ExecutionWorker, RunnerDependencies, WorkerRequest } from "./worker-contract.ts";
import { WorkerMessageSchema } from "./worker-contract.ts";

type RunRequest = RunOptions & {
  manifest: QuickjsManifest;
  timeoutMs: number;
  resolve: (result: ExecutionResult) => void;
};

type RunnerEvent =
  | { type: "run.request"; request: RunRequest }
  | { type: "execution.phase"; phase: ExecutionPhase }
  | { type: "execution.message"; message: RuntimeWorkerMessage }
  | { type: "execution.template"; template: DependencyTemplate }
  | { type: "execution.result"; result: ExecutionResult }
  | { type: "execution.fail"; cause: unknown }
  | { type: "execution.cancel" }
  | { type: "runner.close"; reply: (cause: Error | null) => void };

type RunnerContext = {
  resources: RunnerDependencies | null;
  request: RunRequest | null;
  worker: ExecutionWorker | null;
  template: DependencyTemplate | undefined;
  phase: ExecutionPhase;
  result: ExecutionResult | null;
  startedAtMs: number;
};

function requireValue<Value>(value: Value | null, name: string): Value {
  if (value === null) {
    throw new Error(`Missing ${name} in active QuickJS execution`);
  }

  return value;
}

export const WORKER_ACQUISITION_ACTOR_ID = "executionHostAcquisition";
export const WORKER_TRANSPORT_ACTOR_ID = "executionHostTransport";
export const WORKER_TERMINATION_ACTOR_ID = "executionHostTermination";

/** Own one execution host at a time. Results and subsequent admission wait for forced termination. */
export function createRunnerMachine() {
  const machine = setup({
    types: {
      context: declareType<RunnerContext>(),
      events: declareType<RunnerEvent>(),
      input: declareType<() => RunnerDependencies>(),
    },
    actors: {
      acquire: fromPromise<ExecutionWorker, RunnerDependencies>(async ({ input }) => input.createWorker()),
      terminate: fromPromise<void, ExecutionWorker>(async ({ input }) => {
        await input.terminate();
      }),
      observe: fromCallback<RunnerEvent, { worker: ExecutionWorker; request: RunRequest; payload: WorkerRequest }>(
        ({ input, sendBack }) => {
          const cancel = () => sendBack({ type: "execution.cancel" });

          try {
            input.worker.listen(
              (message) => {
                const parsed = WorkerMessageSchema.safeParse(message);

                if (!parsed.success) {
                  sendBack({ type: "execution.fail", cause: new Error("Invalid QuickJS execution worker message") });

                  return;
                }

                switch (parsed.data.type) {
                  case "phase":
                    sendBack({ type: "execution.phase", phase: parsed.data.phase });
                    break;
                  case "template":
                    sendBack({ type: "execution.template", template: parsed.data.template });
                    break;
                  case "result":
                    sendBack({ type: "execution.result", result: parsed.data.result });
                    break;
                  case "message":
                    try {
                      sendBack({ type: "execution.message", message: parseRuntimeWorkerMessage(parsed.data.message) });
                    } catch (cause) {
                      sendBack({ type: "execution.fail", cause });
                    }
                    break;
                }
              },
              (cause) => sendBack({ type: "execution.fail", cause }),
            );
            input.request.signal?.addEventListener("abort", cancel, { once: true });

            if (input.request.signal?.aborted) {
              cancel();
            } else {
              input.worker.send(input.payload);
            }
          } catch (cause) {
            sendBack({ type: "execution.fail", cause });
          }

          return () => input.request.signal?.removeEventListener("abort", cancel);
        },
      ),
    },
    delays: { executionDeadline: ({ context }) => requireValue(context.request, "request").timeoutMs },
    actions: {
      accept: assign(({ event }) => {
        if (event.type !== "run.request") {
          return {};
        }

        return { request: event.request, phase: "compile" as const, startedAtMs: performance.now() };
      }),
      rejectBusy: ({ event }) => {
        if (event.type === "run.request") {
          event.request.resolve({
            status: "error",
            error: { phase: "admission", message: "Runner already owns an execution host" },
          });
        }
      },
      rejectClosed: ({ event }) => {
        if (event.type === "run.request") {
          event.request.resolve({ status: "error", error: { phase: "admission", message: "Runner is closed" } });
        }
      },
      rejectClose: ({ event }) => {
        if (event.type === "runner.close") {
          event.reply(new Error("Await or cancel the active run before closing its runner"));
        }
      },
      acknowledgeClose: ({ event }) => {
        if (event.type === "runner.close") {
          event.reply(null);
        }
      },
      recordCancellation: assign(({ context }) => ({
        result: { status: "cancelled" as const, error: { phase: context.phase, message: "Run cancelled" } },
      })),
      recordTimeout: assign(({ context }) => ({
        result: {
          status: "error" as const,
          error: { phase: context.phase, message: "Run exceeded timeout", code: "run_timeout" },
        },
      })),
      recordCleanupFailure: assign(({ context, event }) => {
        const details = toExecutionError({ cause: "error" in event ? event.error : undefined, phase: "cleanup" });
        return {
          result: {
            ...context.result,
            status: "error" as const,
            error: { ...details, code: "cleanup_failed" },
            cleanup: {
              guest: { mode: "forced" as const, reason: "host_termination_failed" },
              database: { mode: "forced" as const, reason: "host_termination_failed" },
            },
            cleanupDiagnostics: [...(context.result?.cleanupDiagnostics ?? []), details.message],
            totalMs: performance.now() - context.startedAtMs,
            workerTerminated: undefined,
          },
        };
      }),
      publishCleanupFailure: ({ context }) => {
        requireValue(context.request, "request").resolve(requireValue(context.result, "cleanup failure"));
      },
      rejectFailedClose: ({ event }) => {
        if (event.type === "runner.close") {
          event.reply(
            new BackendError("cleanup_failed", "Execution host cleanup failed; this runner is closed", {
              phase: "cleanup",
            }),
          );
        }
      },
      publish: ({ context }) => {
        const result = requireValue(context.result, "result");
        requireValue(context.request, "request").resolve({
          ...result,
          cleanup: result.cleanup ?? {
            guest: { mode: "forced", reason: GUEST_STOPPED_CLEANUP_REASON },
            database: ["database", "seed", "run", "inspect", "plan", "cleanup"].includes(context.phase)
              ? { mode: "forced", reason: GUEST_STOPPED_CLEANUP_REASON }
              : { mode: "graceful" },
          },
          workerTerminated: true,
          totalMs: performance.now() - context.startedAtMs,
          retainedTemplateBytes: context.template?.memory.byteLength ?? 0,
        });
      },
      clearExecution: assign({ request: null, worker: null, result: null }),
      release: assign(({ context }) => {
        const buffer = context.template?.memory.buffer;

        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
          buffer.transfer(0);
        }

        return { template: undefined, resources: null };
      }),
    },
  }).createMachine({
    initial: "idle",
    context: ({ input }) => ({
      resources: input(),
      request: null,
      worker: null,
      template: undefined,
      phase: "compile",
      result: null,
      startedAtMs: 0,
    }),
    states: {
      idle: {
        on: {
          "run.request": { target: "running", actions: "accept" },
          "runner.close": { target: "closed", actions: "acknowledgeClose" },
        },
      },
      running: {
        on: {
          "run.request": { actions: "rejectBusy" },
          "runner.close": { actions: "rejectClose" },
        },
        initial: "acquiring",
        states: {
          acquiring: {
            invoke: {
              id: WORKER_ACQUISITION_ACTOR_ID,
              src: "acquire",
              input: ({ context }) => requireValue(context.resources, "runner resources"),
              onDone: { target: "executing", actions: assign({ worker: ({ event }) => event.output }) },
              onError: {
                target: "#quickjsRunner.idle",
                actions: [
                  ({ context, event }) =>
                    requireValue(context.request, "request").resolve({
                      status: "error",
                      error: toExecutionError({ cause: event.error, phase: "supervision" }),
                    }),
                  "clearExecution",
                ],
              },
            },
          },
          executing: {
            invoke: {
              id: WORKER_TRANSPORT_ACTOR_ID,
              src: "observe",
              input: ({ context }) => ({
                worker: requireValue(context.worker, "worker"),
                request: requireValue(context.request, "request"),
                payload: {
                  manifest: requireValue(context.request, "request").manifest,
                  assets: requireValue(context.resources, "runner resources").assets,
                  template: context.template,
                  mode: requireValue(context.resources, "runner resources").mode ?? "snapshot",
                  debug: context.request?.debug ?? false,
                  queryPlans: context.request?.queryPlans,
                },
              }),
            },
            after: { executionDeadline: { target: "cleaning", actions: "recordTimeout" } },
            on: {
              "execution.message": {
                actions: ({ context, event }) => notifyObserver(context.request?.onMessage, event.message),
              },
              "execution.phase": {
                actions: [
                  assign({ phase: ({ event }) => event.phase }),
                  ({ context, event }) => notifyObserver(context.request?.onPhase, event.phase),
                ],
              },
              "execution.template": { actions: assign({ template: ({ event }) => event.template }) },
              "execution.result": { target: "cleaning", actions: assign({ result: ({ event }) => event.result }) },
              "execution.cancel": { target: "cleaning", actions: "recordCancellation" },
              "execution.fail": {
                target: "cleaning",
                actions: assign(({ context, event }) => ({
                  result: {
                    status: "error" as const,
                    error: toExecutionError({ cause: event.cause, phase: context.phase }),
                  },
                })),
              },
            },
          },
          cleaning: {
            invoke: {
              id: WORKER_TERMINATION_ACTOR_ID,
              src: "terminate",
              input: ({ context }) => requireValue(context.worker, "worker"),
              onDone: { target: "#quickjsRunner.idle", actions: ["publish", "clearExecution"] },
              onError: {
                target: "#quickjsRunner.cleanupFailed",
                actions: ["recordCleanupFailure", "publishCleanupFailure", assign({ request: null })],
              },
            },
          },
        },
      },
      cleanupFailed: {
        on: {
          "run.request": { actions: "rejectClosed" },
          "runner.close": { actions: "rejectFailedClose" },
        },
      },
      closed: {
        entry: "release",
        on: {
          "run.request": { actions: "rejectClosed" },
          "runner.close": { actions: "acknowledgeClose" },
        },
      },
    },
    id: "quickjsRunner",
  });

  return machine;
}

/** Create a plain runner whose machine owns admission, termination, and artifact release. */
export function createRunner(dependencies: RunnerDependencies) {
  const actor = createActor(createRunnerMachine(), { input: createResourceTransfer(dependencies) }).start();

  function run(manifest: unknown, options: RunOptions = {}): Promise<ExecutionResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new RangeError("timeoutMs must be greater than 0 and at most 120000 ms");
    }

    const parsed = QuickjsManifestSchema.safeParse(manifest);

    if (!parsed.success) {
      return Promise.resolve({ status: "error", error: { phase: "validation", message: parsed.error.message } });
    }

    const selection = actor.getSnapshot().context.resources?.assets.catalog.selection;

    if (selection && guestAssetPrefix(selection) !== guestAssetPrefix(selectGuest(parsed.data))) {
      return Promise.resolve({
        status: "error",
        error: { phase: "validation", message: "Manifest does not match this runner's pinned guest and dialect" },
      });
    }

    return new Promise((resolve) =>
      actor.send({
        type: "run.request",
        request: { ...options, manifest: parsed.data, timeoutMs, resolve },
      }),
    );
  }

  function close() {
    const response: { failure: Error | null } = { failure: null };
    actor.send({
      type: "runner.close",
      reply: (cause) => {
        response.failure = cause;
      },
    });

    if (response.failure) {
      throw response.failure;
    }
  }

  return { run, close };
}

// XState retains actor input after close; transfer resources into context without retaining a second owner.
function createResourceTransfer(dependencies: RunnerDependencies) {
  let available: RunnerDependencies | null = dependencies;

  return function takeResources() {
    const resources = requireValue(available, "initial runner resources");
    available = null;

    return resources;
  };
}
