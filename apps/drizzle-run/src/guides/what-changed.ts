import type { SerializedValue } from "@drizzle-run/core/contracts";
import {
  isPairProject,
  resolveStep,
  type DisplayChange,
  type GuideManifest,
  type RunResultDiff,
} from "@drizzle-run/core/guide";
import { pairSideLabels } from "@drizzle-run/core/pair";
import type { GuideComparison } from "@drizzle-run/runtime/machines";
import { uniq } from "es-toolkit";

/**
 * Name the run a step's result is compared with, for `describeChanges`
 *
 * "the last run" when it ran at the same step, else its step, with the side it kept after a merge, such as
 * "step 4 (SQL-like)".
 */
export function describeComparedRun(guide: GuideManifest, since: GuideComparison, index: number): string {
  if (since.step === index) {
    return "the last run";
  }

  const { project } = resolveStep(guide, since.step);
  const side = since.side !== undefined && isPairProject(project) ? pairSideLabels(project)[since.side] : undefined;

  return `step ${since.step + 1}${side === undefined ? "" : ` (${side})`}`;
}

function formatRowCount(count: number) {
  return count === 1 ? "1 row" : `${count} rows`;
}

/** One display in a sentence, compared with the run named by `since` ("step 1"). */
export function describeDisplay(change: DisplayChange, since: string): string {
  switch (change.status) {
    case "added":
      return `${change.label} is new.`;
    case "removed":
      return `${change.label}: removed since ${since}.`;
    case "same":
      return `${change.label}: unchanged since ${since}.`;
    case "changed": {
      const parts = [
        change.changed.length > 0 ? `${formatRowCount(change.changed.length)} changed` : undefined,
        change.added.length > 0 ? `${formatRowCount(change.added.length)} added` : undefined,
        change.removed.length > 0 ? `${formatRowCount(change.removed.length)} removed` : undefined,
        change.unchanged > 0 ? `${change.unchanged} unchanged` : undefined,
      ].filter((part) => part !== undefined);

      return `${change.label}: ${parts.join(", ")}.`;
    }
  }
}

/** The output's "what changed" note: every display, or one line when nothing changed. */
export function describeChanges(diff: RunResultDiff, since: string): string {
  if (!diff.changed) {
    return `No changes since ${since}.`;
  }

  return diff.displays.map((change) => describeDisplay(change, since)).join(" ");
}

/** A short text form of a cell value, such as `80` or `Ada`. */
export function formatValueText(value: SerializedValue | undefined): string {
  switch (value?.type) {
    case undefined:
    case "undefined":
      return "undefined";
    case "primitive":
      return value.value === null ? "null" : String(value.value);
    case "bigint":
    case "date":
      return value.value;
    case "array":
      return `[${value.value.length}]`;
    case "object":
      return "{…}";
    case "unsupported":
      return value.valueType;
    case "circular":
      return "↻";
  }
}

/** One cell that changed between two runs, in a row matched by `id`. */
export interface FieldChange {
  label: string;
  /** The row's `id`, which matched the two runs' rows. */
  row: string;
  field: string;
  before: string;
  after: string;
}

/** Each changed cell of rows matched by `id`, in display order. */
export function listFieldChanges(diff: RunResultDiff): FieldChange[] {
  return diff.displays.flatMap((change) =>
    change.changed.flatMap(({ before, after }) => {
      if (before.type !== "object" || after.type !== "object") {
        return [];
      }

      const fields = uniq([...Object.keys(before.value), ...Object.keys(after.value)]);

      return fields
        .filter((field) => formatValueText(before.value[field]) !== formatValueText(after.value[field]))
        .map((field) => ({
          label: change.label,
          row: formatValueText(after.value.id),
          field,
          before: formatValueText(before.value[field]),
          after: formatValueText(after.value[field]),
        }));
    }),
  );
}
