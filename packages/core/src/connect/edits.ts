import { uniq } from "es-toolkit";

import type { FileEditInput } from "./tools.ts";

/** One file an agent's edit changed: what it held before (absent for a new file) and after. */
export interface FileChange {
  path: string;
  before?: string;
  after: string;
  added: number;
  removed: number;
}

/** Why an agent's edits did not apply, with the index of the failing edit. */
export type FileEditFailure = {
  code: "not_found" | "ambiguous" | "missing_file" | "unchanged";
  message: string;
  index: number;
};

/** The result of `applyFileEdits`: the new files and what changed, or the first failure. */
export type FileEditResult =
  | { ok: true; files: Record<string, string>; changes: readonly FileChange[] }
  | { ok: false; error: FileEditFailure };

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** Above this many cells, line counts come from trimming the shared start and end only. */
const LCS_CELL_LIMIT = 4_000_000;

/**
 * Count lines added and removed between two texts
 *
 * Counts come from their longest common subsequence. Above `LCS_CELL_LIMIT` cells, every line between the shared
 * start and end counts as changed.
 */
export function countLineChanges(before: string, after: string): { added: number; removed: number } {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // Trim the shared start and end
  let start = 0;

  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }

  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;

  while (beforeEnd > start && afterEnd > start && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const beforeMiddle = beforeLines.slice(start, beforeEnd);
  const afterMiddle = afterLines.slice(start, afterEnd);

  if (beforeMiddle.length * afterMiddle.length > LCS_CELL_LIMIT) {
    return { added: afterMiddle.length, removed: beforeMiddle.length };
  }

  // Longest common subsequence, one row at a time
  let previousRow = Array.from({ length: afterMiddle.length + 1 }, () => 0);

  for (const beforeLine of beforeMiddle) {
    const currentRow = Array.from({ length: afterMiddle.length + 1 }, () => 0);

    for (let index = 1; index <= afterMiddle.length; index += 1) {
      currentRow[index] =
        beforeLine === afterMiddle[index - 1]
          ? (previousRow[index - 1] ?? 0) + 1
          : Math.max(previousRow[index] ?? 0, currentRow[index - 1] ?? 0);
    }

    previousRow = currentRow;
  }

  const commonCount = previousRow[afterMiddle.length] ?? 0;

  return { added: afterMiddle.length - commonCount, removed: beforeMiddle.length - commonCount };
}

// Overlapping matches count too: each is a place the edit could mean.
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = text.indexOf(search);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(search, index + 1);
  }

  return count;
}

/**
 * Apply an agent's file edits
 *
 * Applies edits in order to `files`, leaving it untouched. A replacement's `old_text` must match exactly once in
 * the file as earlier edits left it; a whole-file write may create a file. Nothing changes
 * unless every edit applies.
 */
export function applyFileEdits(
  files: Readonly<Record<string, string>>,
  edits: readonly FileEditInput[],
): FileEditResult {
  const editedFiles: Record<string, string> = { ...files };

  for (const [index, edit] of edits.entries()) {
    const currentText = Object.hasOwn(editedFiles, edit.path) ? editedFiles[edit.path] : undefined;

    if (edit.old_text === undefined) {
      // A plain assignment to "__proto__" would replace the prototype instead of adding a file.
      Object.defineProperty(editedFiles, edit.path, {
        value: edit.new_text,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }

    if (currentText === undefined) {
      return {
        ok: false,
        error: {
          code: "missing_file",
          index,
          message: `${edit.path} is not a file of this project.`,
        },
      };
    }

    const matchCount = edit.old_text === "" ? 0 : countOccurrences(currentText, edit.old_text);

    if (matchCount === 0) {
      return {
        ok: false,
        error: {
          code: "not_found",
          index,
          message: `old_text of edit ${index} is not in ${edit.path}. Read the file again and copy the text exactly.`,
        },
      };
    }

    if (matchCount > 1) {
      return {
        ok: false,
        error: {
          code: "ambiguous",
          index,
          message: `old_text of edit ${index} matches ${matchCount} places in ${edit.path}. Include more lines so it matches once.`,
        },
      };
    }

    editedFiles[edit.path] = currentText.replace(edit.old_text, () => edit.new_text);
  }

  const changes: FileChange[] = [];

  for (const path of uniq(edits.map((edit) => edit.path))) {
    const before = Object.hasOwn(files, path) ? files[path] : undefined;
    const after = (Object.hasOwn(editedFiles, path) ? editedFiles[path] : undefined) ?? "";

    if (before === after) {
      continue;
    }

    changes.push({
      path,
      ...(before === undefined ? {} : { before }),
      after,
      ...countLineChanges(before ?? "", after),
    });
  }

  if (changes.length === 0) {
    return {
      ok: false,
      error: {
        code: "unchanged",
        index: 0,
        message: "These edits leave every file as it is.",
      },
    };
  }

  return { ok: true, files: editedFiles, changes };
}
