import type { Executor, RunHandle, RunResult } from "@drizzle-run/core/contracts";
import { fakeRunResult, projectManifest, type FakeRunOptions } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import {
  runLanding,
  runMachine,
  RUN_HISTORY_LIMIT,
  RUN_WATCHDOG_MS,
  type RunCode,
  type RunSettledEvent,
} from "./run.ts";

type RuntimeRun = RunHandle;

/** A complete result of a SQLite run, as the submissions here are. */
function makeSqliteResult(outcome: RunResult["outcome"], timings: FakeRunOptions["timings"] = {}): RunResult {
  return fakeRunResult(outcome, { target: { dialect: "sqlite" }, timings });
}

function runtimeRun() {
  let resolve!: (result: RunResult) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<RunResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const callbacks = new Set<
    (snapshot: { state: string; status: "active" | "done"; sequence: number; elapsedMs: number }) => void
  >();
  const start = vi.fn();
  const cancel = vi.fn(async () => resolve(makeSqliteResult("cancelled")));
  const run: RuntimeRun = {
    start,
    result,
    cancel,
    subscribe: vi.fn((listener) => {
      callbacks.add(listener);

      return { unsubscribe: () => callbacks.delete(listener) };
    }),
    subscribeEvent: vi.fn(() => ({ unsubscribe: vi.fn() })),
  };

  return { run, start, cancel, resolve, reject, callbacks };
}

function fakeRuntime(...runs: ReturnType<typeof runtimeRun>[]) {
  const createRun = vi.fn((_manifest: unknown, _options?: unknown) => {
    const next = runs.shift();

    if (!next) throw new Error("No fake runtime run remains.");
    return next.run;
  });

  return { runtime: { createRun } satisfies Executor, createRun };
}

function runtimeWithRuns(...runs: ReturnType<typeof runtimeRun>[]): Executor {
  return fakeRuntime(...runs).runtime;
}

function makeSqliteSubmission(revision = 1) {
  return { manifest: projectManifest("sqlite"), revision, debug: false };
}

function emitState(run: ReturnType<typeof runtimeRun>, state: string) {
  for (const callback of run.callbacks) {
    callback({ state, status: "active", sequence: 1, elapsedMs: 0 });
  }
}

function succeedRun(run: ReturnType<typeof runtimeRun>, total: number) {
  run.resolve(makeSqliteResult("succeeded", { total }));
}

function makeRequest(requestId: string = crypto.randomUUID(), requester = "test") {
  return { requestId, requester };
}

/** A prepare step the test finishes or fails by hand. */
function makePrepareStep() {
  const step = Promise.withResolvers<RunCode>();

  return { prepare: vi.fn((_signal: AbortSignal) => step.promise), finish: step.resolve, fail: step.reject };
}

describe("first run and landing", () => {
  it("should start idle with no run and ignore a view or a cancel there", () => {
    const actor = createActor(runMachine).start();

    actor.send({ type: "run.view", run: 1 });
    actor.send({ type: "run.cancel" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context).toMatchObject({ runs: [], shown: undefined });
    actor.stop();
  });

  it("should settle instead of returning to idle, so idle always means not run yet", async () => {
    const run = runtimeRun();
    const actor = createActor(runMachine).start();

    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime: runtimeWithRuns(run), submission: makeSqliteSubmission() },
    });
    expect(actor.getSnapshot().value).toEqual({ running: { guest: "starting" } });
    run.resolve(makeSqliteResult("succeeded"));
    await waitFor(actor, (state) => state.matches("settled"));

    expect(actor.getSnapshot().matches("idle")).toBe(false);
    actor.stop();
  });

  it("should emit where each settled run lands", async () => {
    const succeeded = runtimeRun();
    const failed = runtimeRun();
    const cancelled = runtimeRun();
    const thrown = runtimeRun();
    const runtime = runtimeWithRuns(succeeded, failed, cancelled, thrown);
    const actor = createActor(runMachine).start();
    const landings: (string | undefined)[] = [];

    actor.on("run.settled", (event) => landings.push(event.opens));

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    succeeded.resolve(makeSqliteResult("succeeded"));
    await waitFor(actor, (state) => state.matches("settled") && state.context.runs.length === 1);

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    failed.resolve(makeSqliteResult("failed"));
    await waitFor(actor, (state) => state.matches("settled") && state.context.runs.length === 2);

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    actor.send({ type: "run.cancel" });
    await waitFor(actor, (state) => state.matches("settled") && state.context.runs.length === 3);

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    thrown.reject(new Error("worker crashed"));
    await waitFor(actor, (state) => state.matches("settled") && state.context.runs.length === 4);

    expect(landings).toEqual(["results", "problems", undefined, "problems"]);
    actor.stop();
  });

  it("should land on Problems when a succeeded run reports an error diagnostic", () => {
    const error = { severity: "error" as const, message: "Type error" };
    const warning = { severity: "warning" as const, message: "Unused" };

    expect(runLanding({ outcome: "succeeded", diagnostics: [error] })).toBe("problems");
    expect(runLanding({ outcome: "succeeded", diagnostics: [warning] })).toBe("results");
    expect(runLanding(undefined, "worker crashed")).toBe("problems");
    expect(runLanding(undefined)).toBeUndefined();
  });
});

