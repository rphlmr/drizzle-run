import { SERIALIZED_UNDEFINED } from "@drizzle-run/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { createRunMachine, getRunStateName, type RunMachinePorts } from "./run-machine.ts";
import type { ExecutionOutcome } from "./run.ts";

const gracefulCleanup: ExecutionOutcome["cleanup"] = { guest: { mode: "graceful" }, database: { mode: "graceful" } };

function makeSucceededOutcome({ database }: { database?: unknown } = {}): ExecutionOutcome {
  return {
    report: {
      kind: "report",
      outcome: "succeeded",
      value: SERIALIZED_UNDEFINED,
      ...(database === undefined ? {} : { database }),
    },
    cleanup: gracefulCleanup,
  };
}

/** A run machine whose execution settles when the test says so */
function startRunMachine() {
  const execution = Promise.withResolvers<ExecutionOutcome>();
  let executionSignal: AbortSignal | undefined;
  const ports = {
    dialect: "postgresql",
    execute: vi.fn((signal: AbortSignal) => {
      executionSignal = signal;

      return execution.promise;
    }),
    recordPhase: vi.fn(),
    finishCancelledBeforeStart: vi.fn(),
    finishCancelled: vi.fn(),
    finishFailed: vi.fn(),
    finishWithInvalidReport: vi.fn(),
    finishSucceeded: vi.fn(),
  } satisfies RunMachinePorts;
  const actor = createActor(createRunMachine(ports));
  actor.start();

  return { actor, ports, execution, getSignal: () => executionSignal };
}

describe("run machine", () => {
  it("should end a run cancelled while idle without executing it", () => {
    const { actor, ports } = startRunMachine();

    actor.send({ type: "run.cancel" });

    expect(getRunStateName(actor.getSnapshot())).toBe("cancelled");
    expect(ports.finishCancelledBeforeStart).toHaveBeenCalledOnce();
    expect(ports.execute).not.toHaveBeenCalled();
  });

  it("should start once, become running when ready, and succeed on a succeeded report", async () => {
    const { actor, ports, execution } = startRunMachine();

    actor.send({ type: "run.start", startedAt: 10 });
    actor.send({ type: "run.start", startedAt: 20 });
    expect(getRunStateName(actor.getSnapshot())).toBe("starting");
    actor.send({ type: "execution.ready", initializationDurationMs: 5 });
    actor.send({ type: "execution.phase", phase: "compile", status: "running" });

    expect(getRunStateName(actor.getSnapshot())).toBe("running");
    expect(actor.getSnapshot().context).toMatchObject({ phase: "compile", startedAt: 10 });
    expect(ports.recordPhase.mock.calls).toEqual([
      ["load_artifacts", "running"],
      ["load_artifacts", "succeeded", 5],
      ["compile", "running", undefined],
    ]);

    execution.resolve(makeSucceededOutcome());
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(getRunStateName(actor.getSnapshot())).toBe("succeeded");
    expect(ports.execute).toHaveBeenCalledOnce();
    expect(ports.finishSucceeded).toHaveBeenCalledWith(makeSucceededOutcome(), { status: "absent" });
  });

  it("should fail on an execution failure, with the phase the run was in", async () => {
    const { actor, ports, execution } = startRunMachine();
    const failure = new Error("guest stopped");

    actor.send({ type: "run.start", startedAt: 0 });
    actor.send({ type: "execution.phase", phase: "run", status: "running" });
    execution.resolve({ failure, cleanup: gracefulCleanup });
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(getRunStateName(actor.getSnapshot())).toBe("failed");
    expect(ports.finishFailed).toHaveBeenCalledWith({ failure, cleanup: gracefulCleanup }, failure, "run");
  });

  it("should fail a succeeded report whose database cannot be read", async () => {
    const { actor, ports, execution } = startRunMachine();

    actor.send({ type: "run.start", startedAt: 0 });
    execution.resolve(makeSucceededOutcome({ database: { type: "primitive", value: 1 } }));
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(getRunStateName(actor.getSnapshot())).toBe("failed");
    expect(ports.finishWithInvalidReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "invalid_report", phase: "inspect" }),
    );
    expect(ports.finishSucceeded).not.toHaveBeenCalled();
  });

  it("should abort a cancelled run and end it cancelled even when its execution then succeeds", async () => {
    const { actor, ports, execution, getSignal } = startRunMachine();

    actor.send({ type: "run.start", startedAt: 0 });
    actor.send({ type: "execution.ready" });
    actor.send({ type: "run.cancel" });

    expect(getRunStateName(actor.getSnapshot())).toBe("cancelling");
    expect(getSignal()?.aborted).toBe(true);
    execution.resolve(makeSucceededOutcome());
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(getRunStateName(actor.getSnapshot())).toBe("cancelled");
    expect(ports.finishCancelled).toHaveBeenCalledWith(makeSucceededOutcome(), "load_artifacts");
    expect(ports.finishSucceeded).not.toHaveBeenCalled();
  });

  it("should fail with a graceful cleanup when the execution throws", async () => {
    const { actor, ports, execution } = startRunMachine();
    const cause = new Error("no worker");

    actor.send({ type: "run.start", startedAt: 0 });
    execution.reject(cause);
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(ports.finishFailed).toHaveBeenCalledWith(
      { failure: cause, cleanup: gracefulCleanup },
      cause,
      "load_artifacts",
    );
  });
});
