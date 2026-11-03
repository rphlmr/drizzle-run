import { DIALECTS } from "@drizzle-run/core/catalog";
import type { PlannedQuery, QueryPlansReport, RunResult, SerializedValue } from "@drizzle-run/core/contracts";
import { mapValues } from "es-toolkit";

/**
 * Runs and query plans as an agent reads them: plain JSON, the output panel's content
 * without its layout, and capped so one tool result stays small.
 */

const MAX_ROWS = 200;
const MAX_TEXT = 4_000;

/** A serialized value as plain JSON: bigints as `"12n"`, dates as ISO text. */
export function toPlainValue(value: SerializedValue): unknown {
  switch (value.type) {
    case "undefined":
      return null;
    case "primitive":
      return value.value;
    case "bigint":
      return `${value.value}n`;
    case "date":
      return value.value;
    case "array":
      return value.value.slice(0, MAX_ROWS).map(toPlainValue);
    case "object":
      return mapValues(value.value, (item) => toPlainValue(item));
    case "unsupported":
      return `[${value.valueType}${value.description ? `: ${value.description}` : ""}]`;
    case "circular":
      return `[circular ${value.path}]`;
  }
}

function clipText(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function formatWhere(source: string | undefined, line: number | undefined) {
  return source === undefined ? undefined : line === undefined ? source : `${source}:${line}`;
}

function formatConsoleText(values: readonly SerializedValue[]) {
  return clipText(
    values
      .map((value) => {
        const plain = toPlainValue(value);
        return typeof plain === "string" ? plain : JSON.stringify(plain);
      })
      .join(" "),
  );
}

/** What `get_latest_run` and `run` return for one run. */
export function readRun(result: RunResult | undefined): unknown {
  if (result === undefined) {
    return { outcome: "none", note: "The project has not run since it was opened. Use run." };
  }

  const sql = result.sql.filter((event) => event.phase === "seed" || event.phase === "run");

  return {
    outcome: result.outcome,
    release: { drizzle_orm: result.tuple.ormVersion, drizzle_kit: result.tuple.kitVersion },
    ...(result.timings.total === undefined ? {} : { duration_ms: Math.round(result.timings.total) }),
    ...(result.error
      ? { error: { phase: result.error.phase, name: result.error.name, message: clipText(result.error.message) } }
      : {}),
    displays: result.displays.slice(0, MAX_ROWS).map((display) => ({
      label: display.label,
      at: formatWhere(display.source, display.line),
      values: display.values.map(toPlainValue),
    })),
    console: result.logs
      .slice(0, MAX_ROWS)
      .map((log) => ({ level: log.level, at: formatWhere(log.source, log.line), text: formatConsoleText(log.values) })),
    sql: sql.slice(0, MAX_ROWS).map((event) => ({
      phase: event.phase,
      sql: clipText(event.sql),
      ...(event.parameters.length > 0 ? { params: event.parameters.map(toPlainValue) } : {}),
      ...(event.source ? { at: formatWhere(event.source, event.line) } : {}),
      outcome: event.outcome,
      ...(event.error ? { error: clipText(event.error.message) } : {}),
    })),
    ...(sql.length > MAX_ROWS ? { sql_left_out: sql.length - MAX_ROWS } : {}),
    diagnostics: result.diagnostics.map((item) => ({
      severity: item.severity,
      message: clipText(item.message),
      at: formatWhere(item.source, item.line),
    })),
    ...(result.queryPlans
      ? {
          query_plans: {
            planned: result.queryPlans.queries.length,
            size: result.queryPlans.settings.size,
            note: "Read them with get_query_plans.",
          },
        }
      : {}),
  };
}

function getQueryReading(query: PlannedQuery, index: number) {
  return {
    query: index,
    sql: clipText(query.sql),
    ...(query.reading
      ? {
          summary: query.reading.summary,
          verdict:
            query.reading.verdict.kind === "stays_fast"
              ? "Stays fast"
              : `Grows with ${query.reading.verdict.tables.join(", ")}`,
          confirmed_indexes: query.reading.indexes.map((item) => ({
            table: item.table,
            columns: item.columns,
            drizzle: item.drizzle,
            why: item.trigger,
            measure: item.measure,
          })),
        }
      : { error: query.error?.message ?? "The database could not plan this query." }),
  };
}

function getRawQuery(query: PlannedQuery, index: number) {
  return {
    query: index,
    sql: query.sql,
    params: query.parameters.map(toPlainValue),
    raw: query.raw,
    ...(query.error ? { error: query.error.message } : {}),
  };
}

/** What `get_query_plans` returns: Drizzle Run's reading, or the database's own output untouched. */
export function readQueryPlans(
  report: QueryPlansReport,
  view: "reading" | "raw",
  query?: number,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const picked = report.queries
    .map((item, index) => [item, index] as const)
    .filter(([, index]) => query === undefined || index === query);

  if (picked.length === 0 && query !== undefined) {
    return {
      ok: false,
      message: `There is no planned query ${query}; the latest run planned ${report.queries.length}.`,
    };
  }

  const from = `From ${DIALECTS[report.dialect].shortName}`;

  return {
    ok: true,
    value: {
      dialect: report.dialect,
      size: report.settings.size,
      measure_real_time: report.settings.measureRealTime,
      fills: report.fills.map((fill) => ({
        size: fill.size,
        tables: fill.tables.map((table) => ({ name: table.name, rows: table.rows })),
      })),
      view: view === "raw" ? from : "Drizzle Run's reading",
      queries: picked.map(([item, index]) =>
        view === "raw" ? getRawQuery(item, index) : getQueryReading(item, index),
      ),
      ...(report.skipped.length > 0 ? { skipped: report.skipped.map((item) => item.reason) } : {}),
      ...(report.error ? { error: report.error.message } : {}),
    },
  };
}
