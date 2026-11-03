import {
  isPairProject,
  projectFiles,
  resolveStep,
  type GuideManifest,
  type GuideProject,
  type GuideStep,
} from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { PAIR_SIDES, type PairManifest } from "@drizzle-run/core/pair";
import { isEqual, omit } from "es-toolkit";
import { assign, enqueueActions, setup } from "xstate";

import { declareType } from "../lib/declare-type";
import { getErrorText } from "../lib/error-text";
import { diffLines, getAddedRanges } from "../lib/line-diff";
import {
  createProjectFromManifest,
  editProject,
  type OneVersionProject,
  type SideBySideProject,
} from "../project/projects";
import { getSideMark, type SideMark } from "../side-by-side/side-marks";

type Files = Readonly<Record<string, string>>;

/** Lines the editor marks at a step. */
export interface StepHighlight {
  version: number;
  file: string;
  startLine: number;
  endLine: number;
}

/** The side-by-side project a split step shows, kept only while the guide is on such a step. */
export interface PairStage {
  project: SideBySideProject;
  /** The step's files as the guide showed them; edits since then are the learner's. */
  shown: PairManifest;
  /** Written into both editors each time `version` changes. */
  fileOverride: { version: number; manifest: PairManifest } | undefined;
  marks: { version: number; sides: readonly (SideMark | undefined)[] };
}

/** What the guided playground hears: a step the guide shows, and the learner's edits to a split step. */
export type GuidedStageEvent =
  | {
      type: "step.show";
      index: number;
      step: GuideStep;
      project: GuideProject;
      /** The one-version project the guide walks, as the page holds it now. */
      walked: OneVersionProject;
    }
  | { type: "pair.edit"; project: SideBySideProject };

/**
 * Emitted when a step's project cannot be built or written, for the page's error banner, and when the guide opens on
 * a walked project edited outside it, which the guide leaves as it is.
 */
export type GuidedStageEmitted = { type: "stage.error"; message: string } | { type: "stage.edited_outside" };

/** What the stage changes outside itself. */
export interface GuidedStageDependencies {
  /** Saves the walked project with a one-version step's files and release. */
  writeProject: (project: OneVersionProject) => void;
}

interface GuidedStageContext {
  guide: GuideManifest;
  projectName: string;
  /** Bumped on each step the guide shows, so the editors apply its files and marks once. */
  version: number;
  fileOverride: { version: number; files: Files } | undefined;
  highlight: StepHighlight | undefined;
  pair: PairStage | undefined;
}

/** Whether `files` are ones the guide leaves in the walked project: its start, or a one-version step's files. */
function isGuideState(guide: GuideManifest, files: Files): boolean {
  if (isEqual(projectFiles(guide.project), files)) {
    return true;
  }

  return guide.steps.some((_, index) => {
    const { project } = resolveStep(guide, index);

    return !isPairProject(project) && isEqual(project.files, files);
  });
}

/** The files a one-version step starts from: after a merge, the side it keeps. */
export function getFilesBefore(previous: GuideProject, step: GuideStep): Files {
  return projectFiles(previous, step.merge?.keep);
}

/**
 * A manifest on the release of a one-version step's project
 *
 * A merge may keep a side on another release than the project's, so the walked project takes the step's
 * `dependencies`, `guestFlavor` and `seedGeneratorVersion`, and drops the optional ones the step leaves out.
 */
function withStepRelease(manifest: RunManifest, stepProject: RunManifest): RunManifest {
  return {
    ...omit(manifest, ["guestFlavor", "seedGeneratorVersion"]),
    dependencies: stepProject.dependencies,
    ...(stepProject.guestFlavor === undefined ? {} : { guestFlavor: stepProject.guestFlavor }),
    ...(stepProject.seedGeneratorVersion === undefined
      ? {}
      : { seedGeneratorVersion: stepProject.seedGeneratorVersion }),
  };
}

/** The walked project at a one-version step, or undefined when it already holds the step's files and release. */
function resolveWalkedAtStep(walked: OneVersionProject, stepProject: RunManifest): OneVersionProject | undefined {
  const manifest = withStepRelease({ ...walked.manifest, files: { ...stepProject.files } }, stepProject);

  return isEqual(walked.manifest, manifest) ? undefined : editProject(walked, manifest);
}