describe("run duration and settle event", () => {
  it("should record the run duration", async () => {
    const run = runtimeRun();
    const actor = createActor(runMachine).start();

    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime: runtimeWithRuns(run), submission: makeSqliteSubmission() },
    });
    run.resolve(makeSqliteResult("succeeded", { total: 184 }));
    await waitFor(actor, (state) => state.matches("settled") && state.context.result !== undefined);

    expect(actor.getSnapshot().context.durationMs).toBe(184);
    actor.stop();
  });

  it("should fall back to wall-clock duration without timings", async () => {
    const run = runtimeRun();
    const actor = createActor(runMachine).start();

    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime: runtimeWithRuns(run), submission: makeSqliteSubmission() },
    });
    run.reject(new Error("worker crashed"));
    await waitFor(actor, (state) => state.matches("settled") && state.context.error !== "");

    expect(actor.getSnapshot().context.durationMs).toBeGreaterThanOrEqual(0);
    actor.stop();
  });

  it("should emit run.settled once per run with its outcome", async () => {
    const succeeded = runtimeRun();
    const failed = runtimeRun();
    const cancelled = runtimeRun();
    const errored = runtimeRun();
    const runtime = runtimeWithRuns(succeeded, failed, cancelled, errored);
    const actor = createActor(runMachine).start();
    const settled: string[] = [];
    const payloads: { result?: RunResult; error?: string }[] = [];

    actor.on("run.settled", (event) => {
      settled.push(event.outcome);
      payloads.push({ result: event.result, error: event.error });
    });

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    succeeded.resolve(makeSqliteResult("succeeded"));
    await waitFor(actor, (state) => state.matches("settled"));

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    failed.resolve(makeSqliteResult("failed"));
    await waitFor(actor, (state) => state.matches("settled"));

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    actor.send({ type: "run.cancel" });
    await waitFor(actor, (state) => state.matches("settled"));

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
    errored.reject(new Error("worker crashed"));
    await waitFor(actor, (state) => state.matches("settled"));

    expect(settled).toEqual(["succeeded", "failed", "cancelled", "failed"]);
    expect(payloads[0].result?.outcome).toBe("succeeded");
    expect(payloads[3]).toEqual({ result: undefined, error: "worker crashed" });
    actor.stop();
  });
});

describe("run requests", () => {
  it("should refuse a request while a run is in progress, and settle with the accepted request's id", async () => {
    const run = runtimeRun();
    const runtime = runtimeWithRuns(run);
    const actor = createActor(runMachine).start();
    const emitted: { type: string; requestId: string; requester: string }[] = [];
    actor.on("*", ({ type, requestId, requester }) => emitted.push({ type, requestId, requester }));

    actor.send({
      type: "run.request",
      ...makeRequest("first", "guide"),
      input: { runtime, submission: makeSqliteSubmission() },
    });
    actor.send({
      type: "run.request",
      ...makeRequest("second", "agent"),
      input: { runtime, submission: makeSqliteSubmission() },
    });
    succeedRun(run, 10);
    await waitFor(actor, (state) => state.matches("settled"));

    expect(emitted).toEqual([
      { type: "run.refused", requestId: "second", requester: "agent" },
      { type: "run.settled", requestId: "first", requester: "guide" },
    ]);
    actor.stop();
  });

  it("should cancel only the run of the request a cancel names", async () => {
    const run = runtimeRun();
    const actor = createActor(runMachine).start();
    actor.send({
      type: "run.request",
      ...makeRequest("current"),
      input: { runtime: runtimeWithRuns(run), submission: makeSqliteSubmission() },
    });

    actor.send({ type: "run.cancel", requestId: "earlier" });
    expect(run.cancel).not.toHaveBeenCalled();

    actor.send({ type: "run.cancel", requestId: "current" });
    await waitFor(actor, (state) => state.matches("settled"));
    expect(run.cancel).toHaveBeenCalledOnce();
    actor.stop();
  });
});

