import { createActor, waitFor } from "xstate";

import { getErrorText } from "./machine-utils.ts";
import { request, RunStoppedError } from "./request.ts";
import type { RunController, RunControllerOptions, RunOutcome, RunState } from "./run-contract.ts";
import { runMachine } from "./run.ts";

/** Create an independent run history. The injected executor remains owned by the caller. */
export function createRunController({ runtime }: RunControllerOptions = {}): RunController {
  const actor = createActor(runMachine);
  const listeners = new Set<(state: RunState) => void>();

  function readState(): RunState {
    const snapshot = actor.getSnapshot();
    const { context } = snapshot;

    return {
      status:
        snapshot.status === "error"
          ? "failed"
          : snapshot.status === "done" || snapshot.status === "stopped"
            ? "disposed"
            : context.disposeRequested
              ? "disposing"
              : snapshot.matches("running")
                ? "running"
                : snapshot.matches("settled")
                  ? "settled"
                  : "idle",
      startedAt: context.startedAt,
      submission: context.submission,
      result: context.result,
      error: snapshot.status === "error" ? getErrorText(snapshot.error) : context.error,
      durationMs: context.durationMs,
      progress: context.progress,
      states: context.states,
      events: context.events,
      history: context.runs,
      selectedHistoryEntry: context.shown,
    };
  }

  let state = readState();

  function publishState() {
    state = readState();

    for (const listener of listeners) {
      listener(state);
    }
  }

  actor.subscribe({ next: publishState, error: publishState });
  actor.start();

  function onSettled(listener: (outcome: RunOutcome) => void) {
    return actor.on("run.settled", ({ type: _type, ...outcome }) => listener(outcome));
  }

  function assertOpen() {
    const snapshot = actor.getSnapshot();

    if (snapshot.status === "error") {
      throw snapshot.error;
    }

    if (snapshot.status !== "active" || snapshot.context.disposeRequested) {
      throw new RunStoppedError();
    }
  }

  async function cancel() {
    if (!actor.getSnapshot().matches("running")) {
      return;
    }

    const settled = waitFor(actor, (snapshot) => !snapshot.matches("running"));
    actor.send({ type: "run.cancel" });
    await settled;
  }

  async function dispose() {
    if (actor.getSnapshot().status === "error") {
      listeners.clear();
      throw actor.getSnapshot().error;
    }

    if (actor.getSnapshot().status !== "active") {
      return;
    }

    const stopped = waitFor(actor, (snapshot) => snapshot.status === "done");
    actor.send({ type: "controller.dispose" });

    try {
      await stopped;
    } finally {
      listeners.clear();
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);

      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    onSettled,
    async submit(submission, options = {}) {
      assertOpen();
      const executor = options.runtime ?? runtime;

      if (executor === undefined) {
        throw new Error("Provide a runtime when creating the run controller or submitting a run.");
      }

      return request({
        requester: options.requester ?? "consumer",
        signal: options.signal,
        source: {
          onSettled,
          onRefused: (listener) => actor.on("run.refused", (event) => listener(event.requestId)),
          onStopped: (listener) => actor.subscribe({ complete: () => listener(), error: listener }),
          cancel: (requestId) => actor.send({ type: "run.cancel", requestId }),
          send: (identity) =>
            actor.send({
              type: "run.request",
              ...identity,
              input: { runtime: executor, submission, prepare: options.prepare },
            }),
        },
      });
    },
    cancel,
    selectHistoryEntry(number) {
      assertOpen();
      actor.send({ type: "run.view", run: number });
    },
    replay(input) {
      assertOpen();
      actor.send({ type: "run.replay", ...input });
    },
    dispose,
  };
}

export type {
  RunController,
  RunControllerOptions,
  RunState,
  RunSubmitOptions,
  RunOutcome,
  RunSubmission,
  RunRecord,
  RunCode,
  RunLanding,
  Subscription,
} from "./run-contract.ts";
export { RunRefusedError, RunStoppedError } from "./request.ts";
