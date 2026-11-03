import type { ComparisonHandle, RunHandle, RunResult, Runtime } from "@drizzle-run/core/contracts";
import {
  diffRunResults,
  isPairProject,
  resolveStep,
  type GuideManifest,
  type GuideProject,
  type GuideStep,
  type RunResultDiff,
} from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { pairSide, type PairSideIndex } from "@drizzle-run/core/pair";
import { assign, createActor, emit, fromPromise, setup, type SnapshotFrom } from "xstate";

import type {
  GuideProgress,
  PairRunResult,
  GuideRunResult,
  GuideCheckedRun,
  GuideServices,
  GuideProgressState,
  GuideComparison,
  GuideStage,
  GuideView,
} from "../guide-contract.ts";
export type {
  GuideProgress,
  PairRunResult,
  GuideRunResult,
  GuideCheckedRun,
  GuideServices,
  GuideProgressState,
  GuideComparison,
  GuideStage,
  GuideView,
} from "../guide-contract.ts";

import { declareType } from "./declare-type.ts";
import { getErrorText } from "./error-text.ts";

/** True when a guide run returned one result per side */
export function isPairRunResult(result: GuideRunResult): result is PairRunResult {
  return Array.isArray(result);
}

/**
 * List what a guide run's checks read
 *
 * One entry for a one-version run, and one per side for a side-by-side run, first side first, so a host can run
 * `evaluateChecks(run.result, checks, { files: run.files })` on each side.
 */
export function listGuideCheckedRuns(result: GuideRunResult, project: GuideProject): GuideCheckedRun[] {
  if (!isPairRunResult(result)) {
    return [{ result, files: project.files }];
  }

  const [first, second] = result;
  const getSideFiles = (side: PairSideIndex) =>
    isPairProject(project) ? pairSide(project, side).files : project.files;

  return [
    { result: first, files: getSideFiles(0) },
    { result: second, files: getSideFiles(1) },
  ];
}

/** One outcome for a guide run: cancelled if a side was, failed if a side failed, else succeeded. */
export function guideRunOutcome(result: GuideRunResult): RunResult["outcome"] {
  const results: readonly RunResult[] = isPairRunResult(result) ? result : [result];

  if (results.some((item) => item.outcome === "cancelled")) {
    return "cancelled";
  }

  return results.some((item) => item.outcome === "failed") ? "failed" : "succeeded";
}

function getGuideRunError(result: GuideRunResult): string {
  const results: readonly RunResult[] = isPairRunResult(result) ? result : [result];

  for (const item of results) {
    if (item.outcome === "failed") {
      return item.error.message;
    }
  }

  return "";
}

/** Options of `createGuideMachine` */
export interface GuideMachineOptions {
  /** How long the guide waits for saved progress before it opens without it; 5 seconds by default. */
  progressLoadTimeoutMs?: number;
}

/** The guide machine's input */
export interface GuideInput {
  manifest: GuideManifest;
  /** A 0-based step to open, such as from a URL; wins over saved progress. */
  startAt?: number;
}

/** The guide machine's context */
export interface GuideContext {
  manifest: GuideManifest;
  startAt: number | undefined;
  index: number;
  /** The project before this step's edits. */
  previous: GuideProject;
  /** The project the learner sees at this step: the editors show it, read-only. */
  project: GuideProject;
  completed: readonly string[];
  finished: boolean;
  progress: GuideProgressState;
  /** The run shown at this step, once one settled in this visit. */
  result: GuideRunResult | undefined;
  /** The last settled run in the guide, the baseline for "what changed". */
  lastResult: GuideRunResult | undefined;
  /** The 0-based step `lastResult` ran at. */
  lastResultStep: number | undefined;
  /** What changed since the last run; side-by-side guides compare nothing. */
  changes: RunResultDiff | undefined;
  /** The run `changes` compares with, when there was one. */
  since: GuideComparison | undefined;
  error: string;
}

