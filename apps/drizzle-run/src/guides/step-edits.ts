import { isPairProject, projectFiles, resolveStep, type GuideManifest } from "@drizzle-run/core/guide";
import { isSharedPairFile, PAIR_SIDES, type PairSideIndex } from "@drizzle-run/core/pair";

import { diffLines, getChangedLines, type NumberedLine } from "../lib/line-diff";

/** One file a step changes: its changed lines, and the side whose copy changes when the file has one per side. */
export interface StepEdit {
  file: string;
  side?: PairSideIndex;
  lines: NumberedLine[];
}

function diffFiles(before: Readonly<Record<string, string>>, files: Readonly<Record<string, string>>) {
  return Object.keys(files)
    .filter((file) => before[file] !== files[file])
    .map((file) => ({ file, lines: getChangedLines(diffLines(before[file] ?? "", files[file])) }));
}

/**
 * The changed lines of each file guide step `index` edits, before and after its edits
 *
 * A side-by-side step lists a shared file once and a per-side file per side. A step that splits compares both sides
 * with the one version before it; a step that merges compares with the side it keeps.
 */
export function getStepEdits(guide: GuideManifest, index: number): StepEdit[] {
  const { step, previous, project } = resolveStep(guide, index);

  if (!isPairProject(project)) {
    return diffFiles(projectFiles(previous, step.merge?.keep), project.files);
  }

  return PAIR_SIDES.flatMap((side) =>
    diffFiles(projectFiles(previous, side), projectFiles(project, side)).flatMap((edit) => {
      if (!isSharedPairFile(project, edit.file)) {
        return [{ ...edit, side }];
      }

      return side === 0 ? [edit] : [];
    }),
  );
}
