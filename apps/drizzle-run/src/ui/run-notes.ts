import type { RunResult, RunTransaction } from "@drizzle-run/core/contracts";

import { diffLines } from "../lib/line-diff";
import { countDataStatements, countKeptWrites, getTransactionChildren, type TransactionChildren } from "./transactions";

/** A chip's colors: ok for what was kept, err for what rolled back, plain for a hint. */
export type RunNoteTone = "ok" | "err" | "plain";

/** One note the editor draws from a run or a guide step, on a line of a file. Lines are 1-based. */
export type RunNote =
  /** A chip after the line on desktop, under it on phones, such as "committed · 4 queries". */
  | {
      kind: "chip";
      path: string;
      line: number;
      text: string;
      /** Said after the text on desktop only, such as "9 ms". */
      detail?: string;
      tone: RunNoteTone;
    }
  /** Lines a guide step takes out, drawn struck through where they were, before the step runs. */
  | {
      kind: "removed";
      path: string;
      /** The line they follow in the file as it is now; 0 for the top. */
      afterLine: number;
      /** Their number in the file before the step. */
      firstLine: number;
      lines: readonly string[];
      label: string;
    }
  /** Where a step took lines out, once it ran: "step 2 removed the throw". */
  | { kind: "separator"; path: string; afterLine: number; label: string };

/** What a guide step tells the editor beyond its edits, from the step's app meta. */
export interface StepNoteMeta {
  /** What the step's edit takes out, for "step 2 removed the throw". */
  removed?: string;
  /** Chips on lines before the step runs, found by the first line holding `match`. */
  lineNotes?: readonly { file: string; match: string; text: string }[];
}

function pluralize(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function getTransactionChip(
  transaction: RunTransaction,
  children: TransactionChildren,
  guided: boolean,
): Pick<Extract<RunNote, { kind: "chip" }>, "text" | "detail" | "tone"> {
  if (transaction.parent !== undefined) {
    return transaction.outcome === "committed"
      ? { text: "savepoint released", tone: "ok" }
      : { text: "savepoint rolled back", tone: "err" };
  }

  if (transaction.outcome === "rolled_back") {
    return { text: "rolled back · nothing kept", tone: "err" };
  }

  if (guided) {
    const kept = countKeptWrites(transaction, children);

    return { text: kept === 0 ? "committed" : `committed · ${pluralize(kept, "write")} kept`, tone: "ok" };
  }

  const queries = countDataStatements(transaction, children);

  return {
    text: `committed · ${queries} ${queries === 1 ? "query" : "queries"}`,
    detail: `${Math.round(transaction.durationMs)} ms`,
    tone: "ok",
  };
}

/** The first note per line wins, so a transaction in a loop gets one chip, not one per pass. */
function keepFirstPerLine<Note extends { path: string; line: number }>(notes: readonly Note[]): Note[] {
  const seen = new Set<string>();

  return notes.filter((note) => {
    const key = `${note.path}:${note.line}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/**
 * The notes a run leaves in the code
 *
 * A chip on each line that opened a transaction or savepoint, saying how it ended. A guide's commit chip says how
 * many writes it kept instead of how many queries it ran. Only the run phase's transactions with a known line get a
 * chip; console output and `$.display` results stay in the Logs and Results tabs.
 */
export function getRunNotes(
  result: Pick<RunResult, "transactions">,
  { guided = false }: { guided?: boolean } = {},
): RunNote[] {
  const transactions = (result.transactions ?? []).filter((transaction) => transaction.phase === "run");
  const children = getTransactionChildren(transactions);
  const chips = transactions.flatMap((transaction): Extract<RunNote, { kind: "chip" }>[] =>
    transaction.source === undefined || transaction.line === undefined
      ? []
      : [
          {
            kind: "chip",
            path: transaction.source,
            line: transaction.line,
            ...getTransactionChip(transaction, children, guided),
          },
        ],
  );

  return keepFirstPerLine(chips);
}

/** The runs of lines a change takes out with nothing put in their place, with where they were. */
function findRemovals(before: string, after: string) {
  const removals: { afterLine: number; firstLine: number; lines: string[] }[] = [];
  let hunk: { afterLine: number; firstLine: number; lines: string[]; added: boolean } | undefined;
  let oldLine = 0;
  let newLine = 0;

  const closeHunk = () => {
    if (hunk && !hunk.added && hunk.lines.length > 0) {
      removals.push({ afterLine: hunk.afterLine, firstLine: hunk.firstLine, lines: hunk.lines });
    }

    hunk = undefined;
  };

  for (const entry of diffLines(before, after)) {
    if (entry.kind === "same") {
      closeHunk();
      oldLine += 1;
      newLine += 1;
      continue;
    }

    hunk ??= { afterLine: newLine, firstLine: oldLine + 1, lines: [], added: false };

    if (entry.kind === "removed") {
      oldLine += 1;
      hunk.lines.push(entry.text);
    } else {
      newLine += 1;
      hunk.added = true;
    }
  }

  closeHunk();

  return removals;
}

/**
 * The notes a guide step leaves in the code
 *
 * Before the step runs, the lines its edit took out show struck through where they were ("removed when you run step
 * 2"), and its meta's line notes show as plain chips. Once it ran, a line marks where they were ("step 2 removed the
 * throw"). Lines the step only adds are left to the step's highlight.
 */
export function getStepNotes({
  before,
  after,
  index,
  ran,
  meta = {},
}: {
  before: Readonly<Record<string, string>>;
  after: Readonly<Record<string, string>>;
  /** The 0-based step. */
  index: number;
  /** The step ran, so its edits are in the run the output shows. */
  ran: boolean;
  meta?: StepNoteMeta;
}): RunNote[] {
  const step = index + 1;
  const notes: RunNote[] = [];

  for (const path of Object.keys(after).toSorted()) {
    const previous = before[path];
    const current = after[path];

    if (previous === undefined || current === undefined || previous === current) {
      continue;
    }

    for (const removal of findRemovals(previous, current)) {
      const what = meta.removed ?? (removal.lines.length === 1 ? "a line" : `${removal.lines.length} lines`);

      notes.push(
        ran
          ? { kind: "separator", path, afterLine: removal.afterLine, label: `step ${step} removed ${what}` }
          : { kind: "removed", path, ...removal, label: `removed when you run step ${step}` },
      );
    }
  }

  if (ran) {
    return notes;
  }

  for (const note of meta.lineNotes ?? []) {
    const line = (after[note.file] ?? "").split("\n").findIndex((text) => text.includes(note.match));

    if (line !== -1) {
      notes.push({ kind: "chip", path: note.file, line: line + 1, text: note.text, tone: "plain" });
    }
  }

  return notes;
}