/** Public events. Their names are part of the runtime's API. */
export type GuideEvent =
  | { type: "run.start" }
  | { type: "run.cancel" }
  | { type: "step.next" }
  | { type: "step.back" }
  /** Returns to an earlier step, such as a finished step the learner clicks; a later or unknown index is ignored. */
  | { type: "step.select"; index: number }
  /** Leaves the guide: the editor unlocks and the files stay as they are. */
  | { type: "guide.leave" }
  /** Returns to the step the learner left. */
  | { type: "guide.resume" }
  | { type: "guide.restart" };

/** Emitted for hosts: callbacks, analytics, and the editor's files. */
export type GuideEmitted =
  | { type: "step.changed"; index: number; step: GuideStep; project: GuideProject }
  /**
   * `project` is what ran: the step's project, read-only in a walkthrough. `changes` and `since` are absent for a
   * side-by-side run, whose sides are never compared.
   */
  | {
      type: "run.settled";
      index: number;
      project: GuideProject;
      result: GuideRunResult;
      changes?: RunResultDiff;
      since?: GuideComparison;
    }
  | { type: "run.failed"; error: string }
  | { type: "guide.left" }
  | { type: "guide.finished" };

function getCurrentStep(context: GuideContext): GuideStep {
  return context.manifest.steps[context.index];
}

function isLastStep(context: GuideContext) {
  return context.index === context.manifest.steps.length - 1;
}

function withId(ids: readonly string[], id: string) {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

/** Reads saved progress, ignoring anything malformed or from another version of the guide. */
export function readGuideProgress(value: unknown, manifest: GuideManifest): GuideProgress | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const progress: Partial<Record<keyof GuideProgress, unknown>> = value;
  const ids = manifest.steps.map((step) => step.id);
  const { guideId, stepId, completed, finished } = progress;

  if (
    guideId !== manifest.id ||
    typeof stepId !== "string" ||
    !ids.includes(stepId) ||
    !Array.isArray(completed) ||
    !completed.every((id) => typeof id === "string") ||
    typeof finished !== "boolean"
  ) {
    return undefined;
  }

  return { guideId, stepId, completed: completed.filter((id) => ids.includes(id)), finished };
}

function getStepContext(context: GuideContext, index: number): Partial<GuideContext> {
  const resolved = resolveStep(context.manifest, index);

  return {
    index,
    previous: resolved.previous,
    project: resolved.project,
    result: undefined,
    changes: undefined,
    since: undefined,
    error: "",
  };
}

/**
 * What changed since the last run, for a one-version run, and which run that is
 *
 * A side-by-side run is not compared. A one-version run after a side-by-side one compares with the side the step's
 * merge keeps, which is the project's previous version; without a merge it is not compared.
 */
function compareWithLastRun(context: GuideContext, next: GuideRunResult): Pick<GuideContext, "changes" | "since"> {
  const previous = context.lastResult;
  const step = getCurrentStep(context);

  if (isPairRunResult(next)) {
    return { changes: undefined, since: undefined };
  }

  if (previous !== undefined && isPairRunResult(previous)) {
    if (step.merge === undefined) {
      return { changes: undefined, since: undefined };
    }

    return {
      changes: diffRunResults(previous[step.merge.keep], next),
      since: context.lastResultStep === undefined ? undefined : { step: context.lastResultStep, side: step.merge.keep },
    };
  }

  return {
    changes: diffRunResults(previous, next),
    since:
      previous === undefined || context.lastResultStep === undefined ? undefined : { step: context.lastResultStep },
  };
}

function resolveValidStart(manifest: GuideManifest, startAt: number | undefined) {
  const isValid = startAt !== undefined && Number.isInteger(startAt) && startAt >= 0 && startAt < manifest.steps.length;

  return isValid ? startAt : undefined;
}

/** The step and completed steps saved progress opens on; a requested step wins over the saved one. */
function restoreProgress(context: GuideContext, saved: unknown): Partial<GuideContext> {
  const progress = readGuideProgress(saved, context.manifest);
  const savedIndex = progress ? context.manifest.steps.findIndex((step) => step.id === progress.stepId) : -1;

  return {
    index: resolveValidStart(context.manifest, context.startAt) ?? Math.max(savedIndex, 0),
    completed: progress?.completed ?? [],
    progress: "loaded",
  };
}