describe("execution lifecycle", () => {
  it("should capture an immutable manifest revision, start one run, and await cancellation", async () => {
    const first = runtimeRun();
    const second = runtimeRun();
    const { runtime, createRun } = fakeRuntime(first, second);
    const actor = createActor(runMachine).start();
    const project = { manifest: projectManifest("sqlite") };
    const submission = { manifest: project.manifest, revision: 3, debug: false };

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission } });
    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission } });
    project.manifest.files["query.ts"] = "newer edit";
    expect(actor.getSnapshot().context.submission?.manifest.files["query.ts"]).not.toBe("newer edit");
    expect(createRun).toHaveBeenCalledOnce();
    expect(first.start).toHaveBeenCalledOnce();

    actor.send({ type: "run.cancel" });
    await waitFor(actor, (state) => state.matches("settled") && state.context.progress === "Cancelled");
    expect(first.cancel).toHaveBeenCalledOnce();

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission } });
    second.resolve(makeSqliteResult("succeeded"));
    await waitFor(actor, (state) => state.matches("settled") && state.context.progress === "succeeded");
    actor.stop();
  });

  it("should pass the submission's query plans settings to the runtime, and none when they are off", async () => {
    const planned = runtimeRun();
    const plain = runtimeRun();
    const { runtime, createRun } = fakeRuntime(planned, plain);
    const actor = createActor(runMachine).start();
    const manifest = projectManifest("sqlite");

    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: {
        runtime,
        submission: { manifest, revision: 1, debug: false, queryPlans: { size: "1m", measureRealTime: false } },
      },
    });
    planned.resolve(makeSqliteResult("succeeded"));
    await waitFor(actor, (state) => state.matches("settled"));
    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime, submission: { manifest, revision: 2, debug: false } },
    });
    plain.resolve(makeSqliteResult("succeeded"));
    await waitFor(actor, (state) => state.matches("settled") && state.context.runs.length === 2);

    expect(createRun.mock.calls.map((call) => call[1])).toEqual([
      { queryPlans: { size: "1m", measureRealTime: false } },
      undefined,
    ]);
    actor.stop();
  });

  it("should unsubscribe and cancel owned execution when its actor stops", async () => {
    const active = runtimeRun();
    const runtime = runtimeWithRuns(active);
    const actor = createActor(runMachine).start();
    const project = { manifest: projectManifest("postgresql") };
    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime, submission: { manifest: project.manifest, revision: 0, debug: true } },
    });
    actor.stop();

    expect(active.cancel).toHaveBeenCalledOnce();
    expect(active.callbacks.size).toBe(0);
    active.reject(new Error("late run failure"));
    await Promise.resolve();
  });
});

