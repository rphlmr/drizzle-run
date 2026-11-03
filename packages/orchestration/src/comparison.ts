import { createActor, waitFor } from "xstate";

import type { ComparisonController, ComparisonOutcome, ComparisonState } from "./comparison-contract.ts";
import { getErrorText } from "./machine-utils.ts";
import { createPairRunMachine, type PairRunServices } from "./pair-run.ts";
import { request, RunStoppedError } from "./request.ts";

/** Coordinate two runs, preserving the host's parallel or sequential policy. */
export function createComparisonController(options: PairRunServices): ComparisonController {
  const actor = createActor(createPairRunMachine(options));
  const listeners = new Set<(state: ComparisonState) => void>();

  function readState(): ComparisonState {
    const snapshot = actor.getSnapshot();

    return {
      status:
        snapshot.status === "error"
          ? "failed"
          : snapshot.status === "done" || snapshot.status === "stopped"
            ? "disposed"
            : snapshot.context.disposeRequested
              ? "disposing"
              : snapshot.matches("running")
                ? "running"
                : snapshot.matches("settled")
                  ? "settled"
                  : "idle",
      runs: snapshot.context.runs,
      error: snapshot.status === "error" ? getErrorText(snapshot.error) : "",
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

  function onSettled(listener: (outcome: ComparisonOutcome) => void) {
    return actor.on("run.settled", ({ type: _type, ...outcome }) => listener(outcome));
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
    async submit({ requester = "consumer", signal, manifest, prepare } = {}) {
      const snapshot = actor.getSnapshot();

      if (snapshot.status === "error") {
        throw snapshot.error;
      }

      if (snapshot.status !== "active" || snapshot.context.disposeRequested) {
        throw new RunStoppedError();
      }

      return request({
        requester,
        signal,
        source: {
          onSettled,
          onRefused: (listener) =>
            actor.on("run.refused", (event) =>
              listener(event.requestId, event.reason === "seed_problem" ? event.problem : undefined),
            ),
          onStopped: (listener) => actor.subscribe({ complete: () => listener(), error: listener }),
          cancel: (requestId) => actor.send({ type: "run.cancel", requestId }),
          send: (identity) => actor.send({ type: "run.request", ...identity, manifest, prepare }),
        },
      });
    },
    cancel,
    dispose,
  };
}