function toGuideProgress(context: GuideContext): GuideProgress {
  return {
    guideId: context.manifest.id,
    stepId: getCurrentStep(context).id,
    completed: context.completed,
    finished: context.finished,
  };
}

/** How long the guide waits for saved progress before it opens without it, unless `createGuideMachine` sets it. */
const LOAD_PROGRESS_TIMEOUT_MS = 5_000;

const guideSetup = setup({
  types: {
    input: declareType<GuideInput>(),
    context: declareType<GuideContext>(),
    events: declareType<GuideEvent>(),
    emitted: declareType<GuideEmitted>(),
  },
  delays: {
    progressLoadTimeout: LOAD_PROGRESS_TIMEOUT_MS,
  },
  actors: {
    runStep: fromPromise<GuideRunResult, GuideProject>(async () => {
      throw new Error("The guide machine needs a run service. Build it with createGuideMachine.");
    }),
    loadProgress: fromPromise<unknown, string>(async () => undefined),
  },
  guards: {
    isKind: ({ context }, params: { kind: GuideStep["type"] }) => getCurrentStep(context).type === params.kind,
    isLast: ({ context }) => isLastStep(context),
    notFirst: ({ context }) => context.index > 0,
    isEarlierStep: ({ context }, params: { index: number }) =>
      Number.isInteger(params.index) && params.index >= 0 && params.index < context.index,
    isGuideStep: ({ context }, params: { index: number }) =>
      Number.isInteger(params.index) && params.index >= 0 && params.index < context.manifest.steps.length,
    canRun: ({ context }) => getCurrentStep(context).run !== "none",
    /** True when the run that settled is the step's first success, so the step is completed by it. */
    completesStep: ({ context }, params: { result: GuideRunResult }) =>
      guideRunOutcome(params.result) === "succeeded" && !context.completed.includes(getCurrentStep(context).id),
    /** A finished guide reopens on its end, unless a step was asked for. */
    opensOnEnd: ({ context }, params: { saved: unknown }) =>
      resolveValidStart(context.manifest, context.startAt) === undefined &&
      readGuideProgress(params.saved, context.manifest)?.finished === true,
    /** Next is open unless the step requires a run that has not succeeded, now or in an earlier visit. */
    canAdvance: ({ context }, params: { last: boolean }) =>
      isLastStep(context) === params.last &&
      (getCurrentStep(context).run !== "required" || context.completed.includes(getCurrentStep(context).id)),
  },
  actions: {
    enterStep: assign(({ context }) => getStepContext(context, context.index)),
    nextStep: assign(({ context }) => ({ index: context.index + 1 })),
    previousStep: assign(({ context }) => ({ index: context.index - 1 })),
    complete: assign(({ context }) => ({ completed: withId(context.completed, getCurrentStep(context).id) })),
    startWithoutProgress: assign(({ context }) => ({
      index: resolveValidStart(context.manifest, context.startAt) ?? 0,
      progress: "unavailable" as const,
    })),
    emitStep: emit(({ context }): GuideEmitted => ({
      type: "step.changed",
      index: context.index,
      step: getCurrentStep(context),
      project: context.project,
    })),
    emitFailure: emit(({ context }): GuideEmitted => ({ type: "run.failed", error: context.error })),
    settleRun: assign(({ context }, params: { result: GuideRunResult }) => ({
      ...compareWithLastRun(context, params.result),
      result: params.result,
      lastResult: params.result,
      lastResultStep: context.index,
      error: getGuideRunError(params.result),
      completed:
        guideRunOutcome(params.result) === "succeeded"
          ? withId(context.completed, getCurrentStep(context).id)
          : context.completed,
    })),
    // Runs after `settleRun`, so `changes` already compares with the run before.
    emitRunSettled: emit(({ context }, params: { result: GuideRunResult }): GuideEmitted => ({
      type: "run.settled",
      index: context.index,
      project: context.project,
      result: params.result,
      ...(context.changes === undefined ? {} : { changes: context.changes }),
      ...(context.since === undefined ? {} : { since: context.since }),
    })),
    /** Saves the progress in context, once it loaded; `createGuideMachine` provides it with the host's store. */
    saveProgress: () => undefined,
  },
});

