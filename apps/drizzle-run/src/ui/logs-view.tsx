import type { Diagnostic, QueryPlansReport, SerializedValue, SqlEvent } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { ChevronRightIcon, CopyIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useCopyFeedback } from "./clipboard";
import { JsonTree } from "./json-tree-view";
import {
  formatConsoleLine,
  formatParams,
  formatRowCount,
  formatStatementDuration,
  getStatementTone,
  summarizeStatements,
  sumDurations,
  sumRowCounts,
  toOneLineSql,
  type StatementTone,
} from "./log-format";
import { getPlanEntries, getPlansChipLabel, getPlansHintLabel } from "./query-plans";
import { PlanLine, PlansLegend, renderPlanningPassLabel } from "./query-plans-view";
import {
  filterLogs,
  LOG_FILTERS,
  type LogFilter,
  type SetupEntry,
  type TimelineCounts,
  type TimelineEntry,
  type TimelineRow,
} from "./run-timeline";
import { SqlTokens } from "./sql-block";
import { formatSql } from "./sql-highlight";

type Entrypoints = RunManifest["entrypoints"];

type SqlEntry = Extract<TimelineEntry, { kind: "sql" }>;

type ConsoleEntry = Extract<TimelineEntry, { kind: "console" }>;

/** What the Logs tab shows: one filter, and the rows opened on their full SQL or value, by `getLogRowId`. */
export interface LogsState {
  filter: LogFilter;
  open: readonly string[];
}

/** Logs opens on every row, all folded. */
export const DEFAULT_LOGS_STATE: LogsState = { filter: "all", open: [] };

/** A row's id in `LogsState.open`: a SQL row by its statement, so a result card can open the query behind it. */
export function getLogRowId(row: SqlEvent | ConsoleEntry | SetupEntry): string {
  if ("sql" in row) {
    return `sql-${row.sequence}`;
  }

  return row.key;
}

const filterLabels: Record<LogFilter, string> = {
  all: "All",
  console: "Console",
  sql: "SQL",
};

/** What an empty filter says after a run. */
const emptyNotes: Record<LogFilter, string> = {
  all: "Nothing was logged and no SQL ran in this run.",
  console: "Nothing was logged in this run.",
  sql: "No SQL ran in this run.",
};

/** After a failed run, an empty Console filter says the error came first. */
const failedNotes: Partial<Record<LogFilter, string>> = {
  console: "Nothing was logged before the error.",
};

const toneClasses: Record<StatementTone, string> = {
  query: "text-text",
  control: "text-c-key",
  rollback: "text-err",
};

/** What a setup group's source column names when its SQL has no file of its own. */
const setupSources: Record<SetupEntry["phase"], string> = {
  bootstrap: "drizzle-kit",
  seed: "seed",
  inspect: "Drizzle Run",
};

/** The file a phase ran, when the manifest names one. */
function getPhaseFile(phase: string, entrypoints: Entrypoints | undefined): string | undefined {
  return phase === "schema"
    ? entrypoints?.schema
    : phase === "seed"
      ? entrypoints?.seed
      : phase === "run"
        ? entrypoints?.run
        : undefined;
}

/** A row's grid: source, kind, the one-line content, then meta. Phones stack the content under the rest. */
const rowGridClass = cn(
  "grid grid-cols-[96px_56px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-4 py-2.5 max-phone:grid-cols-[auto_minmax(0,1fr)_auto] max-phone:gap-x-2 max-phone:gap-y-0.75 max-phone:px-3.5 max-phone:py-2.75",
);

/** A side by side pane's narrower grid: kind, content, then meta with the source last. */
const compactRowGridClass = cn(
  "grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-border px-2.5 py-2",
);

/** The opened block under a row, aligned with the content column (16 + 96 + 12 + 56 + 12 = 192 px less the gap). */
const openBlockClass = cn(
  "flex flex-col gap-2 border-b border-border bg-mark pt-1.5 pr-4 pb-3 pl-45 max-phone:px-3.5 max-phone:pt-0",
);

const kindClass = cn("font-mono text-[10.5px] font-semibold uppercase max-phone:order-1 max-phone:text-[10px]");

const metaClass = cn(
  "inline-flex items-center gap-1.5 justify-self-end font-mono text-[11px] whitespace-nowrap text-muted max-phone:order-3",
);

const contentClass = cn("min-w-0 truncate max-phone:order-4 max-phone:col-span-full");

