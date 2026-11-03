import type {
  ConfirmedIndex,
  PlannedQuery,
  QueryPlanReading,
  QueryPlanSize,
  QueryPlansReport,
  QueryPlansSettings,
  RawQueryPlan,
} from "@drizzle-run/core/contracts";
import {
  formatRows,
  planGrowth,
  planSteps,
  SQLITE_TIMING_FLOOR_MS,
  type PlanStep,
} from "@drizzle-run/runtime/query-plans";

/** The Query plans flag of a project tab: off by default and when the user leaves the project, like Debug. */
export interface QueryPlansFlag {
  on: boolean;
  size: QueryPlanSize;
  measureRealTime: boolean;
}

/** Planning starts disabled and uses estimated costs at 1M rows when enabled. */
export const QUERY_PLANS_OFF: QueryPlansFlag = { on: false, size: "1m", measureRealTime: false };

/** What a run submits: nothing while the flag is off. */
export function toQueryPlansSettings(flag: QueryPlansFlag): QueryPlansSettings | undefined {
  return flag.on ? { size: flag.size, measureRealTime: flag.measureRealTime } : undefined;
}

/** "Seed data", "10k rows", "100k rows", "1M rows": the size control's options. */
export const sizeLabels: Record<QueryPlanSize, string> = {
  seed: "Seed data",
  "10k": "10k rows",
  "100k": "100k rows",
  "1m": "1M rows",
};

/** "seed", "10k", "1M": the switch label and the size pills. */
export const sizeShortLabels: Record<QueryPlanSize, string> = {
  seed: "seed",
  "10k": "10k",
  "100k": "100k",
  "1m": "1M",
};

/** "Plans at 1M rows", the phone Logs filter row's hint for a planned run. */
export function getPlansChipLabel(size: QueryPlanSize): string {
  return size === "seed" ? "Plans at seed data" : `Plans at ${sizeLabels[size]}`;
}

/** Explain the table size used for a planned run in the Logs filter row. */
export function getPlansHintLabel(size: QueryPlanSize): string {
  return size === "seed" ? "Plans at seed data" : `Plans as if tables held ${sizeLabels[size]}`;
}

/**
 * The flag is on but the shown run was planned differently (or not at all), so the Logs tab asks for a run.
 * Turning the flag on never runs anything by itself.
 */
export function needsPlannedRun(flag: QueryPlansSettings | undefined, run: QueryPlansSettings | undefined): boolean {
  if (flag === undefined) {
    return false;
  }

  return run === undefined || run.size !== flag.size || run.measureRealTime !== flag.measureRealTime;
}

/** "Stays fast", "Grows with posts", "Grows with both", "Grows with 3 tables". */
export function getVerdictLabel(verdict: QueryPlanReading["verdict"]): string {
  if (verdict.kind === "stays_fast") {
    return "Stays fast";
  }

  const [first] = verdict.tables;

  if (verdict.tables.length === 1 && first !== undefined) {
    return `Grows with ${first}`;
  }

  return verdict.tables.length === 2 ? "Grows with both" : `Grows with ${verdict.tables.length} tables`;
}

/** What the Logs tab says of a planned run: how many queries grow, or that every one stays fast. */
export type PlansTabMark = { kind: "grows"; queries: number } | { kind: "stays_fast" };

/**
 * The Logs tab's mark for a planned run, so the plans are found from any tab
 *
 * Undefined when no query got a reading (all skipped or failed), since there is no verdict to show.
 */
export function getPlansTabMark(report: QueryPlansReport): PlansTabMark | undefined {
  const verdicts = report.queries.flatMap((query) => (query.reading === undefined ? [] : [query.reading.verdict]));

  if (verdicts.length === 0) {
    return undefined;
  }

  const growing = verdicts.filter((verdict) => verdict.kind === "grows").length;

  return growing > 0 ? { kind: "grows", queries: growing } : { kind: "stays_fast" };
}

