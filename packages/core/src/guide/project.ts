import { omit, pick } from "es-toolkit";

import type { RunManifest } from "../manifest/types.ts";
import { pairSide } from "../pair/operations.ts";
import { PAIR_SEED_PATH, toRenamedSeedMessage } from "../pair/schema.ts";
import {
  PAIR_MANIFEST_KIND,
  PAIR_MANIFEST_VERSION,
  type PairManifest,
  type PairSide,
  type PairSideIndex,
} from "../pair/types.ts";
import {
  applyEdits,
  GuideEditError,
  type GuideEdit,
  type GuideMerge,
  type GuideSplit,
  type GuideSplitSide,
} from "../shared/models.ts";

/** What a guide walks through: a one-version project, or a side-by-side one. */
export type GuideProject = RunManifest | PairManifest;

/** Check whether a guide project is side by side. */
export function isPairProject(project: GuideProject): project is PairManifest {
  return project.kind === PAIR_MANIFEST_KIND;
}

/**
 * Get the files one side runs
 *
 * A one-version project has a single side, 0, and ignores `side`.
 */
export function projectFiles(project: GuideProject, side: PairSideIndex = 0): Readonly<Record<string, string>> {
  return isPairProject(project) ? pairSide(project, side).files : project.files;
}

/** One edit on one file set, reported at its index in the step. */
function applyOneEdit(files: Readonly<Record<string, string>>, edit: GuideEdit, index: number): Record<string, string> {
  try {
    return applyEdits(files, [edit]);
  } catch (cause) {
    if (cause instanceof GuideEditError) {
      throw new GuideEditError(index, cause.file, cause.reason);
    }

    throw cause;
  }
}

function applyPairEdits(project: PairManifest, edits: readonly GuideEdit[]): PairManifest {
  let sharedFiles = project.files;
  let sideFiles: [Readonly<Record<string, string>>, Readonly<Record<string, string>>] = [
    project.sides[0].files,
    project.sides[1].files,
  ];

  for (const [index, edit] of edits.entries()) {
    const isPerSideFile = Object.hasOwn(sideFiles[0], edit.file) || Object.hasOwn(sideFiles[1], edit.file);

    if (edit.side === undefined) {
      if (isPerSideFile) {
        throw new GuideEditError(index, edit.file, "SIDE_REQUIRED");
      }

      sharedFiles = applyOneEdit(sharedFiles, edit, index);
      continue;
    }

    if (Object.hasOwn(sharedFiles, edit.file)) {
      throw new GuideEditError(index, edit.file, "NOT_PER_SIDE");
    }

    const editedSideFiles = applyOneEdit(sideFiles[edit.side], edit, index);

    sideFiles = edit.side === 0 ? [editedSideFiles, sideFiles[1]] : [sideFiles[0], editedSideFiles];
  }

  return {
    ...project,
    files: { ...sharedFiles },
    sides: [
      { ...project.sides[0], files: { ...sideFiles[0] } },
      { ...project.sides[1], files: { ...sideFiles[1] } },
    ],
  };
}

/**
 * Apply a step's edits to a guide project
 *
 * A shared file takes edits without a side; a per-side file takes edits naming the side whose copy changes. Throws
 * `GuideEditError` on the first edit that does not apply. The result is the same kind of project, with every other
 * field kept.
 */
export function applyProjectEdits<TProject extends GuideProject>(
  project: TProject,
  edits: readonly GuideEdit[],
): TProject;
export function applyProjectEdits(project: GuideProject, edits: readonly GuideEdit[]): GuideProject {
  if (isPairProject(project)) {
    return applyPairEdits(project, edits);
  }

  const sidedEditIndex = edits.findIndex((edit) => edit.side !== undefined);

  if (sidedEditIndex !== -1) {
    throw new GuideEditError(sidedEditIndex, edits[sidedEditIndex]?.file ?? "", "NOT_PER_SIDE");
  }

  return { ...project, files: applyEdits(project.files, edits) };
}

/** How a step changes the project's shape, before its edits. */
export interface GuideShapeChange {
  readonly split?: GuideSplit;
  readonly merge?: GuideMerge;
}