interface SourceProps {
  file: string | undefined;
  line: number | undefined;
  /** Shown as plain text when nothing opens, such as "drizzle-kit". */
  fallback?: string;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/** `query.ts:7`, which opens the call site; plain text when the row names no file. */
function RowSource({ file, line, fallback, onDiagnostic }: SourceProps) {
  const sourceClass =
    "min-w-0 truncate justify-self-start font-mono text-[11.5px] max-phone:order-2 max-phone:text-[10.5px]";

  if (file === undefined) {
    return <span className={cn(sourceClass, "text-muted")}>{fallback ?? ""}</span>;
  }

  return (
    <button
      type="button"
      data-slot="row-source"
      className={cn(
        sourceClass,
        "relative border-0 bg-transparent p-0 text-left text-accent-text underline underline-offset-2 after:absolute after:top-1/2 after:left-1/2 after:h-touch after:w-[max(100%,44px)] after:-translate-1/2",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onDiagnostic({ severity: "info", message: "", source: file, line: line ?? 1, column: 1 });
      }}
    >
      {line === undefined ? file : `${file}:${line}`}
    </button>
  );
}

/** "1 row · 1.4 ms", "0.2 ms" for begin and commit, "failed · 2 ms". The screenshot suite hides [data-duration]. */
function SqlMeta({ rowCount, durationMs, failed }: { rowCount?: number; durationMs?: number; failed?: boolean }) {
  const parts: ReactNode[] = [
    failed ? (
      <span key="failed" className="text-err">
        failed
      </span>
    ) : (
      rowCount !== undefined && formatRowCount(rowCount)
    ),
    durationMs !== undefined && (
      <span key="duration" data-duration="">
        {formatStatementDuration(durationMs)}
      </span>
    ),
  ].filter(Boolean);

  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && " · "}
      {part}
    </Fragment>
  ));
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn("size-3 shrink-0 stroke-[2.4] transition-transform duration-150", open && "rotate-90")}
    />
  );
}

const copyLabels = { idle: "Copy SQL", copied: "Copied", failed: "Couldn't copy" } as const;

/** The opened SQL: formatted, its params, and Copy SQL. */
function SqlDetails({ sql, plan, compact }: { sql: SqlEvent; plan?: ReactNode; compact: boolean }) {
  const { outcome, copy } = useCopyFeedback();
  const formatted = useMemo(() => formatSql(sql.sql), [sql.sql]);

  return (
    <div className={cn(openBlockClass, compact && "px-2.5")} data-slot="log-sql-details">
      <pre className="m-0 rounded-[10px] border border-border bg-surface px-3 py-2.5 font-mono text-[12px]/5 wrap-break-word whitespace-pre-wrap text-text">
        <code>
          <SqlTokens sql={formatted} />
        </code>
      </pre>
      {sql.error && <p className="m-0 font-mono text-[12px] wrap-anywhere text-err">{sql.error.message}</p>}
      <div className="flex items-center gap-2.5 text-[12px] text-muted">
        <span>Params</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-text">{formatParams(sql.parameters)}</span>
        <Button
          variant="outline"
          className={cn(
            "ml-auto h-7 shrink-0 gap-1.5 px-2.5 text-[12px] max-phone:relative max-phone:h-9 max-phone:after:absolute max-phone:after:-inset-1 [&_svg]:size-3.25",
            outcome === "failed" && "text-err",
          )}
          onClick={() => copy(sql.sql)}
        >
          <CopyIcon aria-hidden="true" />
          {copyLabels[outcome ?? "idle"]}
        </Button>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {outcome ? copyLabels[outcome] : ""}
        </span>
      </div>
      {plan}
    </div>
  );
}

/** The filter row's hint: the run order, or for a planned run the size its plans assume (shorter on phones). */
function LogsHint({ plans }: { plans: QueryPlansReport | undefined }) {
  if (plans === undefined) {
    return <span className="text-[11.5px] text-muted">In run order</span>;
  }

  const hint = getPlansHintLabel(plans.settings.size);
  const phoneHint = getPlansChipLabel(plans.settings.size);

  return (
    <span className="truncate text-[11.5px] text-muted" data-slot="plans-hint">
      {hint === phoneHint ? (
        hint
      ) : (
        <>
          <span className="max-phone:hidden">{hint}</span>
          <span className="phone:hidden">{phoneHint}</span>
        </>
      )}
    </span>
  );
}

interface ToggleRowProps {
  open: boolean;
  onToggle: () => void;
  dataKind: string;
  label: string;
  compact: boolean;
  children: ReactNode;
}

/**
 * An expandable SQL row with an independently clickable source link
 *
 * A button stretched over the whole row does the toggling, so the row's source link stays a control of its own above
 * it, instead of a control inside a control.
 */
