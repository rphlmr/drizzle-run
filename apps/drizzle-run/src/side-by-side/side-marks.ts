import { isPairProject, projectFiles, resolveStep, type GuideManifest, type GuideStep } from "@drizzle-run/core/guide";
import { isSharedPairFile, type PairSideIndex } from "@drizzle-run/core/pair";

import { diffLines, getAddedRanges } from "../lib/line-diff";

/** The file one side's editor opens at a step, and the lines it marks there. */
export interface SideMark {
  file: string;
  /** Without lines, the side opens the file and marks nothing. */
  lines?: readonly [startLine: number, endLine: number];
}

/**
 * Where a side's editor points at a step. Both sides open the step's focus file when they have it, so a step that
 * compares two ways to write one file shows them next to each other; without a focus, a side opens the first file
 * the step changes on it. A side marks the lines the step adds to that file, else the focus lines, unless the focus
 * names the other side's own copy of the file. A step that splits compares each side with the one version before it.
 */
export function getSideMark(
  guide: GuideManifest,
  index: number,
  step: GuideStep,
  side: PairSideIndex,
): SideMark | undefined {
  const { previous, project } = resolveStep(guide, index);
  const before = projectFiles(previous, side);
  const files = projectFiles(project, side);
  const focus = step.focus && Object.hasOwn(files, step.focus.file) ? step.focus : undefined;
  const file = focus?.file ?? Object.keys(files).find((path) => before[path] !== files[path]);

  if (file === undefined) {
    return undefined;
  }

  const added = getAddedRanges(diffLines(before[file] ?? "", files[file] ?? ""))[0];

  if (added !== undefined) {
    return { file, lines: [added.startLine, added.endLine] };
  }

  const marked =
    focus !== undefined &&
    (focus.side === undefined || focus.side === side || (isPairProject(project) && isSharedPairFile(project, file)));

  return marked ? { file, lines: focus.lines } : { file };
}
