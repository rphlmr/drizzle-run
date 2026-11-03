import type { Diagnostic } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useCopyFeedback } from "./clipboard";
import { getQueryHint, type QueryHint } from "./query-hints";
import type { TimelineFilter, TimelineProblem, TimelineRow } from "./run-timeline";
import { StoryView } from "./story-view";

type Entrypoints = RunManifest["entrypoints"];

type Dialect = RunManifest["target"]["dialect"];

function toSentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function getProblemLocation(problem: TimelineProblem): Diagnostic | undefined {
  return problem.kind === "error"
    ? problem.location
    : problem.kind === "diagnostic" && problem.diagnostic.source
      ? problem.diagnostic
      : undefined;
}

function isErrorProblem(problem: TimelineProblem) {
  return problem.kind !== "diagnostic" || problem.diagnostic.severity === "error";
}

/**
 * A run error a failed statement threw, with the hint for what the database said
 *
 * Only a database message a hint knows makes the rich card; any other error keeps the plain one.
 */
function resolveQueryProblem(problem: TimelineProblem, dialect: Dialect | undefined) {
  const hint =
    problem.kind === "error" && problem.query !== undefined ? getQueryHint(problem.query, dialect) : undefined;

  return problem.kind === "error" && problem.query !== undefined && hint !== undefined
    ? { message: problem.query, hint }
    : undefined;
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

/** "query.ts:7:9", "query.ts:7" when the column is unknown, or undefined when the problem names no file. */
function formatProblemPosition(location: Diagnostic | undefined): string | undefined {
  if (!location?.source) {
    return undefined;
  }

  const position = `${location.source}:${location.line ?? 1}`;

  return location.column === undefined ? position : `${position}:${location.column}`;
}

/**
 * What Copy error puts on the clipboard: "Run error: boom", then "    at query.ts:7:9" when located. A query error
 * starts with what the database said and ends with the full error, which holds the SQL.
 */
export function formatProblemForCopy(problem: TimelineProblem, dialect?: Dialect): string {
  const position = formatProblemPosition(getProblemLocation(problem));
  const query = resolveQueryProblem(problem, dialect);
  const summary =
    query === undefined ? `${getProblemKind(problem)}: ${getProblemMessage(problem)}` : `Query error: ${query.message}`;
  const located = position === undefined ? summary : `${summary}\n    at ${position}`;

  return query === undefined ? located : `${located}\n\n${getProblemMessage(problem)}`;
}

const copyErrorLabels = {
  idle: "Copy error",
  copied: "Copied",
  failed: "Couldn't copy",
} as const;

/** The card's buttons: drawn at 30 px (36 on phones, with a 44 px hit area). */
const cardButtonClass = cn(
  "relative min-h-7.5 rounded-[8px] px-3 text-[12.5px] max-phone:min-h-9 max-phone:rounded-[9px] max-phone:text-[13px] max-phone:after:absolute max-phone:after:inset-x-0 max-phone:after:top-1/2 max-phone:after:h-touch max-phone:after:-translate-y-1/2",
);

function CopyErrorButton({ problem, dialect }: { problem: TimelineProblem; dialect: Dialect | undefined }) {
  const { outcome, copy } = useCopyFeedback();

  return (
    <Button
      variant="outline"
      className={cn(cardButtonClass, outcome === "failed" && "text-err")}
      onClick={() => copy(formatProblemForCopy(problem, dialect))}
    >
      {copyErrorLabels[outcome ?? "idle"]}
      <span className="sr-only" aria-live="polite">
        {outcome ? copyErrorLabels[outcome] : ""}
      </span>
    </Button>
  );
}

/** A query error's hint, the file it names in code: "Check that `schema.ts` exports it." */
function QueryHintText({ hint, file }: { hint: QueryHint; file: string | undefined }) {
  const named = hint.file === undefined ? undefined : (file ?? `${hint.file}.ts`);

  return (
    <p className="m-0 text-[13px] leading-[1.55] text-muted">
      {hint.lead}
      {named !== undefined && (
        <>
          {" "}
          <code className="font-mono text-[12px]">{named}</code>
        </>
      )}
      {hint.tail !== undefined && (hint.tail.startsWith(".") ? hint.tail : ` ${hint.tail}`)}
    </p>
  );
}

interface ProblemCardProps {
  problem: TimelineProblem;
  entrypoints: Entrypoints | undefined;
  dialect: Dialect | undefined;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/**
 * Show a problem's message and source location, with actions to open the source or copy the error.
 * Recognized database errors include a hint whose file can be opened on desktop.
 */
function ProblemCard({ problem, entrypoints, dialect, onDiagnostic }: ProblemCardProps) {
  const location = getProblemLocation(problem);
  const position = formatProblemPosition(location);
  const error = isErrorProblem(problem);
  const open = location?.source ? () => onDiagnostic(location) : undefined;
  const query = resolveQueryProblem(problem, dialect);
  const hintFile = query?.hint.file === undefined ? undefined : entrypoints?.[query.hint.file];
  const openHinted =
    hintFile === undefined
      ? undefined
      : () => onDiagnostic({ severity: "error", message: query?.message ?? "", source: hintFile });

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[14px] bg-surface",
        error ? "border-[1.5px] border-err" : "border border-border",
      )}
      data-kind="problem"
      role={error ? "alert" : undefined}
    >
      <div className="flex flex-col gap-2 px-4 py-3.5 max-phone:px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold",
              error ? "bg-err-bg text-err" : "bg-surface-2 text-muted",
            )}
          >
            {query === undefined ? getProblemKind(problem) : "Query error"}
          </span>
          {open && position && (
            <button
              type="button"
              className="relative min-w-0 truncate font-mono text-[11.5px] text-accent-text underline underline-offset-2 after:absolute after:top-1/2 after:left-1/2 after:h-touch after:w-[max(100%,44px)] after:-translate-1/2"
              onClick={open}
            >
              {position}
            </button>
          )}
        </div>
        <p className="m-0 font-mono text-[13.5px] leading-[1.3] font-semibold wrap-anywhere whitespace-pre-wrap max-phone:text-[13px]">
          {query === undefined ? getProblemMessage(problem) : query.message}
        </p>
        {query && <QueryHintText hint={query.hint} file={hintFile} />}
      </div>
      <div className="flex gap-2 border-t border-border bg-surface-2 px-4 py-2.5 max-phone:px-3.5">
        {openHinted && hintFile && (
          <Button variant="outline" className={cn(cardButtonClass, open && "max-phone:hidden")} onClick={openHinted}>
            Open {hintFile}
          </Button>
        )}
        {open && location?.source && (
          <Button
            variant="outline"
            className={cn(cardButtonClass, "max-phone:flex-1", openHinted && "phone:hidden")}
            onClick={open}
          >
            <span className="max-phone:hidden">Open {location.source}</span>
            <span className="phone:hidden">Show in code</span>
          </Button>
        )}
        <CopyErrorButton problem={problem} dialect={dialect} />
      </div>
    </article>
  );
}