/** Why a split or merge does not apply. */
export type GuideShapeFailure =
  | "SPLIT_NOT_ONE_VERSION"
  | "MERGE_NOT_PAIR"
  | "SPLIT_AND_MERGE"
  | "MISSING_FILE"
  | "SEED_FILE"
  | "RENAMED_SEED";

/** Thrown when a step's split or merge does not apply to the project before it. */
export class GuideShapeError extends Error {
  readonly reason: GuideShapeFailure;
  /** The file at fault: the split file for a missing or seed file, the project's seed for a renamed seed. */
  readonly file: string | undefined;

  constructor(reason: GuideShapeFailure, file?: string) {
    const messages: Record<GuideShapeFailure, string> = {
      SPLIT_NOT_ONE_VERSION: "The project is already side by side, so this step cannot split it.",
      MERGE_NOT_PAIR: "The project has one version, so this step has no sides to merge.",
      SPLIT_AND_MERGE: "A step splits or merges the project, not both.",
      MISSING_FILE: `${file} does not exist when this step splits the project.`,
      SEED_FILE: `${file} is the seed file both sides share, on or off, so it stays shared.`,
      RENAMED_SEED: toRenamedSeedMessage(file ?? ""),
    };

    super(messages[reason]);
    this.name = "GuideShapeError";
    this.reason = reason;
    this.file = file;
  }
}

function toSplitSide(project: RunManifest, split: GuideSplitSide, files: Record<string, string>): PairSide {
  const guestFlavor = split.guestFlavor ?? project.guestFlavor;

  return {
    ...(split.name === undefined ? {} : { name: split.name }),
    target: split.target ?? project.target,
    dependencies: split.dependencies ?? project.dependencies,
    ...(guestFlavor === undefined ? {} : { guestFlavor }),
    files,
  };
}

function splitProject(project: RunManifest, split: GuideSplit): PairManifest {
  const seedPath = project.entrypoints.seed;

  // Refused rather than moved, as `createPairManifest` does: a moved seed's relative imports would change meaning.
  if (seedPath !== undefined && seedPath !== PAIR_SEED_PATH) {
    throw new GuideShapeError("RENAMED_SEED", seedPath);
  }

  for (const file of split.files) {
    if (!Object.hasOwn(project.files, file)) {
      throw new GuideShapeError("MISSING_FILE", file);
    }

    // Shared even while the seed is off, so turning it back on finds one copy.
    if (file === PAIR_SEED_PATH) {
      throw new GuideShapeError("SEED_FILE", file);
    }
  }

  const sideFiles = pick(project.files, [...split.files]);

  // Built as is, not through createPairManifest, which throws: validation reports a bad side as an issue at the split.
  return {
    kind: PAIR_MANIFEST_KIND,
    manifestVersion: PAIR_MANIFEST_VERSION,
    entrypoints: project.entrypoints,
    files: omit(project.files, [...split.files]),
    sides: [
      toSplitSide(project, split.sides[0], { ...sideFiles }),
      toSplitSide(project, split.sides[1], { ...sideFiles }),
    ],
    ...(project.env === undefined ? {} : { env: project.env }),
    ...(project.randomSeed === undefined ? {} : { randomSeed: project.randomSeed }),
    ...(project.seedGeneratorVersion === undefined ? {} : { seedGeneratorVersion: project.seedGeneratorVersion }),
  };
}

/**
 * Apply a step's shape change to a guide project
 *
 * `split` opens two sides from a one-version project; `merge` keeps one side of a side-by-side project as one
 * version, which is `pairSide`: a cross-line pair's drizzle-seed pin stays, so the one version seeds the rows its
 * side seeded. Without either, the project is returned as it is. Throws `GuideShapeError` when the change does not
 * fit the project. The result is not validated: the step's edits apply first.
 */
export function applyProjectShape(project: GuideProject, change: GuideShapeChange): GuideProject {
  if (change.split !== undefined && change.merge !== undefined) {
    throw new GuideShapeError("SPLIT_AND_MERGE");
  }

  if (change.split !== undefined) {
    if (isPairProject(project)) {
      throw new GuideShapeError("SPLIT_NOT_ONE_VERSION");
    }

    return splitProject(project, change.split);
  }

  if (change.merge !== undefined) {
    if (!isPairProject(project)) {
      throw new GuideShapeError("MERGE_NOT_PAIR");
    }

    return pairSide(project, change.merge.keep);
  }

  return project;
}
