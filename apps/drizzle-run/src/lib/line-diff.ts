/** One line of a line diff: kept, added, or removed. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** A line diff by longest common subsequence. Guide files are short, so the table stays small. */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const common = Array.from({ length: left.length + 1 }, () => Array.from({ length: right.length + 1 }, () => 0));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      common[i][j] = left[i] === right[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  // On a tie, removals come first, so a replaced line reads "- old" then "+ new".
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || common[i][j + 1] > common[i + 1][j])) {
      lines.push({ kind: "added", text: right[j] });
      j += 1;
    } else {
      lines.push({ kind: "removed", text: left[i] });
      i += 1;
    }
  }

  return lines;
}

/** The 1-based line ranges of `after` that the diff adds. */
export function getAddedRanges(lines: readonly DiffLine[]): { startLine: number; endLine: number }[] {
  const ranges: { startLine: number; endLine: number }[] = [];
  let line = 0;

  for (const entry of lines) {
    if (entry.kind === "removed") {
      continue;
    }

    line += 1;

    if (entry.kind === "added") {
      const last = ranges.at(-1);

      if (last && last.endLine === line - 1) {
        last.endLine = line;
      } else {
        ranges.push({ startLine: line, endLine: line });
      }
    }
  }

  return ranges;
}

/** A changed line with its number. */
export interface NumberedLine {
  kind: "added" | "removed";
  /** 1-based: in the old file for a removed line, in the new file for an added one. */
  line: number;
  text: string;
}

/** Only the changed lines, each with its line number. */
export function getChangedLines(lines: readonly DiffLine[]): NumberedLine[] {
  const changed: NumberedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const entry of lines) {
    if (entry.kind !== "added") {
      oldLine += 1;
    }

    if (entry.kind !== "removed") {
      newLine += 1;
    }

    if (entry.kind !== "same") {
      changed.push({ kind: entry.kind, line: entry.kind === "added" ? newLine : oldLine, text: entry.text });
    }
  }

  return changed;
}
