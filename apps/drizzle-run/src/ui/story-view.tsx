import type { Diagnostic, RunTransaction, SqlEvent, TransactionStatementRole } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  formatConsoleLine,
  formatRowCount,
  formatStatementDuration,
  getStatementTone,
  sumDurations,
  sumRowCounts,
  toOneLineSql,
} from "./log-format";
import type {
  QueryGroup,
  RollbackCause,
  SetupEntry,
  TimelineEntry,
  TimelineProblem,
  TimelineRow,
  TransactionGroup,
} from "./run-timeline";
import { SqlTokens } from "./sql-block";

type Entrypoints = RunManifest["entrypoints"];

type OnDiagnostic = (diagnostic: Diagnostic) => void;

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

function toSentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface SourceLinkProps {
  file: string | undefined;
  line: number | undefined;
  /** The card's own file: a step in it shows ":7" alone. */
  cardFile?: string;
  /** The card's own line: a step at the card's call site shows no link, the card's title already names it. */
  cardLine?: number;
  error?: boolean;
  onDiagnostic: OnDiagnostic;
}

/** `query.ts:7`, or `:7` inside a card of the same file, or nothing at the card's own call site; opens the call site. */
function SourceLink({ file, line, cardFile, cardLine, error = false, onDiagnostic }: SourceLinkProps) {
  if (file === undefined || (file === cardFile && line !== undefined && line === cardLine)) {
    return undefined;
  }

  const label = file === cardFile && line !== undefined ? `:${line}` : line === undefined ? file : `${file}:${line}`;

  return (
    <button
      type="button"
      className={cn(
        "relative shrink-0 border-0 bg-transparent p-0 font-mono text-[10.5px] underline underline-offset-2 after:absolute after:top-1/2 after:left-1/2 after:h-touch after:w-[max(100%,44px)] after:-translate-1/2",
        error ? "text-err" : "text-accent-text",
      )}
      onClick={() => onDiagnostic({ severity: "info", message: "", source: file, line: line ?? 1, column: 1 })}
    >
      {label}
    </button>
  );
}

const chipClass = cn(
  "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap",
);

/** Story's key to the marks on writes. */
function StoryLegend() {
  return (
    <p className="m-0 flex justify-end gap-3.5 text-[11.5px] text-muted" data-slot="story-legend">
      <span className="inline-flex items-center gap-1.25">
        <span className="inline-block size-2 rounded-full bg-ok" aria-hidden="true" />
        kept
      </span>
      <span className="inline-flex items-center gap-1.25">
        <span className="inline-block size-2 rounded-full border-[1.5px] border-err" aria-hidden="true" />
        undone
      </span>
    </p>
  );
}

interface CardProps {
  title: ReactNode;
  source?: ReactNode;
  chip?: ReactNode;
  dataKind: string;
  outcome?: string;
  error?: boolean;
  children?: ReactNode;
}

/** One Story card: its title, call site and outcome chip, then its steps. */
function StoryCard({ title, source, chip, dataKind, outcome, error = false, children }: CardProps) {
  return (
    <li
      className={cn(
        "rounded-[12px] bg-surface px-3 py-2",
        error ? "border-[1.5px] border-err" : "border border-border",
      )}
      data-kind={dataKind}
      data-outcome={outcome}
      role={error ? "alert" : undefined}
    >
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 pb-1.5">
        <span className="shrink-0 text-[13px] font-[650]">{title}</span>
        {source}
        {chip && <span className="ml-auto">{chip}</span>}
      </div>
      {children}
    </li>
  );
}

type DotTone = "faint" | "kept" | "undone" | "read" | "commit" | "rollback" | "console";

const dotClasses: Record<DotTone, string> = {
  faint: "bg-faint",
  kept: "bg-ok",
  undone: "border-[1.5px] border-err",
  read: "bg-text",
  commit: "border-[1.5px] border-run-border bg-lime",
  rollback: "bg-err",
  console: "bg-accent-text",
};

