import type { RunResult } from "@drizzle-run/core/contracts";
import type { GuideProject, GuideStep, RunResultDiff } from "@drizzle-run/core/guide";
import type { PairSideIndex } from "@drizzle-run/core/pair";

/** Saved by the `saveProgress` service; keyed by step id so reordered guides keep what was done. */
export interface GuideProgress {
  guideId: string;
  /** The step the learner is on. */
  stepId: string;
  /** Steps the learner left with Next. */
  completed: readonly string[];
  finished: boolean;
}

/** A side-by-side guide's run: one result per side, first side first. */
export type PairRunResult = readonly [RunResult, RunResult];

/** What a guide's run service returns: one result, or one per side for a side-by-side guide. */
export type GuideRunResult = RunResult | PairRunResult;

/** One side of a guide run, as a step's checks read it: its result and the files it ran. */
export interface GuideCheckedRun {
  result: RunResult;
  /** Every file the side ran, by path: a side-by-side side's own copies over the shared files. */
  files: Readonly<Record<string, string>>;
}

/**
 * Side effects the guide machine needs. The host decides where progress lives
 * (IndexedDB, its own backend); the run service decides how code runs.
 */
export interface GuideServices {
  /** Runs the step's project; a side-by-side project resolves with both sides' results. */
  run(project: GuideProject, signal: AbortSignal): Promise<GuideRunResult>;
  /**
   * Reads saved progress. A read that fails, or takes longer than `progressLoadTimeoutMs` (5 seconds by default),
   * opens the guide without it and turns saving off for the visit, so a slow or broken store is never overwritten.
   * `signal` aborts once the guide stops waiting: on that timeout, or when the guide stops.
   */
  loadProgress?(guideId: string, signal: AbortSignal): Promise<unknown>;
  /**
   * Saves progress on each step, on a run that completes one, and at the end, one save at a time, in order
   *
   * Each save holds the whole progress, so a newer one replaces it: `signal` aborts when one is asked for while this
   * one waits or runs. Stopping the guide does not cancel its last save. Failed saves are dropped.
   */
  saveProgress?(progress: GuideProgress, signal: AbortSignal): Promise<void>;
}

/**
 * Where saved progress stands: `loading` until the read settles, `loaded` once it did (saves are on), and
 * `unavailable` when it failed or timed out (saves stay off for the visit).
 */
export type GuideProgressState = "loading" | "loaded" | "unavailable";

/**
 * The run a step's result is compared with: the last run in the guide, whichever step it ran at, and the side a merge
 * kept when that run was side by side.
 */
export interface GuideComparison {
  /** The 0-based step it ran at. */
  step: number;
  side?: PairSideIndex;
}

/** The guide stage a UI renders */
export type GuideStage = "loading" | "before" | "running" | "after" | "failed" | "left" | "done";

/** What a guide UI renders, derived from a snapshot. */
export interface GuideView {
  stage: GuideStage;
  index: number;
  count: number;
  step: GuideStep;
  project: GuideProject;
  /** The editor is read-only while the guide runs; it unlocks when the learner leaves or finishes. */
  editorLocked: boolean;
  canRun: boolean;
  canNext: boolean;
  canBack: boolean;
  result: GuideRunResult | undefined;
  changes: RunResultDiff | undefined;
  /** The run `changes` compares with, when there was one. */
  since: GuideComparison | undefined;
  error: string;
  completed: readonly string[];
  /** Where saved progress stands; while it is not `loaded`, nothing is saved, so a page can say so. */
  progress: GuideProgressState;
}
