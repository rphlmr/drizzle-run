import type { Runtime } from "@drizzle-run/core/contracts";
import type { GuideManifest, GuideProject, GuideStep, RunResultDiff } from "@drizzle-run/core/guide";
import type {
  GuideComparison,
  GuideProgress,
  GuideRunResult,
  GuideServices,
  GuideView,
} from "@drizzle-run/runtime/guides";
import { createGuideMachine, guideView, runWithRuntime } from "@drizzle-run/runtime/machines";
import { useActorRef, useSelector } from "@xstate/react";
import { createElement, useEffect, useEffectEvent, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { AnyActorRef } from "xstate";

import { guideScope } from "./guide-scope.ts";

/** Host callbacks. They observe the flow; they never change it. */
export interface GuideCallbacks {
  onStepChange?: (event: { index: number; step: GuideStep; project: GuideProject }) => void;
  /**
   * A run at step `index` settled. `changes` compares it with the run before, named by `since`. The first run has no
   * `since`, and every display in `changes` is added. Both are absent for a side-by-side run, and for a one-version run
   * after a side-by-side step that names no side to `merge`. `project` is what ran; pass both to
   * `listGuideCheckedRuns` to give checks each side's files.
   */
  onRunSettled?: (event: {
    index: number;
    project: GuideProject;
    result: GuideRunResult;
    changes: RunResultDiff | undefined;
    since: GuideComparison | undefined;
  }) => void;
  /** A step's run could not start or finish, such as `services.run` rejecting; the learner can run it again. */
  onRunError?: (error: string) => void;
  onLeave?: () => void;
  onDone?: () => void;
}

export interface GuideProviderProps {
  manifest: GuideManifest;
  /** Runs steps and sequential comparisons through the SDK; or supply `services.run`. */
  runtime?: Pick<Runtime, "createRun" | "createComparison">;
  /**
   * `loadProgress` reads saved progress; a read that fails or takes longer than `progressLoadTimeoutMs` opens the guide
   * without it and turns saving off for the visit. `saveProgress` runs one save at a time, in order. Each gets a signal
   * that aborts once its answer no longer counts: a load on that timeout, a save when a newer one replaces it.
   */
  services?: {
    run?: GuideServices["run"];
    loadProgress?: (guideId: string, signal: AbortSignal) => Promise<unknown>;
    saveProgress?: (progress: GuideProgress, signal: AbortSignal) => Promise<void>;
  };
  callback?: GuideCallbacks;
  /** A 0-based step to open; wins over saved progress. */
  startAt?: number;
  /** How long the guide waits for saved progress before it opens without it; 5 seconds by default. Read once. */
  progressLoadTimeoutMs?: number;
  /** Reports a failure that stops the guide itself. Selector hooks also surface it to an error boundary. */
  onError?: (error: unknown) => void;
  children?: ReactNode;
}

/**
 * Mount a guide flow
 *
 * The host renders its own UI with the hooks below and owns layout, copy, routing, and persistence through the
 * services. `manifest`, `startAt` and `progressLoadTimeoutMs` are read once, when the provider mounts: to open another
 * guide, give the provider a new `key`. `runtime`, `services` and `callback` may change on any render; the latest ones
 * are called.
 */
export function GuideProvider({
  manifest,
  runtime,
  services,
  callback,
  startAt,
  progressLoadTimeoutMs,
  onError,
  children,
}: GuideProviderProps): ReactElement {
  // The machine is built once and calls these, which read the latest props: the host may pass new functions on each
  // render.
  const runStep = useEffectEvent((project: GuideProject, signal: AbortSignal) => {
    if (services?.run) {
      return services.run(project, signal);
    }

    if (!runtime) {
      return Promise.reject(new Error("GuideProvider needs a runtime or services.run."));
    }

    return runWithRuntime(runtime)(project, signal);
  });
  const loadProgress = useEffectEvent(async (guideId: string, signal: AbortSignal) =>
    services?.loadProgress?.(guideId, signal),
  );
  const saveProgress = useEffectEvent(async (progress: GuideProgress, signal: AbortSignal) =>
    services?.saveProgress?.(progress, signal),
  );
  const readCallbacks = useEffectEvent(() => callback);

  const [logic] = useState(() =>
    createGuideMachine(
      {
        run: (project, signal) => runStep(project, signal),
        loadProgress: (guideId, signal) => loadProgress(guideId, signal),
        saveProgress: (progress, signal) => saveProgress(progress, signal),
      },
      { progressLoadTimeoutMs },
    ),
  );
  const actor = useActorRef(logic, { input: { manifest, startAt } });

  useEffect(() => {
    const subscriptions = [
      actor.on("step.changed", ({ index, step, project }) => readCallbacks()?.onStepChange?.({ index, step, project })),
      actor.on("run.settled", ({ index, project, result, changes, since }) =>
        readCallbacks()?.onRunSettled?.({ index, project, result, changes, since }),
      ),
      actor.on("run.failed", ({ error }) => readCallbacks()?.onRunError?.(error)),
      actor.on("guide.left", () => readCallbacks()?.onLeave?.()),
      actor.on("guide.finished", () => readCallbacks()?.onDone?.()),
    ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    };
  }, [actor]);

  return createElement(guideScope.Provider, { actor, onError }, children);
}

/** Read the guide actor; throws an `Error` outside `GuideProvider`. */
function useGuideActor() {
  return guideScope.useActorRef();
}

/** Selects from the guide's view; re-renders only when the selection changes. */
export function useGuideSelector<Selection>(
  selector: (view: GuideView) => Selection,
  compare?: (left: Selection, right: Selection) => boolean,
): Selection {
  return useSelector(useGuideActor(), (snapshot) => selector(guideView(snapshot)), compare);
}

function hasSameFields<Fields extends object>(left: Fields, right: Fields) {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => Object.is(value, Reflect.get(right, key)))
  );
}