/** The Problems tab: one card per problem. */
function ProblemCards({
  rows,
  className,
  ...card
}: {
  rows: readonly TimelineRow[];
  className?: string;
} & Omit<ProblemCardProps, "problem">) {
  return (
    <ol
      className={cn(
        "m-0 flex list-none flex-col gap-3 p-4.5 max-phone:gap-2.5 max-phone:px-3 max-phone:py-3.5",
        className,
      )}
      aria-label="Problems"
    >
      {rows.map(
        (row) =>
          row.kind === "problem" && (
            <li key={row.key}>
              <ProblemCard problem={row.problem} {...card} />
            </li>
          ),
      )}
    </ol>
  );
}

export interface OutputTimelineProps {
  rows: readonly TimelineRow[];
  filter: Extract<TimelineFilter, "story" | "problems">;
  entrypoints: Entrypoints | undefined;
  /** The run's dialect, which picks the hints a query error gets on the Problems tab. */
  dialect?: Dialect;
  className?: string;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/** The Story cards or the Problems cards of a run. */
export function OutputTimeline({ rows, filter, entrypoints, dialect, className, onDiagnostic }: OutputTimelineProps) {
  if (filter === "problems") {
    return (
      <ProblemCards
        rows={rows}
        className={className}
        entrypoints={entrypoints}
        dialect={dialect}
        onDiagnostic={onDiagnostic}
      />
    );
  }

  return <StoryView rows={rows} entrypoints={entrypoints} className={className} onDiagnostic={onDiagnostic} />;
}