const advanceTransitions = [
  {
    guard: { type: "canAdvance", params: { last: true } },
    target: "#guide.done",
    actions: "complete",
  },
  {
    guard: { type: "canAdvance", params: { last: false } },
    target: "#guide.step",
    reenter: true,
    actions: ["complete", "nextStep"],
  },
] as const;

/**
 * Walkthrough: edits apply when the step starts and the editor stays read-only; the
 * learner runs, sees what changed, then moves on. A required run must succeed first.
 */
const walkthroughStates = guideSetup.createStateConfig({
  initial: "before",
  states: {
    before: {
      on: { "run.start": { guard: "canRun", target: "running" }, "step.next": [...advanceTransitions] },
    },
    running: {
      invoke: {
        src: "runStep",
        input: ({ context }) => resolveStep(context.manifest, context.index).project,
        onDone: [
          { guard: ({ event }) => guideRunOutcome(event.output) === "cancelled", target: "before" },
          {
            guard: { type: "completesStep", params: ({ event }) => ({ result: event.output }) },
            target: "after",
            actions: [
              { type: "settleRun", params: ({ event }) => ({ result: event.output }) },
              "saveProgress",
              { type: "emitRunSettled", params: ({ event }) => ({ result: event.output }) },
            ],
          },
          {
            target: "after",
            actions: [
              { type: "settleRun", params: ({ event }) => ({ result: event.output }) },
              { type: "emitRunSettled", params: ({ event }) => ({ result: event.output }) },
            ],
          },
        ],
        onError: {
          target: "failed",
          actions: [assign(({ event }) => ({ error: getErrorText(event.error) })), "emitFailure"],
        },
      },
      on: { "run.cancel": "before" },
    },
    /** A run settled; a failed one shows its problems like any other result. */
    after: {
      on: { "run.start": "running", "step.next": [...advanceTransitions] },
    },
    /** The run service itself failed, so there is no result to show. */
    failed: {
      on: { "run.start": "running", "step.next": [...advanceTransitions] },
    },
  },
});

/**
 * The states each step kind contributes. Adding a kind (exercise, quiz) adds an entry
 * here and to `GuideStep`; the walkthrough states and the public events stay the same.
 */
const STEP_KIND_STATES = {
  walkthrough: walkthroughStates,
} satisfies Record<GuideStep["type"], unknown>;

const stepKinds = Object.keys(STEP_KIND_STATES).filter(isStepKind);

function isStepKind(kind: string): kind is keyof typeof STEP_KIND_STATES {
  return Object.hasOwn(STEP_KIND_STATES, kind);
}

/**
 * Guide machine
 *
 * Walks a learner through a guide's steps: loads saved progress, opens each step's project read-only, runs
 * it, and compares the result with the run before. Emits events for the host's callbacks and persistence.
 */
