import { uniq } from "es-toolkit";

import type { RunResult } from "../contracts/runtime.ts";
import type { SerializedValue } from "../contracts/serialization.ts";
import { getDisplayRows, toComparable } from "../shared/display-rows.ts";

/** The parts of a run that "what changed" reads. */
export type DiffedResult = Pick<RunResult, "displays">;

/** A row matched by `id` across two runs whose other fields differ. */
export interface ChangedRow {
  before: SerializedValue;
  after: SerializedValue;
}

/** What changed in one display between two runs. */
export interface DisplayChange {
  label: string;
  /** `added` and `removed` describe the whole display; `changed` and `same` compare its rows. */
  status: "added" | "removed" | "changed" | "same";
  added: readonly SerializedValue[];
  removed: readonly SerializedValue[];
  /** Rows matched by their `id` field whose other fields differ. */
  changed: readonly ChangedRow[];
  unchanged: number;
}

/** What changed between two runs, per display. */
export interface RunResultDiff {
  /** In the order of the current run, then displays the current run no longer shows. */
  displays: readonly DisplayChange[];
  changed: boolean;
}

function toComparableJson(value: SerializedValue): string {
  return JSON.stringify(toComparable(value));
}

/** The last display with this label, as rows; undefined when there is no run or it shows none. */
function getResultRows(result: DiffedResult | undefined, label: string): readonly SerializedValue[] | undefined {
  return result === undefined ? undefined : getDisplayRows(result.displays, label);
}

/** Rows keyed by a primitive `id` field, when every row has a distinct one. */
function getRowsById(rows: readonly SerializedValue[]): Map<string, SerializedValue> | undefined {
  const rowsById = new Map<string, SerializedValue>();

  for (const row of rows) {
    const id = row.type === "object" ? row.value.id : undefined;

    if (id?.type !== "primitive" && id?.type !== "bigint") {
      return undefined;
    }

    const idKey = toComparableJson(id);

    if (rowsById.has(idKey)) {
      return undefined;
    }

    rowsById.set(idKey, row);
  }

  return rowsById;
}

/** Removes the first equal row for each `rowsToRemove` row; returns what is left of `rows`. */
function removeRows(rows: readonly SerializedValue[], rowsToRemove: readonly SerializedValue[]): SerializedValue[] {
  const removalCounts = new Map<string, number>();

  for (const row of rowsToRemove) {
    const rowKey = toComparableJson(row);

    removalCounts.set(rowKey, (removalCounts.get(rowKey) ?? 0) + 1);
  }

  const remainingRows: SerializedValue[] = [];

  for (const row of rows) {
    const rowKey = toComparableJson(row);
    const removalCount = removalCounts.get(rowKey) ?? 0;

    if (removalCount === 0) {
      remainingRows.push(row);
      continue;
    }

    removalCounts.set(rowKey, removalCount - 1);
  }

  return remainingRows;
}

function compareRows(
  label: string,
  previousRows: readonly SerializedValue[],
  currentRows: readonly SerializedValue[],
): DisplayChange {
  const previousRowsById = getRowsById(previousRows);
  const currentRowsById = getRowsById(currentRows);

  // Match rows by id when both runs give every row a distinct one
  if (previousRowsById && currentRowsById) {
    const added = [...currentRowsById].filter(([idKey]) => !previousRowsById.has(idKey)).map(([, row]) => row);
    const removed = [...previousRowsById].filter(([idKey]) => !currentRowsById.has(idKey)).map(([, row]) => row);
    const changed: ChangedRow[] = [];
    let unchanged = 0;

    for (const [idKey, row] of currentRowsById) {
      const previousRow = previousRowsById.get(idKey);

      if (previousRow === undefined) {
        continue;
      }

      if (toComparableJson(previousRow) === toComparableJson(row)) {
        unchanged += 1;
      } else {
        changed.push({ before: previousRow, after: row });
      }
    }

    const status = added.length + removed.length + changed.length > 0 ? "changed" : "same";

    return { label, status, added, removed, changed, unchanged };
  }

  // Otherwise compare rows as values
  const added = removeRows(currentRows, previousRows);
  const removed = removeRows(previousRows, currentRows);
  const status = added.length + removed.length > 0 ? "changed" : "same";

  return {
    label,
    status,
    added,
    removed,
    changed: [],
    unchanged: currentRows.length - added.length,
  };
}

/**
 * Diff two runs' displays
 *
 * Reports what changed per display label: rows added, removed, and changed.
 * Rows with a distinct `id` are matched by it; other rows are compared as values.
 * With no previous run, every display counts as added.
 */
export function diffRunResults(previous: DiffedResult | undefined, current: DiffedResult): RunResultDiff {
  const currentLabels = uniq(current.displays.map((display) => display.label));
  const removedLabels = uniq((previous?.displays ?? []).map((display) => display.label)).filter(
    (label) => !currentLabels.includes(label),
  );
  const displays: DisplayChange[] = [];

  for (const label of currentLabels) {
    const currentRows = getResultRows(current, label) ?? [];
    const previousRows = getResultRows(previous, label);

    displays.push(
      previousRows === undefined
        ? { label, status: "added", added: currentRows, removed: [], changed: [], unchanged: 0 }
        : compareRows(label, previousRows, currentRows),
    );
  }

  for (const label of removedLabels) {
    displays.push({
      label,
      status: "removed",
      added: [],
      removed: getResultRows(previous, label) ?? [],
      changed: [],
      unchanged: 0,
    });
  }

  return { displays, changed: displays.some((display) => display.status !== "same") };
}