describe("prepare step", () => {
  it("should show the run as running while it prepares, then run the code the step returns", async () => {
    const run = runtimeRun();
    const { runtime, createRun } = fakeRuntime(run);
    const step = makePrepareStep();
    const formatted = projectManifest("sqlite");
    const actor = createActor(runMachine).start();

    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime, submission: makeSqliteSubmission(1), prepare: step.prepare },
    });

    expect(actor.getSnapshot().matches({ running: "preparing" })).toBe(true);
    expect(createRun).not.toHaveBeenCalled();

    step.finish({ manifest: formatted, revision: 2 });
    await waitFor(actor, (state) => state.matches({ running: { guest: "starting" } }));

    expect(createRun).toHaveBeenCalledWith(formatted, undefined);
    expect(actor.getSnapshot().context.submission).toMatchObject({ revision: 2, debug: false });
    actor.stop();
  });

  it("should run the submission as it is when the step throws", async () => {
    const run = runtimeRun();
    const { runtime, createRun } = fakeRuntime(run);
    const step = makePrepareStep();
    const submission = makeSqliteSubmission(3);
    const actor = createActor(runMachine).start();

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission, prepare: step.prepare } });
    step.fail(new Error("Prettier failed"));
    await waitFor(actor, (state) => state.matches({ running: { guest: "starting" } }));

    expect(createRun).toHaveBeenCalledWith(submission.manifest, undefined);
    expect(actor.getSnapshot().context.submission?.revision).toBe(3);
    actor.stop();
  });

  it("should go back to idle, keeping no run, when cancelled while it prepares the first run", () => {
    const { runtime, createRun } = fakeRuntime();
    const step = makePrepareStep();
    const actor = createActor(runMachine).start();
    const settled: RunSettledEvent[] = [];

    actor.on("run.settled", (event) => settled.push(event));
    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime, submission: makeSqliteSubmission(), prepare: step.prepare },
    });
    actor.send({ type: "run.cancel" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context).toMatchObject({ runs: [], shown: undefined, submission: undefined });
    expect(step.prepare.mock.calls[0]?.[0].aborted).toBe(true);
    expect(settled).toEqual([expect.objectContaining({ type: "run.settled", outcome: "cancelled" })]);
    expect(createRun).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should show the run shown before again, keeping no run, when cancelled while it prepares", async () => {
    const first = runtimeRun();
    const { runtime, createRun } = fakeRuntime(first);
    const step = makePrepareStep();
    const actor = createActor(runMachine).start();

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(1) } });
    succeedRun(first, 12);
    await waitFor(actor, (state) => state.matches("settled"));
    actor.send({
      type: "run.request",
      ...makeRequest(),
      input: { runtime, submission: makeSqliteSubmission(2), prepare: step.prepare },
    });
    actor.send({ type: "run.cancel" });

    expect(actor.getSnapshot().matches("settled")).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      shown: 1,
      durationMs: 12,
      error: "",
      result: { outcome: "succeeded" },
      submission: { revision: 1 },
    });
    expect(actor.getSnapshot().context.runs).toHaveLength(1);
    expect(step.prepare.mock.calls[0]?.[0].aborted).toBe(true);
    expect(createRun).toHaveBeenCalledTimes(1);
    actor.stop();
  });
});