/** The current step and what the learner can do there. */
export function useGuideStep(): Pick<
  GuideView,
  "stage" | "index" | "count" | "step" | "project" | "editorLocked" | "canRun" | "canNext" | "canBack" | "completed"
> {
  return useGuideSelector(
    ({ stage, index, count, step, project, editorLocked, canRun, canNext, canBack, completed }) => ({
      stage,
      index,
      count,
      step,
      project,
      editorLocked,
      canRun,
      canNext,
      canBack,
      completed,
    }),
    hasSameFields,
  );
}

/** The latest run at this step and what changed since the run before. */
export function useRunOutput(): {
  running: boolean;
  result: GuideRunResult | undefined;
  changes: RunResultDiff | undefined;
  /** The run `changes` compares with, when there was one. */
  since: GuideComparison | undefined;
  error: string;
} {
  return useGuideSelector(
    ({ stage, result, changes, since, error }) => ({ running: stage === "running", result, changes, since, error }),
    hasSameFields,
  );
}

/** Stable functions that mirror learner actions into guide events. */
export function useGuideActions() {
  const actor = useGuideActor();

  return useMemo(
    () => ({
      run: () => actor.send({ type: "run.start" }),
      cancel: () => actor.send({ type: "run.cancel" }),
      next: () => actor.send({ type: "step.next" }),
      back: () => actor.send({ type: "step.back" }),
      goToStep: (index: number) => actor.send({ type: "step.select", index }),
      leave: () => actor.send({ type: "guide.leave" }),
      resume: () => actor.send({ type: "guide.resume" }),
      restart: () => actor.send({ type: "guide.restart" }),
    }),
    [actor],
  );
}

/** Logs each state of an actor for development. Pass `enabled` from the host's own development flag. */
function useMachineDebug(actor: AnyActorRef, label: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const subscription = actor.subscribe((snapshot: { value?: unknown; context?: unknown }) => {
      console.debug(`[${label}]`, snapshot.value, snapshot.context);
    });

    return () => subscription.unsubscribe();
  }, [actor, label, enabled]);
}

/** Logs the guide flow for development. */
export function useGuideDebug(enabled: boolean): void {
  useMachineDebug(useGuideActor(), "guide", enabled);
}

/** The last completed guide run, including its comparison when still on the same step. */
export function useGuideLastRun(): GuideLastRun {
  return useSelector(
    useGuideActor(),
    ({ context }) => ({
      lastResult: context.lastResult,
      lastResultStep: context.lastResultStep,
      result: context.result,
      changes: context.changes,
      since: context.since,
    }),
    hasSameFields,
  );
}

export interface GuideLastRun {
  lastResult: GuideRunResult | undefined;
  lastResultStep: number | undefined;
  result: GuideRunResult | undefined;
  changes: RunResultDiff | undefined;
  since: GuideComparison | undefined;
}