/** Where the editor points at a step: its focus, else the first lines its edits add. */
function getStepHighlight(guide: GuideManifest, index: number, step: GuideStep) {
  if (step.focus) {
    return { file: step.focus.file, startLine: step.focus.lines[0], endLine: step.focus.lines[1] };
  }

  const { previous, project } = resolveStep(guide, index);
  const before = getFilesBefore(previous, step);
  const files = projectFiles(project);
  const file = Object.keys(files).find((path) => before[path] !== files[path]);
  const range = file === undefined ? undefined : getAddedRanges(diffLines(before[file] ?? "", files[file]))[0];

  return file === undefined || range === undefined ? undefined : { file, ...range };
}

function toPairStage(
  context: GuidedStageContext,
  version: number,
  { index, step, manifest }: { index: number; step: GuideStep; manifest: PairManifest },
): PairStage {
  const marks = { version, sides: PAIR_SIDES.map((side) => getSideMark(context.guide, index, step, side)) };
  const { pair } = context;

  if (pair === undefined) {
    return {
      project: createProjectFromManifest(context.projectName, manifest),
      shown: manifest,
      fileOverride: undefined,
      marks,
    };
  }

  const changed = !isEqual(pair.project.manifest, manifest);

  return {
    project: changed ? editProject(pair.project, manifest) : pair.project,
    shown: manifest,
    fileOverride: changed ? { version, manifest } : pair.fileOverride,
    marks,
  };
}

/**
 * Create the guided playground's stage machine
 *
 * Holds what the editors show at each step: the walked project's files and marks, or a split step's side-by-side
 * copy. Steps arrive in the order the guide emits them, so a step always builds on the one before. A one-version step
 * writes the walked project, then puts its files in the editors when they changed. A step whose project cannot be built
 * keeps the files the stage had, writes nothing, and emits `stage.error`.
 *
 * The editors are read-only while the guide runs, so the walked project only holds files the guide wrote. When the
 * first step arrives and the walked files are none of them, the project was edited outside the guide: the stage writes
 * nothing and emits `stage.edited_outside`.
 */
export function createGuidedStageMachine({ writeProject }: GuidedStageDependencies) {
  return setup({
    types: {
      context: declareType<GuidedStageContext>(),
      events: declareType<GuidedStageEvent>(),
      emitted: declareType<GuidedStageEmitted>(),
      input: declareType<{ guide: GuideManifest; projectName: string }>(),
    },
    actions: {
      writeProject: (_, project: OneVersionProject) => writeProject(project),
    },
  }).createMachine({
    id: "guidedStage",
    context: ({ input }) => ({
      guide: input.guide,
      projectName: input.projectName,
      version: 0,
      fileOverride: undefined,
      highlight: undefined,
      pair: isPairProject(input.guide.project)
        ? {
            project: createProjectFromManifest(input.projectName, input.guide.project),
            shown: input.guide.project,
            fileOverride: undefined,
            marks: { version: 0, sides: [] },
          }
        : undefined,
    }),
    on: {
      "step.show": {
        actions: enqueueActions(({ context, event, enqueue }) => {
          const version = context.version + 1;

          if (context.version === 0 && !isGuideState(context.guide, event.walked.manifest.files)) {
            enqueue.emit({ type: "stage.edited_outside" });
            return;
          }

          if (isPairProject(event.project)) {
            try {
              const pair = toPairStage(context, version, { ...event, manifest: event.project });
              enqueue.assign({ version, pair });
            } catch (cause) {
              enqueue.assign({ version });
              enqueue.emit({ type: "stage.error", message: getErrorText(cause) });
            }

            return;
          }

          const focus = getStepHighlight(context.guide, event.index, event.step);
          let fileOverride = context.fileOverride;

          try {
            const walked = resolveWalkedAtStep(event.walked, event.project);

            if (walked !== undefined) {
              enqueue({ type: "writeProject", params: walked });
              fileOverride = isEqual(event.walked.manifest.files, event.project.files)
                ? fileOverride
                : { version, files: event.project.files };
            }
          } catch (cause) {
            enqueue.emit({ type: "stage.error", message: getErrorText(cause) });
          }

          enqueue.assign({
            version,
            pair: undefined,
            fileOverride,
            highlight: focus === undefined ? context.highlight : { version, ...focus },
          });
        }),
      },
      "pair.edit": {
        actions: assign({ pair: ({ context, event }) => context.pair && { ...context.pair, project: event.project } }),
      },
    },
  });
}