interface StepProps {
  mark: DotTone | "error";
  children: ReactNode;
  meta?: ReactNode;
  dataKind: string;
}

/** One step of a card: a mark, what happened (wrapping when long), then its numbers and call site on its first line. */
function Step({ mark, children, meta, dataKind }: StepProps) {
  return (
    <div className="grid min-h-7.5 grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2" data-kind={dataKind}>
      <span className="flex h-7.5 items-center justify-center" aria-hidden="true">
        {mark === "error" ? (
          <span className="text-[13px] leading-none font-bold text-err">!</span>
        ) : (
          <span className={cn("size-2.25 rounded-full", dotClasses[mark])} />
        )}
      </span>
      {children}
      {meta ? <span className="inline-flex h-7.5 items-center gap-2">{meta}</span> : <span />}
    </div>
  );
}

/** A step's text: the whole statement or console line, wrapped, its first line centered on the step's mark. */
const stepTextClass = cn("min-w-0 py-1.75 font-mono leading-4 wrap-anywhere whitespace-pre-wrap");

const metaTextClass = cn("font-mono text-[11px] whitespace-nowrap text-muted");

/** "2 rows · 1.1 ms"; the screenshot suite hides [data-duration], which changes between runs. */
function StatementNumbers({ sql, undone = false }: { sql: SqlEvent; undone?: boolean }) {
  const parts = [
    sql.outcome === "failed" ? (
      <span key="failed" className="text-err">
        failed
      </span>
    ) : (
      sql.rowCount !== undefined && (
        <span key="rows" className={cn(undone && "text-faint line-through")}>
          {formatRowCount(sql.rowCount)}
        </span>
      )
    ),
    sql.durationMs !== undefined && (
      <span key="duration" data-duration="">
        {formatStatementDuration(sql.durationMs)}
      </span>
    ),
  ].filter(Boolean);

  if (parts.length === 0) {
    return undefined;
  }

  return (
    <span className={metaTextClass}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && " · "}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

/** How a statement inside a transaction card is drawn. */
interface StatementStep {
  role: TransactionStatementRole;
  /** A write the run undid: struck through, marked "undone". */
  undone: boolean;
  /** Said in place of the statement's numbers, such as "2 writes kept" on a commit. */
  note?: ReactNode;
  /** Where the link points instead of the statement's call site, such as the `tx.rollback()` line. */
  site?: { source?: string; line?: number };
}

/** "2 writes kept", or nothing when the transaction kept no write. */
function formatKeptWrites(count: number): string | undefined {
  return count === 0 ? undefined : `${count} ${count === 1 ? "write" : "writes"} kept`;
}

/** How a statement of the group is drawn: its role, whether the run undid it, and what its line says. */
function getStatementStep(group: TransactionGroup, sql: SqlEvent): StatementStep | undefined {
  const role = group.roles.get(sql.sequence);

  if (role === undefined) {
    return undefined;
  }

  const { transaction } = group;
  const undone = role === "write" && transaction.writes === "undone" && sql.outcome === "succeeded";

  if (role === "read" || role === "write") {
    return { role, undone };
  }

  const site = { source: transaction.source, line: transaction.line };

  if (role === "commit" && transaction.parent === undefined) {
    return { role, undone, site, note: formatKeptWrites(group.keptWrites) };
  }

  if (role === "rollback" || role === "rollback_to") {
    if (group.stopped) {
      return { role, undone, site, note: "run stopped here" };
    }

    if (transaction.reason === "rollback_call") {
      return { role, undone, note: <span className="font-mono">tx.rollback()</span>, site: transaction.error };
    }
  }

  return { role, undone, site };
}

function getStepMark(sql: SqlEvent, step: StatementStep | undefined): StepProps["mark"] {
  if (sql.outcome === "failed") {
    return "error";
  }

  switch (step?.role) {
    case "write":
      return step.undone ? "undone" : "kept";
    case "commit":
      return "commit";
    case "rollback":
    case "rollback_to":
      return "rollback";
    case "begin":
    case "savepoint":
    case "release":
      return "faint";
    case "read":
    case undefined:
      return getStatementTone(sql.sql) === "control" ? "faint" : "read";
  }
}

interface SqlStepProps {
  sql: SqlEvent;
  step?: StatementStep;
  cardFile: string | undefined;
  cardLine?: number;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}

/** A whole statement, colored by what it did, with its rows, time and call site. */
function SqlStep({ sql, step, cardFile, cardLine, entrypoints, onDiagnostic }: SqlStepProps) {
  const tone = getStatementTone(sql.sql);
  const failed = sql.outcome === "failed";
  const oneLine = toOneLineSql(sql.sql);
  const committed = step?.role === "commit";
  const source = step?.site?.source ?? sql.source ?? getPhaseFile(sql.phase, entrypoints);
  const line = step?.site ? step.site.line : sql.line;

  return (
    <Step
      mark={getStepMark(sql, step)}
      dataKind="sql"
      meta={
        <>
          {step?.note !== undefined ? (
            <span className="text-[11.5px] text-muted">{step.note}</span>
          ) : (
            <StatementNumbers sql={sql} undone={step?.undone} />
          )}
          <SourceLink
            file={source}
            line={line}
            cardFile={cardFile}
            cardLine={cardLine}
            error={failed}
            onDiagnostic={onDiagnostic}
          />
        </>
      }
    >
      <span
        className={cn(
          stepTextClass,
          "text-[11.5px]",
          failed && "text-err",
          !failed && step?.undone && "text-faint line-through",
          !failed && committed && "font-semibold text-ok",
          !failed && tone === "control" && !committed && "text-c-key",
          !failed && tone === "rollback" && "font-semibold text-err",
        )}
        data-slot="sql-line"
      >
        {tone === "query" && !failed && !step?.undone ? <SqlTokens sql={oneLine} /> : oneLine}
      </span>
    </Step>
  );
}

/** A console line as a step: all its printed values. */
function ConsoleStep({
  entry,
  cardFile,
  cardLine,
  onDiagnostic,
}: {
  entry: Extract<TimelineEntry, { kind: "console" }>;
  cardFile?: string;
  cardLine?: number;
  onDiagnostic: OnDiagnostic;
}) {
  const { level, values, source, line } = entry.event;
  const loud = level === "error" || level === "warn";

  return (
    <Step
      mark="console"
      dataKind="console"
      meta={
        <>
          {level !== "log" && <span className={metaTextClass}>{level}</span>}
          <SourceLink file={source} line={line} cardFile={cardFile} cardLine={cardLine} onDiagnostic={onDiagnostic} />
        </>
      }
    >
      <span className={cn(stepTextClass, "text-[12px]", loud ? "text-err" : "text-text")}>
        {formatConsoleLine(values)}
      </span>
    </Step>
  );
}

/** "Balances · in Results": the lime chip of what a card's query fed. */
function InResultsChip({ label }: { label: string }) {
  return <span className={cn(chipClass, "bg-lime text-on-lime")}>{label} · in Results</span>;
}

function getProblemKind(problem: TimelineProblem): string {
  switch (problem.kind) {
    case "thrown":
      return "Run error";
    case "error":
      return toSentenceCase(`${problem.phase} error`);
    case "diagnostic":
      return toSentenceCase(problem.diagnostic.severity);
    case "cleanup":
      return "Cleanup error";
  }
}

function getProblemMessage(problem: TimelineProblem): string {
  return problem.kind === "diagnostic"
    ? problem.diagnostic.message
    : problem.kind === "cleanup"
      ? problem.error.message
      : problem.message;
}

function getProblemLocation(problem: TimelineProblem): Diagnostic | undefined {
  return problem.kind === "error"
    ? problem.location
    : problem.kind === "diagnostic" && problem.diagnostic.source
      ? problem.diagnostic
      : undefined;
}

interface StepsProps {
  rows: readonly TimelineRow[];
  group: TransactionGroup;
  cardFile: string | undefined;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}

/** A transaction card's steps: its statements, the console lines and results in its callback, and savepoints. */
function TransactionSteps({ rows, group, cardFile, entrypoints, onDiagnostic }: StepsProps) {
  return rows.map((row) => {
    switch (row.kind) {
      case "sql":
        return (
          <SqlStep
            key={row.key}
            sql={row.event}
            step={getStatementStep(group, row.event)}
            cardFile={cardFile}
            entrypoints={entrypoints}
            onDiagnostic={onDiagnostic}
          />
        );

      case "console":
        return <ConsoleStep key={row.key} entry={row} cardFile={cardFile} onDiagnostic={onDiagnostic} />;

      case "result":
        return (
          <Step key={row.key} mark="read" dataKind="result">
            <span className="min-w-0">
              <InResultsChip label={row.label ?? "Default export"} />
            </span>
          </Step>
        );

      case "rollback_cause":
        return <RollbackCauseStep key={row.key} cause={row} cardFile={cardFile} onDiagnostic={onDiagnostic} />;

      case "problem":
        return (
          <Step key={row.key} mark="error" dataKind="problem">
            <span className="min-w-0 truncate text-[12px] text-err">{getProblemMessage(row.problem)}</span>
          </Step>
        );

      case "transaction":
        return (
          <SavepointBox
            key={row.key}
            group={row}
            parent={group.transaction}
            entrypoints={entrypoints}
            onDiagnostic={onDiagnostic}
          />
        );

      case "query":
      case "setup":
        return undefined;
    }
  });
}

/** What threw inside a transaction and rolled it back: `throw Error("Changed our mind")` and where. */
function RollbackCauseStep({
  cause,
  cardFile,
  onDiagnostic,
}: {
  cause: RollbackCause;
  cardFile: string | undefined;
  onDiagnostic: OnDiagnostic;
}) {
  const { error } = cause;

  return (
    <Step
      mark="error"
      dataKind="rollback_cause"
      meta={<SourceLink file={error.source} line={error.line} cardFile={cardFile} error onDiagnostic={onDiagnostic} />}
    >
      <span className="min-w-0 truncate text-[12px] text-err">
        throw{" "}
        <span className="font-mono text-[11.5px]">
          {error.name}({JSON.stringify(error.message)})
        </span>
      </span>
    </Step>
  );
}

/** The card's outcome, in words: a savepoint rolled back while its transaction went on is "rolled back alone". */
function getTransactionOutcome(group: TransactionGroup, parent: RunTransaction | undefined) {
  const { transaction } = group;

  if (transaction.parent !== undefined) {
    return transaction.outcome === "committed"
      ? { label: "released", className: "bg-ok-bg text-ok" }
      : {
          label: parent?.outcome === "committed" ? "rolled back alone" : "rolled back",
          className: "bg-surface text-err",
        };
  }

  if (transaction.outcome === "committed") {
    return { label: "committed", className: "bg-ok-bg text-ok" };
  }

  return {
    label: group.stopped ? "failed, rolled back" : "rolled back, nothing kept",
    className: "bg-err-bg text-err",
  };
}

interface SavepointBoxProps {
  group: TransactionGroup;
  parent: RunTransaction;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}

/** A savepoint inside its transaction's card: a dashed box, in the error colors once it rolled back. */
function SavepointBox({ group, parent, entrypoints, onDiagnostic }: SavepointBoxProps) {
  const { transaction } = group;
  const rolledBack = transaction.outcome === "rolled_back";
  const outcome = getTransactionOutcome(group, parent);

  return (
    <div
      className={cn(
        "my-1.5 ml-6.5 rounded-[10px] border-[1.5px] border-dashed py-1.5 pr-2.5 pl-1",
        rolledBack ? "border-err bg-err-bg" : "border-border bg-surface-2",
      )}
      data-kind="transaction"
      data-outcome={transaction.outcome}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 pl-2">
        <span className={cn("text-[12.5px] font-[650]", rolledBack && "text-err")}>Savepoint</span>
        <SourceLink file={transaction.source} line={transaction.line} error={rolledBack} onDiagnostic={onDiagnostic} />
        <span className={cn(chipClass, "ml-auto", outcome.className)} data-slot="transaction-outcome">
          {outcome.label}
        </span>
      </div>
      <TransactionSteps
        rows={group.rows}
        group={group}
        cardFile={transaction.source}
        entrypoints={entrypoints}
        onDiagnostic={onDiagnostic}
      />
    </div>
  );
}

interface TransactionCardProps {
  group: TransactionGroup;
  /** "Transaction 2": its place among the run's transactions. */
  number: number;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}

/** Group a transaction's steps under its call site and outcome. */
function TransactionCard({ group, number, entrypoints, onDiagnostic }: TransactionCardProps) {
  const { transaction } = group;
  const outcome = getTransactionOutcome(group, undefined);

  return (
    <StoryCard
      title={`Transaction ${number}`}
      dataKind="transaction"
      outcome={transaction.outcome}
      source={<SourceLink file={transaction.source} line={transaction.line} onDiagnostic={onDiagnostic} />}
      chip={
        <span className={cn(chipClass, outcome.className)} data-slot="transaction-outcome">
          {outcome.label}
        </span>
      }
    >
      <TransactionSteps
        rows={group.rows}
        group={group}
        cardFile={transaction.source}
        entrypoints={entrypoints}
        onDiagnostic={onDiagnostic}
      />
    </StoryCard>
  );
}

/** How a setup card opens its sentence: "seed.ts ran first", "drizzle-kit set up the schema". */
function getSetupLead(entry: SetupEntry, entrypoints: Entrypoints | undefined): { name: string; verb: string } {
  switch (entry.phase) {
    case "seed":
      return { name: getPhaseFile("seed", entrypoints) ?? "seed", verb: "ran first" };
    case "bootstrap":
      return { name: "drizzle-kit", verb: "set up the schema" };
    case "inspect":
      return { name: "Drizzle Run", verb: "read the database" };
  }
}

/** Setup SQL folded into one card: "seed.ts ran first: 4 statements, 2 rows · 21 ms". It opens on its statements. */
function SetupCard({
  entry,
  entrypoints,
  onDiagnostic,
}: {
  entry: SetupEntry;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}) {
  const [open, setOpen] = useState(false);
  const executed = entry.entries.map((item) => item.event).filter((event) => event.kind === "executed");
  const rows = sumRowCounts(executed);
  const durationMs = sumDurations(executed);
  const { name, verb } = getSetupLead(entry, entrypoints);
  const counts = [
    `${entry.executed} ${entry.executed === 1 ? "statement" : "statements"}`,
    rows !== undefined && formatRowCount(rows),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li className="rounded-[12px] border border-border bg-surface" data-kind="setup">
      <button
        type="button"
        className="flex min-h-9 w-full items-center gap-2.5 rounded-[12px] border-0 bg-transparent px-3 py-2 text-left text-[12.5px] text-muted hover:text-text"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
        />
        <span className="font-mono text-[11.5px] text-text">{name}</span>
        <span className="min-w-0 truncate">
          {verb}: {counts}
          {durationMs !== undefined && (
            <>
              {" · "}
              <span data-duration="">{formatStatementDuration(durationMs)}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          {entry.entries.map((item) => (
            <SqlStep
              key={item.key}
              sql={item.event}
              cardFile={item.event.source}
              entrypoints={entrypoints}
              onDiagnostic={onDiagnostic}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** SQL sent outside a transaction from one call site, with the result it fed as its chip. */
function QueryCard({
  group,
  entrypoints,
  onDiagnostic,
}: {
  group: QueryGroup;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}) {
  const file = group.source ?? getPhaseFile("run", entrypoints);

  return (
    <StoryCard
      title="Query"
      dataKind="query"
      source={<SourceLink file={file} line={group.line} onDiagnostic={onDiagnostic} />}
      chip={group.display !== undefined && <InResultsChip label={group.display} />}
    >
      {group.entries.map((entry) => (
        <SqlStep
          key={entry.key}
          sql={entry.event}
          cardFile={file}
          cardLine={group.line}
          entrypoints={entrypoints}
          onDiagnostic={onDiagnostic}
        />
      ))}
    </StoryCard>
  );
}

interface StoryEntryCardProps {
  entry: TimelineEntry;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: OnDiagnostic;
}

/** A console line, a result no query card fed, or a problem, each as its own card. */
function StoryEntryCard({ entry, entrypoints, onDiagnostic }: StoryEntryCardProps) {
  switch (entry.kind) {
    case "console":
      return (
        <StoryCard
          title="Console"
          dataKind="console"
          source={<SourceLink file={entry.event.source} line={entry.event.line} onDiagnostic={onDiagnostic} />}
        >
          <ConsoleStep
            entry={entry}
            cardFile={entry.event.source}
            cardLine={entry.event.line}
            onDiagnostic={onDiagnostic}
          />
        </StoryCard>
      );

    case "result":
      return (
        <StoryCard
          title={entry.key === "default" ? "Export" : "Display"}
          dataKind="result"
          source={<SourceLink file={entry.source} line={entry.line} onDiagnostic={onDiagnostic} />}
          chip={<InResultsChip label={entry.label ?? "Default export"} />}
        />
      );

    case "problem": {
      const location = getProblemLocation(entry.problem);
      const error = entry.problem.kind !== "diagnostic" || entry.problem.diagnostic.severity === "error";

      return (
        <StoryCard
          title={<span className={cn(error && "text-err")}>{getProblemKind(entry.problem)}</span>}
          dataKind="problem"
          error={error}
          source={
            <SourceLink file={location?.source} line={location?.line} error={error} onDiagnostic={onDiagnostic} />
          }
        >
          <p className={cn("m-0 pb-1 font-mono text-[12.5px] leading-[1.6] wrap-anywhere", error && "text-err")}>
            {getProblemMessage(entry.problem)}
          </p>
        </StoryCard>
      );
    }

    case "sql":
      return (
        <QueryCard
          group={{
            key: entry.key,
            kind: "query",
            entries: [entry],
            source: entry.event.source,
            line: entry.event.line,
          }}
          entrypoints={entrypoints}
          onDiagnostic={onDiagnostic}
        />
      );
  }
}

export interface StoryViewProps {
  rows: readonly TimelineRow[];
  entrypoints: Entrypoints | undefined;
  className?: string;
  onDiagnostic: OnDiagnostic;
}

/**
 * The Story tab shows entries in run order. Setup folds into
 * one card, transactions hold their steps and savepoints, and a query sent outside them names the result it fed.
 */
export function StoryView({ rows, entrypoints, className, onDiagnostic }: StoryViewProps) {
  const grouped = rows.some((row) => row.kind === "transaction");
  const transactionNumbers = new Map(
    rows.filter((row) => row.kind === "transaction").map((row, index) => [row.key, index + 1]),
  );

  return (
    <div className={cn("flex flex-col gap-2.5 p-3.5 max-phone:px-3", className)}>
      {grouped && <StoryLegend />}
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Run story">
        {rows.map((row) => {
          switch (row.kind) {
            case "setup":
              return <SetupCard key={row.key} entry={row} entrypoints={entrypoints} onDiagnostic={onDiagnostic} />;

            case "transaction":
              return (
                <TransactionCard
                  key={row.key}
                  group={row}
                  number={transactionNumbers.get(row.key) ?? 1}
                  entrypoints={entrypoints}
                  onDiagnostic={onDiagnostic}
                />
              );

            case "query":
              return <QueryCard key={row.key} group={row} entrypoints={entrypoints} onDiagnostic={onDiagnostic} />;

            case "rollback_cause":
              return undefined;

            case "console":
            case "problem":
            case "result":
            case "sql":
              return <StoryEntryCard key={row.key} entry={row} entrypoints={entrypoints} onDiagnostic={onDiagnostic} />;
          }
        })}
      </ol>
    </div>
  );
}
