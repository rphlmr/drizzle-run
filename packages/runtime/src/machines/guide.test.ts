import type { ComparisonResult, RunResult } from "@drizzle-run/core/contracts";
import {
  diffRunResults,
  isPairProject,
  parseGuideManifest,
  projectFiles,
  type GuideProject,
} from "@drizzle-run/core/guide";
import { pairSide } from "@drizzle-run/core/pair";
import { fakeRunResult, projectManifest } from "@drizzle-run/test-fixtures";
import { pairManifest } from "@drizzle-run/test-fixtures/pair";
import { delay } from "es-toolkit";
import { assert, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import {
  createGuideMachine,
  guideProgressSaverMachine,
  guideRunOutcome,
  guideView,
  listGuideCheckedRuns,
  readGuideProgress,
  runWithRuntime,
  type GuideEmitted,
  type GuideProgress,
  type GuideRunResult,
  type GuideServices,
} from "./guide.ts";

const guideSource = {
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "first-run",
  title: "Your first run",
  project: projectManifest(),
  steps: [
    { type: "walkthrough", id: "01-read", label: "Read", title: "Read the files", body: "Look around.", run: "none" },
    {
      type: "walkthrough",
      id: "02-display",
      label: "Display",
      title: "Show rows",
      body: "Press **Run**.",
      edits: [{ file: "query.ts", replace: { anchor: "// next", with: '$.display("Rows", [1]);' } }],
      run: "required",
    },
    {
      type: "walkthrough",
      id: "03-helper",
      label: "Helper",
      title: "A helper",
      body: "Optional run.",
      edits: [{ file: "helper.ts", write: "export const one = 1;\n" }],
      run: "optional",
    },
  ],
};

const manifest = parseGuideManifest(guideSource);

const rows = (...values: number[]): RunResult["displays"] => [
  { label: "Rows", values: [{ type: "array", value: values.map((value) => ({ type: "primitive", value })) }] },
];

/** A run service whose runs the test settles by hand. */
function controlledRuns() {
  const pending: {
    manifest: GuideProject;
    signal: AbortSignal;
    resolve(result: GuideRunResult): void;
    reject(error: Error): void;
  }[] = [];
  const run: GuideServices["run"] = (runManifest, signal) =>
    new Promise((resolve, reject) => pending.push({ manifest: runManifest, signal, resolve, reject }));

  return { run, pending };
}

function start(services: Partial<GuideServices> = {}, startAt?: number) {
  const runs = controlledRuns();
  const emitted: GuideEmitted[] = [];
  const actor = createActor(createGuideMachine({ run: runs.run, ...services }), { input: { manifest, startAt } });

  for (const type of ["step.changed", "run.settled", "run.failed", "guide.left", "guide.finished"] as const) {
    actor.on(type, (event) => emitted.push(event));
  }

  actor.start();
  return { actor, runs, emitted, view: () => guideView(actor.getSnapshot()) };
}

function settled(actor: ReturnType<typeof start>["actor"]) {
  return waitFor(actor, (snapshot) => !snapshot.matches("loading"));
}

describe("guide machine", () => {
  it("should open on the first step with its files and a locked editor", async () => {
    const { actor, emitted, view } = start();

    await settled(actor);

    expect(view()).toMatchObject({
      stage: "before",
      index: 0,
      count: 3,
      editorLocked: true,
      canRun: false,
      canNext: true,
      canBack: false,
    });
    expect(projectFiles(view().project)).toEqual(manifest.project.files);
    expect(emitted).toEqual([{ type: "step.changed", index: 0, step: manifest.steps[0], project: manifest.project }]);
    actor.stop();
  });

  it("should ignore Run on a step without a run and Back on the first step", async () => {
    const { actor, runs, view } = start();

    await settled(actor);
    actor.send({ type: "run.start" });
    actor.send({ type: "step.back" });

    expect(view()).toMatchObject({ stage: "before", index: 0 });
    expect(runs.pending).toHaveLength(0);
    actor.stop();
  });

  it("should apply the next step's edits and keep Next closed until a required run succeeds", async () => {
    const { actor, runs, emitted, view } = start();

    await settled(actor);
    actor.send({ type: "step.next" });

    expect(view()).toMatchObject({ stage: "before", index: 1, canNext: false, canRun: true, canBack: true });
    expect(projectFiles(view().project)["query.ts"]).toContain('$.display("Rows", [1]);');
    expect(emitted.at(-1)).toMatchObject({ type: "step.changed", index: 1 });

    actor.send({ type: "step.next" });
    expect(view().index).toBe(1);

    actor.send({ type: "run.start" });
    expect(view().stage).toBe("running");
    expect(projectFiles(runs.pending[0].manifest)["query.ts"]).toContain("$.display");

    actor.send({ type: "step.next" });
    actor.send({ type: "run.start" });
    expect(runs.pending).toHaveLength(1);

    runs.pending[0].resolve(fakeRunResult("succeeded", { displays: rows(1) }));
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    expect(view()).toMatchObject({ stage: "after", canNext: true, completed: ["01-read", "02-display"] });
    expect(view().changes?.displays).toEqual([expect.objectContaining({ label: "Rows", status: "added" })]);
    expect(emitted.at(-1)).toMatchObject({ type: "run.settled", changes: { changed: true } });

    actor.send({ type: "step.next" });
    expect(view()).toMatchObject({ stage: "before", index: 2 });
    expect(Object.keys(projectFiles(view().project)).toSorted()).toEqual(["helper.ts", "query.ts", "schema.ts"]);
    actor.stop();
  });

  it("should show a failed run as a result, keep a required step closed, and run again", async () => {
    const { actor, runs, emitted, view } = start({}, 1);

    await settled(actor);
    actor.send({ type: "run.start" });
    runs.pending[0].resolve(fakeRunResult("failed", { message: "boom" }));
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    expect(view()).toMatchObject({ stage: "after", error: "boom", canNext: false, canRun: true });
    expect(emitted.at(-1)).toMatchObject({ type: "run.settled" });

    actor.send({ type: "step.next" });
    expect(view().index).toBe(1);

    actor.send({ type: "run.start" });
    runs.pending[1].resolve(fakeRunResult("succeeded", { displays: rows(1, 2) }));
    await waitFor(
      actor,
      (snapshot) => snapshot.context.result !== undefined && guideRunOutcome(snapshot.context.result) === "succeeded",
    );

    expect(view()).toMatchObject({ error: "", canNext: true });
    expect(view().changes?.displays[0]).toMatchObject({ label: "Rows", status: "added" });
    actor.stop();
  });

  it("should compare each run with the one before for what changed", async () => {
    const { actor, runs, view } = start({}, 1);

    await settled(actor);
    actor.send({ type: "run.start" });
    runs.pending[0].resolve(fakeRunResult("succeeded", { displays: rows(1) }));
    await waitFor(actor, (snapshot) => snapshot.context.result !== undefined);
    actor.send({ type: "run.start" });
    runs.pending[1].resolve(fakeRunResult("succeeded", { displays: rows(1, 2) }));
    await waitFor(actor, (snapshot) => snapshot.context.changes?.displays[0].status === "changed");

    expect(view().changes?.displays[0]).toMatchObject({ status: "changed", unchanged: 1 });
    actor.stop();
  });

  it("should go to failed when the run service throws, and run again", async () => {
    const { actor, runs, emitted, view } = start({}, 1);

    await settled(actor);
    actor.send({ type: "run.start" });
    runs.pending[0].reject(new Error("worker crashed"));
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "failed" } }));

    expect(view()).toMatchObject({ stage: "failed", error: "worker crashed", canNext: false });
    expect(emitted.at(-1)).toEqual({ type: "run.failed", error: "worker crashed" });

    actor.send({ type: "run.start" });
    expect(view().stage).toBe("running");
    actor.stop();
  });

  it("should cancel a run: Cancel aborts the service, and a cancelled outcome returns to before", async () => {
    const { actor, runs, view } = start({}, 1);

    await settled(actor);
    actor.send({ type: "run.start" });
    actor.send({ type: "run.cancel" });

    expect(runs.pending[0].signal.aborted).toBe(true);
    expect(view().stage).toBe("before");

    actor.send({ type: "run.start" });
    runs.pending[1].resolve(fakeRunResult("cancelled"));
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "before" } }));

    expect(view().result).toBeUndefined();
    actor.send({ type: "run.cancel" });
    expect(view().stage).toBe("before");
    actor.stop();
  });

  it("should go back a step and restore that step's files", async () => {
    const { actor, view } = start({}, 2);

    await settled(actor);
    actor.send({ type: "step.back" });

    expect(view()).toMatchObject({ index: 1, stage: "before" });
    expect(projectFiles(view().project)["helper.ts"]).toBeUndefined();
    actor.stop();
  });

  it("should go to an earlier step and ignore the current or a later one", async () => {
    const { actor, view } = start({}, 2);

    await settled(actor);
    actor.send({ type: "step.select", index: 2 });
    actor.send({ type: "step.select", index: 5 });

    expect(view()).toMatchObject({ index: 2 });
    actor.send({ type: "step.select", index: 0 });

    expect(view()).toMatchObject({ index: 0, stage: "before" });
    expect(projectFiles(view().project)).toEqual(manifest.project.files);
    actor.stop();
  });

  it("should cancel the running step when the learner goes to an earlier step, and drop its late result", async () => {
    const { actor, runs, emitted, view } = start({}, 2);

    await settled(actor);
    actor.send({ type: "run.start" });
    expect(view().stage).toBe("running");
    actor.send({ type: "step.select", index: 1 });

    expect(runs.pending[0].signal.aborted).toBe(true);
    expect(view()).toMatchObject({ index: 1, stage: "before", result: undefined });

    runs.pending[0].resolve(fakeRunResult("succeeded", { displays: rows(1) }));
    await Promise.resolve();

    expect(view()).toMatchObject({ index: 1, stage: "before", result: undefined });
    expect(actor.getSnapshot().context.completed).not.toContain("03-helper");
    expect(emitted.some((event) => event.type === "run.settled")).toBe(false);

    actor.send({ type: "run.start" });
    runs.pending[1].resolve(fakeRunResult("succeeded", { displays: rows(1) }));
    await waitFor(actor, (snapshot) => snapshot.context.completed.includes("02-display"));

    expect(view()).toMatchObject({ index: 1, stage: "after" });
    actor.stop();
  });

  it("should name the run it compares with: the last run, whichever step it ran at", async () => {
    const { actor, runs, emitted, view } = start({}, 1);

    await settled(actor);
    actor.send({ type: "run.start" });
    runs.pending[0].resolve(fakeRunResult("succeeded", { displays: rows(1) }));
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    expect(view().since).toBeUndefined();
    actor.send({ type: "step.next" });
    actor.send({ type: "run.start" });
    runs.pending[1].resolve(fakeRunResult("succeeded", { displays: rows(1, 2) }));
    await waitFor(actor, (snapshot) => snapshot.context.completed.includes("03-helper"));

    expect(view().since).toEqual({ step: 1 });

    actor.send({ type: "step.select", index: 1 });
    expect(view().since).toBeUndefined();
    actor.send({ type: "run.start" });
    runs.pending[2].resolve(fakeRunResult("succeeded", { displays: rows(1) }));
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    expect(view()).toMatchObject({ index: 1, since: { step: 2 } });
    expect(emitted.findLast((event) => event.type === "run.settled")).toMatchObject({ since: { step: 2 } });
    actor.stop();
  });

  it("should go to any step from the finished guide", async () => {
    const { actor, view } = start({}, 2);

    await settled(actor);
    actor.send({ type: "step.next" });
    expect(view().stage).toBe("done");
    actor.send({ type: "step.select", index: 1 });

    expect(view()).toMatchObject({ index: 1, stage: "before", editorLocked: true });
    actor.stop();
  });

  it("should unlock the editor when the learner leaves, and resume on the same step", async () => {
    const { actor, emitted, view } = start({}, 1);

    await settled(actor);
    actor.send({ type: "guide.leave" });

    expect(view()).toMatchObject({ stage: "left", editorLocked: false, canRun: false, canNext: false, canBack: false });
    expect(emitted.at(-1)).toEqual({ type: "guide.left" });

    actor.send({ type: "guide.resume" });
    expect(view()).toMatchObject({ stage: "before", index: 1, editorLocked: true });
    actor.stop();
  });

  it("should finish after the last step, save it, and restart or go back", async () => {
    const saveProgress = vi.fn(async (_progress: GuideProgress) => undefined);
    const { actor, emitted, view } = start({ saveProgress }, 2);

    await settled(actor);
    actor.send({ type: "step.next" });

    expect(view()).toMatchObject({ stage: "done", editorLocked: false });
    expect(emitted.at(-1)).toEqual({ type: "guide.finished" });
    await vi.waitFor(() =>
      expect(saveProgress).toHaveBeenLastCalledWith(
        {
          guideId: "first-run",
          stepId: "03-helper",
          completed: ["03-helper"],
          finished: true,
        },
        expect.any(AbortSignal),
      ),
    );

    actor.send({ type: "run.start" });
    actor.send({ type: "step.next" });
    expect(view().stage).toBe("done");

    actor.send({ type: "step.back" });
    expect(view()).toMatchObject({ stage: "before", index: 2 });

    actor.send({ type: "step.next" });
    actor.send({ type: "guide.restart" });
    expect(view()).toMatchObject({ stage: "before", index: 0, completed: [] });
    actor.stop();
  });

  it("should resume saved progress, let a requested step win, and ignore bad progress", async () => {
    const saved: GuideProgress = {
      guideId: "first-run",
      stepId: "03-helper",
      completed: ["01-read", "02-display"],
      finished: false,
    };
    const resumed = start({ loadProgress: async () => saved });
    await settled(resumed.actor);
    expect(resumed.view()).toMatchObject({ index: 2, completed: ["01-read", "02-display"] });
    resumed.actor.stop();

    const requested = start({ loadProgress: async () => saved }, 1);
    await settled(requested.actor);
    expect(requested.view()).toMatchObject({ index: 1, canNext: true });
    requested.actor.stop();

    const finished = start({ loadProgress: async () => ({ ...saved, finished: true }) });
    await settled(finished.actor);
    expect(finished.view()).toMatchObject({ stage: "done", index: 2 });
    finished.actor.stop();

    const malformed = start({
      loadProgress: async () => ({ guideId: "other", stepId: "03-helper", completed: [], finished: false }),
    });
    await settled(malformed.actor);
    expect(malformed.view().index).toBe(0);
    malformed.actor.stop();

    const failing = start({ loadProgress: async () => Promise.reject(new Error("storage")) }, 99);
    await settled(failing.actor);
    expect(failing.view().index).toBe(0);
    failing.actor.stop();
  });

  it("should keep going when saving progress fails", async () => {
    const { actor, view } = start({ saveProgress: async () => Promise.reject(new Error("quota")) });

    await settled(actor);
    actor.send({ type: "step.next" });
    await delay(0);

    expect(view()).toMatchObject({ index: 1, stage: "before" });
    expect(actor.getSnapshot().status).toBe("active");
    actor.stop();
  });

  it("should save progress when a run completes the step, before the learner moves on", async () => {
    const saveProgress = vi.fn(async (_progress: GuideProgress) => undefined);
    const { actor, runs } = start({ saveProgress }, 1);

    await settled(actor);
    actor.send({ type: "run.start" });
    runs.pending[0]?.resolve(fakeRunResult("succeeded", { displays: rows(1) }));

    await vi.waitFor(() =>
      expect(saveProgress).toHaveBeenLastCalledWith(
        {
          guideId: "first-run",
          stepId: "02-display",
          completed: ["02-display"],
          finished: false,
        },
        expect.any(AbortSignal),
      ),
    );
    actor.stop();
  });

  it("should save progress in order, even when an earlier save is slower", async () => {
    const saved: string[] = [];
    const firstSave = Promise.withResolvers<void>();
    const saveProgress = vi.fn(async (progress: GuideProgress) => {
      if (saved.length === 0 && saveProgress.mock.calls.length === 1) {
        await firstSave.promise;
      }

      saved.push(progress.stepId);
    });
    const { actor } = start({ saveProgress });

    await settled(actor);
    actor.send({ type: "step.next" });
    await delay(0);
    firstSave.resolve();

    await vi.waitFor(() => expect(saved).toEqual(["01-read", "02-display"]));
    actor.stop();
  });

  it("should abort a save a newer one replaces, but never the last one, even when the guide stops", async () => {
    const signals: AbortSignal[] = [];
    const saveProgress = vi.fn(async (_progress: GuideProgress, signal: AbortSignal) => {
      signals.push(signal);

      if (signals.length === 1) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
    });
    const { actor } = start({ saveProgress });

    await settled(actor);
    actor.send({ type: "step.next" });
    actor.stop();

    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(saveProgress).toHaveBeenLastCalledWith(expect.objectContaining({ stepId: "02-display" }), signals[1]);
  });

  it("should open without progress that never loads, and save nothing over it", async () => {
    vi.useFakeTimers();

    try {
      const saveProgress = vi.fn(async (_progress: GuideProgress) => undefined);
      const { actor, view } = start({ loadProgress: () => new Promise(() => {}), saveProgress });

      await vi.advanceTimersByTimeAsync(5_000);
      actor.send({ type: "step.next" });
      await vi.advanceTimersByTimeAsync(0);

      expect(view()).toMatchObject({ stage: "before", index: 1, progress: "unavailable" });
      expect(saveProgress).not.toHaveBeenCalled();
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should ignore progress that loads after the guide opened without it", async () => {
    vi.useFakeTimers();

    try {
      const load = Promise.withResolvers<unknown>();
      const saveProgress = vi.fn(async (_progress: GuideProgress) => undefined);
      let loadSignal: AbortSignal | undefined;
      const { actor, view } = start({
        loadProgress: (_guideId, signal) => {
          loadSignal = signal;
          return load.promise;
        },
        saveProgress,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(loadSignal?.aborted).toBe(true);
      load.resolve({ guideId: "first-run", stepId: "03-helper", completed: ["01-read"], finished: false });
      await vi.advanceTimersByTimeAsync(0);

      expect(view()).toMatchObject({ stage: "before", index: 0, completed: [], progress: "unavailable" });
      expect(saveProgress).not.toHaveBeenCalled();
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should never save after progress failed to load", async () => {
    const saveProgress = vi.fn(async (_progress: GuideProgress) => undefined);
    const { actor, view } = start({ loadProgress: async () => Promise.reject(new Error("storage")), saveProgress });

    await settled(actor);
    actor.send({ type: "step.next" });
    await delay(0);

    expect(view()).toMatchObject({ index: 1, progress: "unavailable" });
    expect(saveProgress).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should wait for progress as long as the host asks", async () => {
    vi.useFakeTimers();

    try {
      const actor = createActor(
        createGuideMachine(
          { run: controlledRuns().run, loadProgress: () => new Promise(() => {}) },
          { progressLoadTimeoutMs: 20_000 },
        ),
        { input: { manifest } },
      ).start();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(guideView(actor.getSnapshot()).stage).toBe("loading");

      await vi.advanceTimersByTimeAsync(15_000);
      expect(guideView(actor.getSnapshot()).stage).toBe("before");
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should save a run only when it completes the step", async () => {
    const saveProgress = vi.fn(async (_progress: GuideProgress) => undefined);
    const { actor, runs } = start({ saveProgress }, 1);

    await settled(actor);
    await vi.waitFor(() => expect(saveProgress).toHaveBeenCalledTimes(1));
    actor.send({ type: "run.start" });
    runs.pending[0]?.resolve(fakeRunResult("failed"));
    await delay(0);

    expect(saveProgress).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should read only progress that matches the guide", () => {
    expect(
      readGuideProgress(
        { guideId: "first-run", stepId: "02-display", completed: ["01-read", "gone"], finished: false },
        manifest,
      ),
    ).toEqual({ guideId: "first-run", stepId: "02-display", completed: ["01-read"], finished: false });
    expect(
      readGuideProgress({ guideId: "first-run", stepId: "99-missing", completed: [], finished: false }, manifest),
    ).toBeUndefined();
    expect(readGuideProgress("nope", manifest)).toBeUndefined();
  });
});

function makeProgress(stepId: string): GuideProgress {
  return { guideId: "first-run", stepId, completed: [], finished: false };
}

function startSaver() {
  const saves: { progress: GuideProgress; signal: AbortSignal; settle: PromiseWithResolvers<void> }[] = [];
  const saver = createActor(
    guideProgressSaverMachine.provide({
      actors: {
        saveProgress: fromPromise<void, { progress: GuideProgress; signal: AbortSignal }>(({ input }) => {
          const settle = Promise.withResolvers<void>();
          saves.push({ ...input, settle });

          return settle.promise;
        }),
      },
    }),
  ).start();

  return { saver, saves };
}

describe("guide progress saver", () => {
  it("should start a save at once when none runs, and go idle once it settles", async () => {
    const { saver, saves } = startSaver();

    saver.send({ type: "progress.save", progress: makeProgress("01-read") });

    expect(saver.getSnapshot().matches("saving")).toBe(true);
    expect(saves.map((save) => save.progress.stepId)).toEqual(["01-read"]);

    saves[0]?.settle.resolve();
    await waitFor(saver, (snapshot) => snapshot.matches("idle"));
    saver.stop();
  });

  it("should abort the running save for a newer one, and start the newer one only after it settles", async () => {
    const { saver, saves } = startSaver();

    saver.send({ type: "progress.save", progress: makeProgress("01-read") });
    saver.send({ type: "progress.save", progress: makeProgress("02-display") });

    expect(saves[0]?.signal.aborted).toBe(true);
    expect(saves).toHaveLength(1);

    saves[0]?.settle.resolve();
    await vi.waitFor(() => expect(saves).toHaveLength(2));

    expect(saves[1]?.progress.stepId).toBe("02-display");
    expect(saves[1]?.signal.aborted).toBe(false);
    saver.stop();
  });

  it("should hold one pending save, the latest, and never start the ones it replaced", async () => {
    const { saver, saves } = startSaver();

    saver.send({ type: "progress.save", progress: makeProgress("01-read") });
    saver.send({ type: "progress.save", progress: makeProgress("02-display") });
    saver.send({ type: "progress.save", progress: makeProgress("03-helper") });
    saves[0]?.settle.resolve();
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    saves[1]?.settle.resolve();
    await waitFor(saver, (snapshot) => snapshot.matches("idle"));

    expect(saves.map((save) => save.progress.stepId)).toEqual(["01-read", "03-helper"]);
    saver.stop();
  });

  it("should start the pending save after a failed one", async () => {
    const { saver, saves } = startSaver();

    saver.send({ type: "progress.save", progress: makeProgress("01-read") });
    saver.send({ type: "progress.save", progress: makeProgress("02-display") });
    saves[0]?.settle.reject(new Error("quota"));

    await vi.waitFor(() => expect(saves).toHaveLength(2));
    expect(saver.getSnapshot().matches("saving")).toBe(true);
    saver.stop();
  });
});

describe("runWithRuntime", () => {
  it("should start one run per call and cancel it when the signal aborts", async () => {
    let resolve!: (result: RunResult) => void;
    const run = {
      start: vi.fn(),
      cancel: vi.fn(async () => resolve(fakeRunResult("cancelled"))),
      result: new Promise<RunResult>((done) => {
        resolve = done;
      }),
    };
    const createRun = vi.fn(() => run);
    const controller = new AbortController();
    const createComparison = vi.fn();
    const pending = runWithRuntime({ createRun, createComparison })(manifest.project, controller.signal);

    expect(run.start).toHaveBeenCalledOnce();
    controller.abort();

    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(createComparison).not.toHaveBeenCalled();
  });
});

describe("side-by-side guides", () => {
  const pairGuide = parseGuideManifest({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id: "pair",
    title: "Both sides",
    project: pairManifest(),
    steps: [
      {
        type: "walkthrough",
        id: "01-sides",
        label: "Sides",
        title: "Each side",
        body: "Run both.",
        edits: [{ file: "query.ts", side: 1, replace: { anchor: "// next", with: '$.display("Rows", [1]);' } }],
        run: "required",
      },
    ],
  });

  it("should run both sides, need both to succeed, and compare nothing", async () => {
    const runs = controlledRuns();
    const emitted: GuideEmitted[] = [];
    const actor = createActor(createGuideMachine({ run: runs.run }), { input: { manifest: pairGuide } });

    actor.on("run.settled", (event) => emitted.push(event));
    actor.start();
    await settled(actor);
    actor.send({ type: "run.start" });

    expect(projectFiles(runs.pending[0].manifest, 1)["query.ts"]).toContain("$.display");
    expect(projectFiles(runs.pending[0].manifest, 0)["query.ts"]).toContain("// next");

    runs.pending[0].resolve([fakeRunResult("succeeded"), fakeRunResult("failed", { message: "rc only" })]);
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    expect(guideView(actor.getSnapshot())).toMatchObject({ error: "rc only", canNext: false, changes: undefined });
    expect(emitted[0]).not.toHaveProperty("changes");

    actor.send({ type: "run.start" });
    runs.pending[1].resolve([fakeRunResult("succeeded"), fakeRunResult("succeeded", { displays: rows(1) })]);
    await waitFor(actor, (snapshot) => snapshot.context.completed.includes("01-sides"));

    expect(guideView(actor.getSnapshot()).canNext).toBe(true);
    actor.stop();
  });

  it("should hand checks each side's result with that side's own files", async () => {
    const runs = controlledRuns();
    const emitted: GuideEmitted[] = [];
    const actor = createActor(createGuideMachine({ run: runs.run }), { input: { manifest: pairGuide } });
    actor.on("run.settled", (event) => emitted.push(event));
    actor.start();
    await settled(actor);
    actor.send({ type: "run.start" });
    const sideResults = [fakeRunResult("succeeded"), fakeRunResult("succeeded", { displays: rows(1) })] as const;
    runs.pending[0].resolve(sideResults);
    await waitFor(actor, (snapshot) => snapshot.matches({ step: { walkthrough: "after" } }));

    const event = emitted[0];
    assert(event?.type === "run.settled");
    const checked = listGuideCheckedRuns(event.result, event.project);

    expect(checked.map((run) => run.result)).toEqual(sideResults);
    expect(checked[0]?.files["query.ts"]).toContain("// next");
    expect(checked[1]?.files["query.ts"]).toContain("$.display");
    actor.stop();
  });

  it("should use one SDK comparison and preserve both sides' outcomes", async () => {
    const results = { a: fakeRunResult("failed"), b: fakeRunResult("succeeded") };
    const comparison = {
      start: vi.fn(),
      cancel: vi.fn(async () => undefined),
      result: Promise.resolve(results),
    };
    const createRun = vi.fn();
    const createComparison = vi.fn(() => comparison);
    const result = await runWithRuntime({ createRun, createComparison })(
      pairGuide.project,
      new AbortController().signal,
    );

    expect(createComparison).toHaveBeenCalledExactlyOnceWith(
      { a: pairSide(pairManifest(), 0), b: pairSide(pairManifest(), 1) },
      { execution: "sequential" },
    );
    expect(comparison.start).toHaveBeenCalledOnce();
    expect(createRun).not.toHaveBeenCalled();
    expect(result).toEqual([results.a, results.b]);
  });

  it("should cancel the SDK comparison and wait for aggregate cleanup", async () => {
    const controller = new AbortController();
    const completion = Promise.withResolvers<ComparisonResult>();
    const comparison = {
      start: vi.fn(),
      cancel: vi.fn(async () => {
        await completion.promise;
      }),
      result: completion.promise,
    };
    const createRun = vi.fn();
    const createComparison = vi.fn(() => comparison);
    const onSettled = vi.fn();
    const pending = runWithRuntime({ createRun, createComparison })(pairGuide.project, controller.signal).then(
      onSettled,
    );

    controller.abort();
    await Promise.resolve();

    expect(comparison.cancel).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    const results = { a: fakeRunResult("cancelled"), b: fakeRunResult("cancelled") };
    completion.resolve(results);
    await pending;

    expect(onSettled).toHaveBeenCalledWith([results.a, results.b]);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("should propagate aggregate rejection and remove its cancellation listener", async () => {
    const completion = Promise.withResolvers<ComparisonResult>();
    const comparison = { start: vi.fn(), cancel: vi.fn(), result: completion.promise };
    const controller = new AbortController();
    const pending = runWithRuntime({ createRun: vi.fn(), createComparison: vi.fn(() => comparison) })(
      pairGuide.project,
      controller.signal,
    );
    const failure = new Error("Host termination failed");
    completion.reject(failure);

    await expect(pending).rejects.toBe(failure);
    controller.abort();
    expect(comparison.cancel).not.toHaveBeenCalled();
  });

  it("should not allocate a comparison after the step was left", async () => {
    const runtime = { createRun: vi.fn(), createComparison: vi.fn() };

    await expect(runWithRuntime(runtime)(pairGuide.project, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(runtime.createRun).not.toHaveBeenCalled();
    expect(runtime.createComparison).not.toHaveBeenCalled();
  });
});

describe("guides that split and merge", () => {
  const splitGuide = parseGuideManifest({
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id: "split",
    title: "Split and merge",
    project: projectManifest(),
    steps: [
      {
        type: "walkthrough",
        id: "01-split",
        label: "Split",
        title: "Two ways",
        body: "Run both.",
        split: { sides: [{ name: "SQL-like" }, { name: "RQB" }], files: ["query.ts"] },
        run: "required",
      },
      {
        type: "walkthrough",
        id: "02-merge",
        label: "Merge",
        title: "Keep RQB",
        body: "Run it.",
        merge: { keep: 1 },
        run: "required",
      },
    ],
  });

  it("should compare the run after a merge with the side it keeps", async () => {
    const runs = controlledRuns();
    const actor = createActor(createGuideMachine({ run: runs.run }), { input: { manifest: splitGuide } });
    const kept = fakeRunResult("succeeded", { displays: rows(1, 2) });
    const next = fakeRunResult("succeeded", { displays: rows(1, 2, 3) });

    actor.start();
    await settled(actor);
    actor.send({ type: "run.start" });
    runs.pending[0].resolve([fakeRunResult("succeeded", { displays: rows(1) }), kept]);
    await waitFor(actor, (snapshot) => snapshot.context.completed.includes("01-split"));

    expect(guideView(actor.getSnapshot()).changes).toBeUndefined();
    actor.send({ type: "step.next" });
    actor.send({ type: "run.start" });

    expect(isPairProject(runs.pending[1].manifest)).toBe(false);
    runs.pending[1].resolve(next);
    await waitFor(actor, (snapshot) => snapshot.context.completed.includes("02-merge"));

    expect(guideView(actor.getSnapshot()).changes).toEqual(diffRunResults(kept, next));
    expect(guideView(actor.getSnapshot()).since).toEqual({ step: 0, side: 1 });
    actor.stop();
  });
});