export const guideMachine = guideSetup.createMachine({
  id: "guide",
  initial: "loading",
  context: ({ input }) => {
    const resolved = resolveStep(input.manifest, 0);

    return {
      manifest: input.manifest,
      startAt: input.startAt,
      index: 0,
      previous: resolved.previous,
      project: resolved.project,
      completed: [],
      finished: false,
      result: undefined,
      lastResult: undefined,
      lastResultStep: undefined,
      changes: undefined,
      since: undefined,
      error: "",
      progress: "loading",
    };
  },
  states: {
    loading: {
      invoke: {
        src: "loadProgress",
        input: ({ context }) => context.manifest.id,
        onDone: [
          {
            guard: { type: "opensOnEnd", params: ({ event }) => ({ saved: event.output }) },
            target: "done",
            actions: assign(({ context, event }) => ({
              ...getStepContext(context, context.manifest.steps.length - 1),
              ...restoreProgress(context, event.output),
              index: context.manifest.steps.length - 1,
            })),
          },
          { target: "step", actions: assign(({ context, event }) => restoreProgress(context, event.output)) },
        ],
        onError: { target: "step", actions: "startWithoutProgress" },
      },
      after: { progressLoadTimeout: { target: "step", actions: "startWithoutProgress" } },
    },
    step: {
      entry: ["enterStep", "emitStep", "saveProgress"],
      initial: "dispatch",
      on: {
        "step.back": { guard: "notFirst", target: "step", reenter: true, actions: "previousStep" },
        "step.select": {
          guard: { type: "isEarlierStep", params: ({ event }) => ({ index: event.index }) },
          target: "step",
          reenter: true,
          actions: assign(({ event }) => ({ index: event.index })),
        },
        "guide.leave": "left",
      },
      states: {
        dispatch: {
          always: stepKinds.map((kind) => ({ guard: { type: "isKind" as const, params: { kind } }, target: kind })),
        },
        ...STEP_KIND_STATES,
      },
    },
    /** The learner left: the editor unlocks and keeps whatever they change. */
    left: {
      entry: emit({ type: "guide.left" }),
      on: { "guide.resume": "step" },
    },
    done: {
      entry: [assign({ finished: true }), "saveProgress", emit({ type: "guide.finished" })],
      on: {
        "step.back": {
          target: "step",
          actions: assign(({ context }) => ({ index: context.manifest.steps.length - 1, finished: false })),
        },
        "step.select": {
          guard: { type: "isGuideStep", params: ({ event }) => ({ index: event.index }) },
          target: "step",
          actions: assign(({ event }) => ({ index: event.index, finished: false })),
        },
        "guide.restart": {
          target: "step",
          actions: assign({
            index: 0,
            completed: [],
            finished: false,
            lastResult: undefined,
            lastResultStep: undefined,
          }),
        },
      },
    },
  },
});

/** A snapshot of the guide machine */
export type GuideSnapshot = SnapshotFrom<typeof guideMachine>;

interface GuideProgressSave {
  progress: GuideProgress;
  controller: AbortController;
}

interface GuideProgressSaverContext {
  current: GuideProgressSave | undefined;
  /** The save asked for while one runs: the latest replaces any before it. */
  pending: GuideProgress | undefined;
}

type GuideProgressSaverEvent = { type: "progress.save"; progress: GuideProgress };

function toProgressSave(progress: GuideProgress): GuideProgressSave {
  return { progress, controller: new AbortController() };
}

/**
 * Guide progress saver
 *
 * Runs one save at a time, in order, and holds at most one pending save. A newer save aborts the one that runs and
 * replaces the one that waits. A failed save is dropped. Provide `saveProgress` with the host's store.
 */
export const guideProgressSaverMachine = setup({
  types: {
    context: declareType<GuideProgressSaverContext>(),
    events: declareType<GuideProgressSaverEvent>(),
  },
  actors: {
    saveProgress: fromPromise<void, { progress: GuideProgress; signal: AbortSignal }>(async () => undefined),
  },
  guards: {
    hasPending: ({ context }) => context.pending !== undefined,
  },
  actions: {
    abortCurrent: ({ context }) => context.current?.controller.abort(),
    queue: assign({ pending: ({ event }) => event.progress }),
    startPending: assign(({ context }) => ({
      current: context.pending === undefined ? undefined : toProgressSave(context.pending),
      pending: undefined,
    })),
    clearCurrent: assign({ current: undefined }),
  },
}).createMachine({
  id: "guideProgressSaver",
  initial: "idle",
  context: { current: undefined, pending: undefined },
  states: {
    idle: {
      on: {
        "progress.save": {
          target: "saving",
          actions: assign({ current: ({ event }) => toProgressSave(event.progress) }),
        },
      },
    },
    saving: {
      invoke: {
        src: "saveProgress",
        input: ({ context }) => {
          if (context.current === undefined) {
            throw new Error("Expected a progress save to run in the saving state, but none was set.");
          }

          return { progress: context.current.progress, signal: context.current.controller.signal };
        },
        onDone: [
          { guard: "hasPending", target: "saving", reenter: true, actions: "startPending" },
          { target: "idle", actions: "clearCurrent" },
        ],
        onError: [
          { guard: "hasPending", target: "saving", reenter: true, actions: "startPending" },
          { target: "idle", actions: "clearCurrent" },
        ],
      },
      on: {
        "progress.save": { actions: ["abortCurrent", "queue"] },
      },
    },
  },
});