/** "1 grows", "2 grow": the mark's words, never color alone. */
export function getPlansTabMarkLabel(mark: PlansTabMark): string {
  if (mark.kind === "stays_fast") {
    return "Plans stay fast";
  }

  return mark.queries === 1 ? "1 grows" : `${mark.queries} grow`;
}

function trim(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/** Postgres cost units: "18,870" from 100 up, "43", "8.87" under 10. */
export function formatCost(cost: number): string {
  if (cost >= 10) {
    return Math.round(cost).toLocaleString("en-US");
  }

  return trim(cost, 2);
}

/** Measured time: "1.4 s", "59 ms", "2.2 ms", "0.27 ms". */
export function formatPlanTime(ms: number): string {
  if (ms >= 1000) {
    return `${trim(ms / 1000, 1)} s`;
  }

  if (ms >= 10) {
    return `${Math.round(ms)} ms`;
  }

  return ms >= 1 ? `${trim(ms, 1)} ms` : `${Number(ms.toPrecision(2))} ms`;
}

/** Formats a plan measure in its unit, as Postgres cost or measured time. */
export function formatMeasure(value: number, unit: "cost" | "ms"): string {
  return unit === "cost" ? formatCost(value) : formatPlanTime(value);
}

/** What the Logs tab shows for one run-phase statement: its planned query, or why it was not planned. */
export type QueryPlanEntry = { kind: "planned"; query: PlannedQuery } | { kind: "skipped"; reason: string };

/** Each run-phase `SqlEvent.sequence` and the plan it got. */
export function getPlanEntries(report: QueryPlansReport): Map<number, QueryPlanEntry> {
  const entries = new Map<number, QueryPlanEntry>();

  for (const query of report.queries) {
    for (const sequence of query.sequences) {
      entries.set(sequence, { kind: "planned", query });
    }
  }

  for (const skipped of report.skipped) {
    for (const sequence of skipped.sequences) {
      entries.set(sequence, { kind: "skipped", reason: skipped.reason });
    }
  }

  return entries;
}

/** The chosen size's raw output: the reading, the steps and Copy EXPLAIN all come from it. */
export function getChosenRaw(query: Pick<PlannedQuery, "raw">): RawQueryPlan | undefined {
  return query.raw.at(-1);
}

/** The steps of the chosen size, or none when the database output cannot be read. */
export function getChosenSteps(query: Pick<PlannedQuery, "raw">): PlanStep[] {
  const raw = getChosenRaw(query);

  if (raw === undefined) {
    return [];
  }

  try {
    return planSteps(raw);
  } catch {
    return [];
  }
}

/** One planned size and its measure, for the growth row. */
export interface GrowthPoint {
  size: QueryPlanSize;
  label: string;
  value: string;
  chosen: boolean;
}

/** "Total cost" (Postgres) or "Time" (SQLite) at each planned size, the chosen one last. */
export function getGrowthRow(query: Pick<PlannedQuery, "raw">): { label: string; points: GrowthPoint[] } {
  let growth: ReturnType<typeof planGrowth> = [];

  try {
    growth = planGrowth(query);
  } catch {
    growth = [];
  }

  const unit = growth[0]?.unit ?? "cost";

  return {
    label: unit === "cost" ? "Total cost" : "Time",
    points: growth.map((point, index) => ({
      size: point.size,
      label: sizeShortLabels[point.size],
      value: point.value === undefined ? "n/a" : formatMeasure(point.value, point.unit),
      chosen: index === growth.length - 1,
    })),
  };
}

/** The database's output as it came, for Copy EXPLAIN: never Drizzle Run's reading. */
export function getExplainText(raw: RawQueryPlan): string {
  if (raw.database === "postgresql") {
    const analyze =
      raw.analyze !== undefined && "text" in raw.analyze ? `\n\nEXPLAIN ANALYZE\n${raw.analyze.text}` : "";

    return `${raw.text}${analyze}`;
  }

  return [
    "id\tparent\tnotused\tdetail",
    ...raw.rows.map((row) => `${row.id}\t${row.parent}\t${row.notused}\t${row.detail}`),
  ].join("\n");
}

/** "posts.author_id" or "posts (author_id, created_at)": what the index covers. */
export function describeIndexTarget(index: Pick<ConfirmedIndex, "table" | "columns">): string {
  return index.columns.length === 1
    ? `${index.table}.${index.columns[0]}`
    : `${index.table} (${index.columns.join(", ")})`;
}

const triggerReasons: Record<ConfirmedIndex["trigger"], (schemaFile: string) => string> = {
  filtered_scan: (file) => `The filter column has no index in ${file}`,
  foreign_key_join: (file) => `The join column is a foreign key with no index in ${file}`,
  sorted_limit: () => "The query sorts the whole table to keep a few rows",
};

const indexConfirmations: Record<QueryPlansReport["dialect"], string> = {
  postgresql: "so Drizzle Run added one to the filled tables and asked Postgres to plan again. Postgres would use it.",
  sqlite: "so Drizzle Run added one to the filled tables and timed the query again. SQLite would use it",
};

/** The IndexTry sentence: why Drizzle Run tried the index, and that the database confirmed it. */
export function getIndexTrySentence(
  index: Pick<ConfirmedIndex, "trigger">,
  dialect: QueryPlansReport["dialect"],
  schemaFile: string,
): string {
  const reason = triggerReasons[index.trigger](schemaFile);

  return `${reason}, ${indexConfirmations[dialect]}`;
}

/**
 * The plan line SQLite printed once the index existed, such as "SEARCH posts USING INDEX posts_author_idx
 * (author_id=?)".
 */
export function getSqliteIndexLine(index: Pick<ConfirmedIndex, "after" | "name">): string | undefined {
  if (index.after.database !== "sqlite") {
    return undefined;
  }

  return index.after.rows.find((row) => row.detail.includes(` ${index.name}`))?.detail;
}

/** The "With index" bar's width as a share of "Now", capped at one. */
export function getIndexBarShare(measure: ConfirmedIndex["measure"]): number {
  return measure.before > 0 ? Math.min(1, measure.after / measure.before) : 0;
}

const smallTableNotes: Record<QueryPlansReport["dialect"], string> = {
  postgresql:
    "On tables this small Postgres scans even when an index exists. Plan at 100k or 1M rows for a reading that holds.",
  sqlite:
    "On tables this small every read takes under a millisecond. Plan at 100k or 1M rows for a reading that holds.",
};

/**
 * A plain note under the steps when the size limits what the plan can say: the reading uses the largest
 * planned size, Postgres scans tiny tables even with an index, and SQLite times under 1 ms are timer noise,
 * so they never confirm an index.
 */
export function getPlanNote(
  query: Pick<PlannedQuery, "raw" | "reading">,
  report: Pick<QueryPlansReport, "dialect" | "settings">,
): string | undefined {
  const reading = query.reading;

  if (reading === undefined || reading.verdict.kind !== "grows" || reading.indexes.length > 0) {
    return undefined;
  }

  if (report.settings.size === "seed" || report.settings.size === "10k") {
    return smallTableNotes[report.dialect];
  }

  const raw = getChosenRaw(query);

  if (raw?.database === "sqlite" && "medianMs" in raw.timing && raw.timing.medianMs < SQLITE_TIMING_FLOOR_MS) {
    return "SQLite answers this in under a millisecond here, which is within timer noise, so Drizzle Run confirms no index from it.";
  }

  return undefined;
}

/** "tables filled to 1M comments, 100k posts, 10k users", from the chosen size's fill. */
export function summarizeFill(report: Pick<QueryPlansReport, "fills" | "settings">): string {
  const fill = report.fills.at(-1);

  if (fill === undefined || report.settings.size === "seed" || fill.size === "seed") {
    return "tables kept at seed data";
  }

  const tables = fill.tables.toSorted((left, right) => right.rows - left.rows);

  return `tables filled to ${tables.map((table) => `${formatRows(table.rows)} ${table.name}`).join(", ")}`;
}