function ToggleRow({ open, onToggle, dataKind, label, compact, children }: ToggleRowProps) {
  return (
    <div
      className={cn(
        compact ? compactRowGridClass : rowGridClass,
        "relative hover:bg-surface-2 [&_button[data-slot=row-source]]:z-1",
        open && "bg-mark hover:bg-mark",
      )}
      data-kind={dataKind}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-pointer border-0 bg-transparent p-0"
        aria-expanded={open}
        aria-label={label}
        onClick={onToggle}
      />
      {children}
    </div>
  );
}

interface SqlRowProps {
  entry: SqlEntry;
  entrypoints: Entrypoints | undefined;
  compact: boolean;
  open: boolean;
  onToggle: () => void;
  plan?: ReactNode;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/** One statement: one line until opened on its formatted SQL, params and Copy SQL. */
function SqlRow({ entry, entrypoints, compact, open, onToggle, plan, onDiagnostic }: SqlRowProps) {
  const { event } = entry;
  const failed = event.outcome === "failed";
  const oneLine = toOneLineSql(event.sql);
  const tone = getStatementTone(event.sql);
  const source = (
    <RowSource
      file={event.source ?? getPhaseFile(event.phase, entrypoints)}
      line={event.line}
      fallback={event.origin}
      onDiagnostic={onDiagnostic}
    />
  );

  return (
    <li data-slot="sql-line" data-sequence={event.sequence}>
      <ToggleRow open={open} onToggle={onToggle} dataKind="sql" label={`SQL: ${oneLine}`} compact={compact}>
        {!compact && source}
        <span className={cn(kindClass, "text-muted")}>sql</span>
        <span
          className={cn(
            contentClass,
            "font-mono text-[11.5px]",
            failed ? "text-err" : toneClasses[tone],
            tone !== "query" && "font-semibold",
            tone === "control" && "font-normal",
          )}
          data-slot="sql-text"
        >
          {tone === "query" && !failed ? <SqlTokens sql={oneLine} /> : oneLine}
        </span>
        <span className={metaClass}>
          <SqlMeta rowCount={event.rowCount} durationMs={event.durationMs} failed={failed} />
          {compact && source}
          <Chevron open={open} />
        </span>
      </ToggleRow>
      {!open && plan && (
        <div className={cn("border-b border-border px-4 py-2 pl-45 max-phone:px-3.5", compact && "px-2.5")}>{plan}</div>
      )}
      {open && <SqlDetails sql={event} plan={plan} compact={compact} />}
    </li>
  );
}

interface ConsoleRowProps {
  entry: ConsoleEntry;
  entrypoints: Entrypoints | undefined;
  compact: boolean;
  open: boolean;
  onToggle: () => void;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/** Text arguments, joined on one line, or an array or object, shown as a foldable tree. */
type ConsolePart = { kind: "text"; values: SerializedValue[] } | { kind: "tree"; value: SerializedValue };

/** A console call's arguments as an opened row shows them: runs of text between the trees. */
function splitConsoleParts(values: readonly SerializedValue[]): ConsolePart[] {
  const parts: ConsolePart[] = [];

  for (const value of values) {
    const tree =
      (value.type === "array" && value.value.length > 0) ||
      (value.type === "object" && Object.keys(value.value).length > 0);

    if (tree) {
      parts.push({ kind: "tree", value });
      continue;
    }

    const last = parts.at(-1);

    if (last?.kind === "text") {
      last.values.push(value);
    } else {
      parts.push({ kind: "text", values: [value] });
    }
  }

  return parts;
}

/**
 * One console call: tagged CONSOLE whatever its method, which shows as meta unless it is `log`
 *
 * The row previews the call on one line, as a browser console does. Opened, its text shows in full and each array or
 * object as foldable JSON.
 */
function ConsoleRow({ entry, entrypoints, compact, open, onToggle, onDiagnostic }: ConsoleRowProps) {
  const { level, phase, values } = entry.event;
  const loud = level === "error" || level === "warn";
  const source = (
    <RowSource
      file={entry.event.source ?? getPhaseFile(phase, entrypoints)}
      line={entry.event.line}
      onDiagnostic={onDiagnostic}
    />
  );

  return (
    <li data-slot="console-line">
      <ToggleRow open={open} onToggle={onToggle} dataKind="console" label="Console line" compact={compact}>
        {!compact && source}
        <span className={cn(kindClass, "text-accent-text")}>console</span>
        <span className={cn(contentClass, "font-mono text-[12.5px]", loud ? "text-err" : "text-text")}>
          {formatConsoleLine(values)}
        </span>
        <span className={metaClass}>
          {[level !== "log" && level, phase !== "run" && phase].filter(Boolean).join(" · ")}
          {compact && source}
          <Chevron open={open} />
        </span>
      </ToggleRow>
      {open && (
        <div className={cn(openBlockClass, compact && "px-2.5")}>
          {splitConsoleParts(values).map((part, index) =>
            part.kind === "tree" ? (
              <JsonTree key={index} value={part.value} />
            ) : (
              <div
                key={index}
                className={cn(
                  "rounded-[10px] border border-border bg-surface px-3 py-2.5 font-mono text-[12.5px]/5 wrap-anywhere whitespace-pre-wrap",
                  loud && "text-err",
                )}
              >
                {formatConsoleLine(part.values)}
              </div>
            ),
          )}
        </div>
      )}
    </li>
  );
}

interface SetupRowProps {
  entry: SetupEntry;
  entrypoints: Entrypoints | undefined;
  compact: boolean;
  open: boolean;
  onToggle: () => void;
  openRows: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/** SQL Drizzle Run sent around the user's code (schema setup, seed, inspection), folded into one row. */
function SetupRow({ entry, entrypoints, compact, open, onToggle, openRows, onToggleRow, onDiagnostic }: SetupRowProps) {
  const events = entry.entries.map((item) => item.event);
  const executed = events.filter((event) => event.kind === "executed");
  const summary = summarizeStatements(executed);
  const statements = `${entry.executed} ${entry.executed === 1 ? "statement" : "statements"}`;
  const file = entry.phase === "seed" ? getPhaseFile("seed", entrypoints) : undefined;

  return (
    <li data-slot="setup-line">
      <ToggleRow open={open} onToggle={onToggle} dataKind="setup" label={`${statements} folded`} compact={compact}>
        {!compact && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted max-phone:order-2 max-phone:text-[10.5px]">
            {file ?? setupSources[entry.phase]}
          </span>
        )}
        <span className={cn(kindClass, "text-muted")}>sql</span>
        <span className={cn(contentClass, "inline-flex items-center gap-1.5 text-[12.5px] text-muted")}>
          <Chevron open={open} />
          <span className="truncate">
            {statements}
            {summary && ` · ${summary}`}
          </span>
        </span>
        <span className={metaClass}>
          <SqlMeta rowCount={sumRowCounts(executed)} durationMs={sumDurations(executed)} />
        </span>
      </ToggleRow>
      {open && (
        <ol className="m-0 list-none bg-surface-2 p-0" aria-label={statements}>
          {entry.entries.map((item) => {
            const id = getLogRowId(item.event);

            return (
              <SqlRow
                key={item.key}
                entry={item}
                entrypoints={entrypoints}
                compact={compact}
                open={openRows.has(id)}
                onToggle={() => onToggleRow(id)}
                onDiagnostic={onDiagnostic}
              />
            );
          })}
        </ol>
      )}
    </li>
  );
}

export interface LogsViewProps {
  rows: readonly TimelineRow[];
  counts: TimelineCounts;
  state: LogsState;
  onStateChange: (state: LogsState) => void;
  entrypoints: Entrypoints | undefined;
  /** The run failed: an empty Console filter says nothing was logged before the error. */
  failed: boolean;
  /** The run's query plans, drawn under each run statement. */
  plans?: QueryPlansReport;
  /** A side by side pane: no filters, every row in a bordered box, the source after the meta. */
  compact?: boolean;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/**
 * Filter console lines and SQL statements while preserving run order. SQL rows expand to show the full statement,
 * and setup statements are grouped.
 */
export function LogsView({
  rows,
  counts,
  state,
  onStateChange,
  entrypoints,
  failed,
  plans,
  compact = false,
  onDiagnostic,
}: LogsViewProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const openRows = useMemo(() => new Set(state.open), [state.open]);
  const planEntries = useMemo(() => (plans === undefined ? undefined : getPlanEntries(plans)), [plans]);
  const shown = filterLogs(rows, state.filter);
  const filterCounts: Record<LogFilter, number> = { all: counts.logs, console: counts.console, sql: counts.sql };
  const toggle = (id: string) =>
    onStateChange({
      ...state,
      open: openRows.has(id) ? state.open.filter((item) => item !== id) : [...state.open, id],
    });
  const focused = state.open.at(-1);

  useEffect(() => {
    if (focused === undefined) {
      return;
    }

    const row = listRef.current?.querySelector(`[data-sequence="${focused.replace("sql-", "")}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const planOf = (entry: SqlEntry) => {
    const planEntry = entry.event.phase === "run" ? planEntries?.get(entry.event.sequence) : undefined;

    return planEntry === undefined || plans === undefined ? undefined : (
      <PlanLine entry={planEntry} report={plans} schemaFile={entrypoints?.schema ?? "the schema"} />
    );
  };

  return (
    <div
      className={cn(
        "flex min-h-full flex-col bg-surface max-phone:min-h-0 max-phone:gap-2.5 max-phone:bg-transparent max-phone:px-3 max-phone:py-3.5",
        compact &&
          "min-h-0 overflow-hidden rounded-[10px] border border-border max-phone:bg-surface max-phone:p-0 [&_li:last-child>*:last-child]:border-b-0",
      )}
    >
      <div
        className={cn(
          "sticky top-0 z-1 flex items-center gap-2 border-b border-border bg-surface px-4 py-2 max-phone:static max-phone:border-0 max-phone:bg-transparent max-phone:p-0",
          compact && "hidden",
        )}
      >
        <fieldset
          aria-label="Show in Logs"
          className="m-0 inline-flex min-w-0 gap-0.5 rounded-[8px] border-0 bg-surface-2 p-0.5 max-phone:rounded-[10px] max-phone:p-0.75"
        >
          {LOG_FILTERS.map((filter) => {
            const pressed = filter === state.filter;

            return (
              <button
                key={filter}
                type="button"
                aria-pressed={pressed}
                className={cn(
                  "relative inline-flex h-6.5 items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-2.5 text-[12px] font-medium text-muted after:absolute after:inset-x-0 after:-inset-y-2.25 max-phone:h-8 max-phone:rounded-[7px] max-phone:text-[12.5px] max-phone:after:-inset-y-1.5",
                  pressed && "bg-surface font-semibold text-text shadow-[0_0_0_1px_var(--border)]",
                )}
                onClick={() => onStateChange({ ...state, filter })}
              >
                {filterLabels[filter]}
                <span className="font-mono text-[10.5px] text-muted">{filterCounts[filter]}</span>
              </button>
            );
          })}
        </fieldset>
        <LogsHint plans={plans} />
      </div>
      {shown.length === 0 ? (
        <p className="m-0 px-4 py-3 text-[12.5px] text-muted max-phone:rounded-[12px] max-phone:border max-phone:border-border max-phone:bg-surface max-phone:px-3.5">
          {(failed && failedNotes[state.filter]) || emptyNotes[state.filter]}
        </p>
      ) : (
        <ol
          ref={listRef}
          className="m-0 list-none p-0 max-phone:overflow-hidden max-phone:rounded-[12px] max-phone:border max-phone:border-border max-phone:bg-surface max-phone:[&>li:last-child>*:last-child]:border-b-0"
          aria-label="Logs"
        >
          {shown.map((row) => {
            switch (row.kind) {
              case "sql": {
                const id = getLogRowId(row.event);

                return (
                  <SqlRow
                    key={row.key}
                    entry={row}
                    entrypoints={entrypoints}
                    compact={compact}
                    open={openRows.has(id)}
                    onToggle={() => toggle(id)}
                    plan={planOf(row)}
                    onDiagnostic={onDiagnostic}
                  />
                );
              }

              case "console": {
                const id = getLogRowId(row);

                return (
                  <ConsoleRow
                    key={row.key}
                    entry={row}
                    entrypoints={entrypoints}
                    compact={compact}
                    open={openRows.has(id)}
                    onToggle={() => toggle(id)}
                    onDiagnostic={onDiagnostic}
                  />
                );
              }

              case "setup": {
                const id = getLogRowId(row);

                return (
                  <SetupRow
                    key={row.key}
                    entry={row}
                    entrypoints={entrypoints}
                    compact={compact}
                    open={openRows.has(id)}
                    onToggle={() => toggle(id)}
                    openRows={openRows}
                    onToggleRow={toggle}
                    onDiagnostic={onDiagnostic}
                  />
                );
              }

              case "problem":
              case "query":
              case "result":
              case "rollback_cause":
              case "transaction":
                return undefined;
            }
          })}
          {plans && state.filter !== "console" && (
            <li className="border-b border-border px-4 py-2.5 text-[12.5px] text-muted" data-kind="plan">
              {renderPlanningPassLabel(plans)}
            </li>
          )}
        </ol>
      )}
      {plans && !compact && <PlansLegend report={plans} />}
    </div>
  );
}