describe("run watchdog", () => {
  it("should leave a run cancelled while it starts to settle once, with no watchdog behind it", async () => {
    vi.useFakeTimers();

    try {
      const starting = runtimeRun();
      const actor = createActor(runMachine).start();
      const settled: RunSettledEvent[] = [];
      actor.on("run.settled", (event) => settled.push(event));

      actor.send({
        type: "run.request",
        ...makeRequest(),
        input: { runtime: runtimeWithRuns(starting), submission: makeSqliteSubmission() },
      });
      actor.send({ type: "run.cancel" });
      await vi.advanceTimersByTimeAsync(0);
      expect(actor.getSnapshot().matches("settled")).toBe(true);

      await vi.advanceTimersByTimeAsync(RUN_WATCHDOG_MS * 2);
      expect(starting.cancel).toHaveBeenCalledOnce();
      expect(settled).toEqual([expect.objectContaining({ type: "run.settled", outcome: "cancelled" })]);
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should cancel a run still going after the watchdog delay and settle it as failed", async () => {
    vi.useFakeTimers();

    try {
      const hung = runtimeRun();
      const next = runtimeRun();
      hung.cancel.mockImplementation(() => new Promise<void>(() => undefined));
      const runtime = runtimeWithRuns(hung, next);
      const actor = createActor(runMachine).start();
      const settled: RunSettledEvent[] = [];
      actor.on("run.settled", (event) => settled.push(event));

      actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission() } });
      await vi.advanceTimersByTimeAsync(RUN_WATCHDOG_MS * 2);
      expect(actor.getSnapshot().matches({ running: { guest: "starting" } })).toBe(true);

      emitState(hung, "running");
      expect(actor.getSnapshot().matches({ running: { guest: "executing" } })).toBe(true);
      expect(actor.getSnapshot().context.progress).toBe("running");
      await vi.advanceTimersByTimeAsync(RUN_WATCHDOG_MS - 1);
      expect(actor.getSnapshot().matches("running")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(actor.getSnapshot().matches("settled")).toBe(true);
      expect(hung.cancel).toHaveBeenCalledOnce();
      expect(settled).toEqual([
        {
          type: "run.settled",
          requestId: expect.any(String),
          requester: "test",
          outcome: "failed",
          opens: "problems",
          error: `The run did not finish within ${RUN_WATCHDOG_MS / 1_000} seconds, so it was stopped.`,
        },
      ]);

      actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(2) } });
      succeedRun(next, 5);
      await vi.advanceTimersByTimeAsync(0);
      expect(actor.getSnapshot().context.progress).toBe("succeeded");
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("run history", () => {
  it("should keep each settled run and show an older one on run.view", async () => {
    const first = runtimeRun();
    const second = runtimeRun();
    const third = runtimeRun();
    const runtime = runtimeWithRuns(first, second, third);
    const actor = createActor(runMachine).start();

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(1) } });
    succeedRun(first, 10);
    await waitFor(actor, (state) => state.matches("settled"));
    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(2) } });
    second.reject(new Error("worker crashed"));
    await waitFor(actor, (state) => state.matches("settled"));
    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(3) } });
    actor.send({ type: "run.cancel" });
    await waitFor(actor, (state) => state.matches("settled"));

    expect(actor.getSnapshot().context.runs.map((run) => [run.number, run.result?.outcome, run.error])).toEqual([
      [1, "succeeded", ""],
      [2, undefined, "worker crashed"],
      [3, "cancelled", ""],
    ]);
    expect(actor.getSnapshot().context.shown).toBe(3);

    actor.send({ type: "run.view", run: 1 });
    expect(actor.getSnapshot().context).toMatchObject({
      shown: 1,
      error: "",
      durationMs: 10,
      submission: { revision: 1 },
    });
    expect(actor.getSnapshot().context.result?.outcome).toBe("succeeded");

    actor.send({ type: "run.view", run: 2 });
    expect(actor.getSnapshot().context).toMatchObject({
      shown: 2,
      result: undefined,
      error: "worker crashed",
      progress: "Run failed",
    });
    actor.stop();
  });

  it("should ignore run.view while running and for an unknown run", async () => {
    const first = runtimeRun();
    const second = runtimeRun();
    const actor = createActor(runMachine).start();
    const runtime = runtimeWithRuns(first, second);

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(1) } });
    succeedRun(first, 10);
    await waitFor(actor, (state) => state.matches("settled"));
    actor.send({ type: "run.view", run: 9 });
    expect(actor.getSnapshot().context.shown).toBe(1);

    actor.send({ type: "run.request", ...makeRequest(), input: { runtime, submission: makeSqliteSubmission(2) } });
    actor.send({ type: "run.view", run: 1 });
    expect(actor.getSnapshot().matches("running")).toBe(true);
    expect(actor.getSnapshot().context.result).toBeUndefined();
    succeedRun(second, 20);
    await waitFor(actor, (state) => state.matches("settled"));
    expect(actor.getSnapshot().context).toMatchObject({ shown: 2, durationMs: 20 });
    actor.stop();
  });

  it("should drop the oldest runs past the limit and keep counting", async () => {
    const runs = Array.from({ length: RUN_HISTORY_LIMIT + 2 }, () => runtimeRun());
    const runtime = runtimeWithRuns(...runs);
    const actor = createActor(runMachine).start();

    for (const [index, run] of runs.entries()) {
      actor.send({
        type: "run.request",
        ...makeRequest(),
        input: { runtime, submission: makeSqliteSubmission(index) },
      });
      succeedRun(run, index);
      await waitFor(actor, (state) => state.matches("settled"));
    }

    const numbers = actor.getSnapshot().context.runs.map((run) => run.number);
    expect(numbers).toHaveLength(RUN_HISTORY_LIMIT);
    expect(numbers[0]).toBe(3);
    expect(numbers.at(-1)).toBe(RUN_HISTORY_LIMIT + 2);
    actor.stop();
  });
});

describe("replay", () => {
  const submission = { manifest: projectManifest(), revision: 1, debug: false };

  it("should show a recorded run as settled without a runtime or a settle event", () => {
    const actor = createActor(runMachine).start();
    const settled = vi.fn();
    actor.on("run.settled", settled);
    const result = fakeRunResult("succeeded", { timings: { total: 184 } });

    actor.send({ type: "run.replay", submission, result });

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches("settled")).toBe(true);
    expect(snapshot.context).toMatchObject({ result, durationMs: 184, progress: "succeeded", shown: 1 });
    expect(snapshot.context.runs).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();
  });

  it("should ignore a replay while a run is in flight", () => {
    const pending = runtimeRun();
    const actor = createActor(runMachine).start();
    actor.send({ type: "run.request", ...makeRequest(), input: { runtime: runtimeWithRuns(pending), submission } });

    actor.send({ type: "run.replay", submission, result: fakeRunResult("succeeded") });

    expect(actor.getSnapshot().matches("running")).toBe(true);
  });
});