/**
 * Build the guide machine with the host's services
 *
 * `options.progressLoadTimeoutMs` sets how long the guide waits for saved progress before it opens without it. Every
 * guide actor of the returned machine saves through one progress saver that outlives it, so stopping a guide never
 * aborts its last save.
 */
export function createGuideMachine(services: GuideServices, options: GuideMachineOptions = {}) {
  const progressSaver =
    services.saveProgress === undefined
      ? undefined
      : createActor(
          guideProgressSaverMachine.provide({
            actors: {
              saveProgress: fromPromise<void, { progress: GuideProgress; signal: AbortSignal }>(async ({ input }) =>
                services.saveProgress?.(input.progress, input.signal),
              ),
            },
          }),
        ).start();

  return guideMachine.provide({
    delays: { progressLoadTimeout: options.progressLoadTimeoutMs ?? LOAD_PROGRESS_TIMEOUT_MS },
    actors: {
      runStep: fromPromise<GuideRunResult, GuideProject>(({ input, signal }) => services.run(input, signal)),
      loadProgress: fromPromise<unknown, string>(async ({ input, signal }) => services.loadProgress?.(input, signal)),
    },
    actions: {
      saveProgress: ({ context }) => {
        if (context.progress !== "loaded") {
          return;
        }

        progressSaver?.send({ type: "progress.save", progress: toGuideProgress(context) });
      },
    },
  });
}

/**
 * Run a guide step through the SDK, cancelling it when the step is left.
 * Pair projects use sequential SDK comparisons and wait for both sides' cleanup.
 */
export function runWithRuntime(runtime: {
  createRun(manifest: RunManifest): Pick<RunHandle, "start" | "cancel" | "result">;
  createComparison(
    ...args: Parameters<Runtime["createComparison"]>
  ): Pick<ComparisonHandle, "start" | "cancel" | "result">;
}): GuideServices["run"] {
  return async (project, signal) => {
    signal.throwIfAborted();

    if (!isPairProject(project)) {
      return executeGuideRun(runtime.createRun(project), signal);
    }

    const comparison = runtime.createComparison(
      { a: pairSide(project, 0), b: pairSide(project, 1) },
      { execution: "sequential" },
    );
    const result = await executeGuideRun(comparison, signal);

    return [result.a, result.b];
  };
}

async function executeGuideRun<Result>(
  run: Pick<RunHandle, "start" | "cancel"> & { result: Promise<Result> },
  signal: AbortSignal,
): Promise<Result> {
  const cancel = () => {
    void run.cancel().catch(() => undefined);
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    run.start();

    return await run.result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function getGuideStage(snapshot: GuideSnapshot): GuideStage {
  if (snapshot.matches("loading")) {
    return "loading";
  }

  if (snapshot.matches("left")) {
    return "left";
  }

  if (snapshot.matches("done")) {
    return "done";
  }

  if (snapshot.matches({ step: { walkthrough: "running" } })) {
    return "running";
  }

  if (snapshot.matches({ step: { walkthrough: "after" } })) {
    return "after";
  }

  if (snapshot.matches({ step: { walkthrough: "failed" } })) {
    return "failed";
  }

  return "before";
}

/** Derive what a guide UI renders from a snapshot */
export function guideView(snapshot: GuideSnapshot): GuideView {
  const { context } = snapshot;
  const stage = getGuideStage(snapshot);

  return {
    stage,
    index: context.index,
    count: context.manifest.steps.length,
    step: getCurrentStep(context),
    project: context.project,
    editorLocked: stage !== "left" && stage !== "done",
    canRun: snapshot.can({ type: "run.start" }),
    canNext: snapshot.can({ type: "step.next" }),
    canBack: snapshot.can({ type: "step.back" }),
    result: context.result,
    changes: context.changes,
    since: context.since,
    error: context.error,
    completed: context.completed,
    progress: context.progress,
  };
}
