import { DIALECTS } from "@drizzle-run/core/catalog";
import type {
  ConfirmedIndex,
  PlannedQuery,
  QueryPlanReading,
  QueryPlansReport,
  QueryPlansSettings,
} from "@drizzle-run/core/contracts";
import { formatRows, type PlanStep } from "@drizzle-run/runtime/query-plans";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  ListTreeIcon,
  PlayIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { useCopyFeedback } from "./clipboard";
import { formatRunDuration } from "./output-tab";
import {
  describeIndexTarget,
  formatMeasure,
  getChosenRaw,
  getChosenSteps,
  getExplainText,
  getGrowthRow,
  getIndexBarShare,
  getIndexTrySentence,
  getPlanNote,
  getPlansTabMark,
  getPlansTabMarkLabel,
  getSqliteIndexLine,
  getVerdictLabel,
  sizeLabels,
  summarizeFill,
  type QueryPlanEntry,
} from "./query-plans";

type Dialect = QueryPlansReport["dialect"];

const sourceTags: Record<Dialect, string> = {
  postgresql: "From Postgres",
  sqlite: "From SQLite",
};

/** "From Postgres" (the database's output) or "Drizzle Run tried" (Drizzle Run's reading), never mixed up. */
function SourceTag({ tone, children }: { tone: "database" | "drizzle-run"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-bold tracking-[0.02em] whitespace-nowrap uppercase",
        tone === "database" ? "border border-border bg-surface-2 text-muted" : "bg-lime text-on-lime",
      )}
    >
      {children}
    </span>
  );
}

/** Drizzle Run's verdict in words, with its icon: never color alone. */
export function Verdict({ verdict }: { verdict: QueryPlanReading["verdict"] }) {
  const fast = verdict.kind === "stays_fast";

  return (
    <span
      className={cn(
        "inline-flex h-5.5 shrink-0 items-center gap-1.25 rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap [&_svg]:size-2.75 [&_svg]:stroke-[2.6]",
        fast ? "bg-ok-bg text-ok" : "bg-err-bg text-err",
      )}
      data-verdict={verdict.kind}
    >
      {fast ? <CheckIcon aria-hidden="true" /> : <TrendingUpIcon aria-hidden="true" />}
      {getVerdictLabel(verdict)}
    </span>
  );
}

/** The Logs tab's mark after a planned run: "↗ 1 grows" in the verdict's color, or a check when all stay fast. */
export function PlansTabMark({ report, className }: { report: QueryPlansReport; className?: string }) {
  const mark = getPlansTabMark(report);

  if (mark === undefined) {
    return undefined;
  }

  const fast = mark.kind === "stays_fast";
  const label = getPlansTabMarkLabel(mark);

  return (
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold whitespace-nowrap [&_svg]:size-2.75 [&_svg]:stroke-[2.6]",
        fast ? "bg-ok-bg text-ok" : "bg-err-bg text-err",
        className,
      )}
      title={fast ? "Every query plan stays fast" : `Query plans: ${label} with the tables`}
      data-slot="plans-tab-mark"
      data-verdict={mark.kind}
    >
      {fast ? <CheckIcon aria-hidden="true" /> : <TrendingUpIcon aria-hidden="true" />}
      {fast ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}

const lineClass = cn(
  "relative flex h-8 w-full min-w-0 items-center gap-2 rounded-[9px] border border-dashed border-border bg-transparent pr-1.5 pl-2.5 text-left text-[12px] text-muted",
  "after:absolute after:inset-x-0 after:-inset-y-1.5",
  "max-phone:h-auto max-phone:min-h-9 max-phone:flex-wrap max-phone:gap-x-1.5 max-phone:gap-y-0.75 max-phone:py-1.75 max-phone:pr-2 max-phone:pl-2.5",
  "[&>svg]:size-3.25 [&>svg]:shrink-0",
);
const summaryClass = cn(
  "min-w-0 flex-1 truncate text-text max-phone:order-last max-phone:basis-full max-phone:pl-[19px] max-phone:text-[12.5px] max-phone:leading-[1.35] max-phone:whitespace-normal",
);

export interface PlanLineProps {
  entry: QueryPlanEntry;
  report: QueryPlansReport;
  /** The schema file the index sentence names, such as "schema.ts". */
  schemaFile: string;
}

/** The plan of one Query row: a summary and a verdict, opening onto the plan's steps. */
export function PlanLine({ entry, report, schemaFile }: PlanLineProps) {
  const [open, setOpen] = useState(false);

  if (entry.kind === "skipped" || entry.query.reading === undefined) {
    const reason =
      entry.kind === "skipped"
        ? `Not planned: ${entry.reason}`
        : `Could not plan this query: ${entry.query.error?.message ?? "the database returned no plan"}`;

    return (
      <p className={cn(lineClass, "after:hidden")} data-slot="plan-line">
        <ListTreeIcon aria-hidden="true" />
        <b className="font-semibold text-text">Plan</b>
        <span className={cn(summaryClass, "text-muted")}>{reason}</span>
      </p>
    );
  }

  const { query } = entry;
  const reading = query.reading;

  if (reading === undefined) {
    return undefined;
  }

  return (
    <>
      <button
        type="button"
        className={cn(lineClass, open && "rounded-b-none border-solid border-card-border border-b-border")}
        aria-expanded={open}
        data-slot="plan-line"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        <b className="font-semibold text-text">Plan</b>
        <span className={summaryClass}>{reading.summary}</span>
        <span className="ml-auto flex">
          <Verdict verdict={reading.verdict} />
        </span>
      </button>
      {open && <PlanSteps query={query} report={report} schemaFile={schemaFile} />}
    </>
  );
}

/** `└` for a step's last sibling, `├` otherwise. */
function getBranchGlyph(steps: readonly PlanStep[], index: number): string {
  const depth = steps[index]?.depth ?? 0;

  for (const next of steps.slice(index + 1)) {
    if (next.depth < depth) {
      return "└";
    }

    if (next.depth === depth) {
      return "├";
    }
  }

  return "└";
}

const gridClass = cn(
  "grid grid-cols-[minmax(0,1fr)_120px_70px] items-center gap-x-2.5 px-3 max-phone:grid-cols-[minmax(0,1fr)_64px_34px] max-phone:gap-x-2 max-phone:px-2.5",
);

export interface PlanStepsProps {
  query: PlannedQuery;
  report: QueryPlansReport;
  schemaFile: string;
}

/**
 * The opened plan: the database's steps, how the query grows by size, Copy EXPLAIN, and any index Drizzle Run tried.
 */
export function PlanSteps({ query, report, schemaFile }: PlanStepsProps) {
  const steps = getChosenSteps(query);
  const costs = DIALECTS[report.dialect].queryPlans.estimatesCost;
  const growth = getGrowthRow(query);
  const note = getPlanNote(query, report);
  const raw = getChosenRaw(query);

  return (
    <div
      className="-mt-1.75 rounded-b-[10px] border border-t-0 border-card-border pt-1 pb-2.5 text-[12.5px]"
      data-slot="plan-steps"
    >
      <div
        className={cn(
          gridClass,
          "mb-0.5 border-b border-border pt-1 pb-1.5 text-[11px] text-muted",
          !costs && "grid-cols-1 max-phone:grid-cols-1",
        )}
      >
        <span className="flex items-center gap-1.5">
          Step <SourceTag tone="database">{sourceTags[report.dialect]}</SourceTag>
        </span>
        {costs && (
          <span>
            <span className="max-phone:hidden">Share of cost</span>
            <span className="phone:hidden">Cost</span>
          </span>
        )}
        {costs && <span className="text-right">Rows</span>}
      </div>
      <ol className="m-0 list-none p-0" aria-label={`Plan steps, ${sourceTags[report.dialect].toLowerCase()}`}>
        {steps.map((step, index) => {
          const indent = step.depth;
          const arrow = costs ? indent > 0 : true;
          const detail = [step.index === undefined ? undefined : `using ${step.index}`, step.detail]
            .filter((part) => part !== undefined)
            .join(" ");

          return (
            <li
              key={index}
              className={cn(
                gridClass,
                "min-h-6.5 py-1 max-phone:min-h-6",
                !costs && "grid-cols-1 max-phone:grid-cols-1",
              )}
            >
              <span
                className={cn(
                  "flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap",
                  !costs && "flex-wrap gap-y-0.5 whitespace-normal",
                )}
                style={{ paddingLeft: `${indent * 16}px` }}
              >
                {arrow && (
                  <span className="font-mono text-[11.5px] text-faint" aria-hidden="true">
                    {getBranchGlyph(steps, index)}
                  </span>
                )}
                <b className="font-semibold">{step.operation}</b>
                {step.relation !== undefined && (
                  <span className="font-mono text-[11.5px] text-muted">{step.relation}</span>
                )}
                {detail !== "" && (
                  <span className={cn("min-w-0 font-mono text-[11px] text-muted", costs && "truncate")}>{detail}</span>
                )}
              </span>
              {costs && (
                <span className="relative h-2 overflow-hidden rounded-full bg-surface-2">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-progress"
                    style={{ width: `${Math.round((step.shareOfCost ?? 0) * 100)}%` }}
                  />
                  <span className="sr-only">{Math.round((step.shareOfCost ?? 0) * 100)}% of the cost</span>
                </span>
              )}
              {costs && (
                <span className="text-right font-mono text-[11.5px] whitespace-nowrap">
                  {step.rows === undefined ? "" : formatRows(step.rows)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mx-3 mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted max-phone:mx-2.5">
        <span>{growth.label}</span>
        {growth.points.map((point) => (
          <span
            key={point.size}
            className={cn(
              "inline-flex items-baseline gap-1.25 rounded-full border border-border px-2 py-0.75",
              point.chosen && "border-[1.5px] border-card-border bg-mark",
            )}
            aria-current={point.chosen ? "true" : undefined}
          >
            <span>{point.label}</span>
            <b className="font-mono text-[11.5px] font-semibold text-text">{point.value}</b>
          </span>
        ))}
        {raw && <CopyExplain text={getExplainText(raw)} />}
      </div>
      {note && <p className="mx-3 mt-2 text-[12px] leading-[1.45] text-muted max-phone:mx-2.5">{note}</p>}
      {query.reading?.indexes.map((index) => (
        <IndexTry key={index.name} index={index} dialect={report.dialect} schemaFile={schemaFile} />
      ))}
    </div>
  );
}

const copyLabels = {
  idle: "Copy EXPLAIN",
  copied: "Copied",
  failed: "Couldn't copy",
} as const;

/**
 * Copies the database's raw output, never Drizzle Run's reading. Drawn at 24 px (28 on phones), with a 44 px hit area.
 */
function CopyExplain({ text }: { text: string }) {
  const { outcome, copy } = useCopyFeedback();

  return (
    <button
      type="button"
      className={cn(
        "relative ml-auto inline-flex h-6 items-center gap-1.25 rounded-sm border border-border bg-surface px-2 text-[11.5px] text-text hover:bg-surface-2",
        "after:absolute after:inset-x-0 after:top-1/2 after:h-touch after:-translate-y-1/2 max-phone:h-7 max-phone:px-2.25 max-phone:text-[12px] [&_svg]:size-3",
        outcome === "failed" && "text-err",
      )}
      onClick={() => copy(text)}
    >
      {outcome === "copied" ? (
        <CheckIcon aria-hidden="true" />
      ) : outcome === "failed" ? (
        <XIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
      {copyLabels[outcome ?? "idle"]}
      <span className="sr-only" aria-live="polite">
        {outcome ? copyLabels[outcome] : ""}
      </span>
    </button>
  );
}

/** `index("posts_author_idx").on(t.authorId)` with its call names and strings colored like the editor. */
function DrizzleLine({ line }: { line: string }) {
  const parts = line.split(/("[^"]*"|\w+(?=\())/);

  return parts.map((part, index) => {
    if (part.startsWith('"')) {
      return (
        <span key={index} className="text-c-str">
          {part}
        </span>
      );
    }

    return index % 2 === 1 ? (
      <span key={index} className="text-c-fn">
        {part}
      </span>
    ) : (
      part
    );
  });
}

/** An index Drizzle Run tried and the database confirmed: why, before and after, and the Drizzle line to add. */
export function IndexTry({
  index,
  dialect,
  schemaFile,
}: {
  index: ConfirmedIndex;
  dialect: Dialect;
  schemaFile: string;
}) {
  const share = getIndexBarShare(index.measure);
  const sqliteLine = getSqliteIndexLine(index);

  return (
    <section
      className="mx-3 mt-2.5 overflow-hidden rounded-[10px] border border-border max-phone:mx-2.5"
      aria-label={`Drizzle Run tried an index on ${describeIndexTarget(index)}`}
      data-slot="index-try"
    >
      <div className="flex items-center gap-2 bg-surface-2 px-2.5 py-2 text-[12.5px] max-phone:flex-wrap max-phone:gap-y-1">
        <SourceTag tone="drizzle-run">Drizzle Run tried</SourceTag>
        <b className="font-semibold">An index on {describeIndexTarget(index)}</b>
      </div>
      <div className="flex flex-col gap-2 px-2.5 py-2 text-[12px] leading-[1.45] text-muted">
        <p>
          {getIndexTrySentence(index, dialect, schemaFile)}
          {dialect === "sqlite" &&
            (sqliteLine ? (
              <>
                <span className="max-phone:hidden">
                  : <span className="font-mono">{sqliteLine}</span>
                </span>
                .
              </>
            ) : (
              "."
            ))}
        </p>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 text-[12px]">
          <span>Now</span>
          <span className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
            <span className="absolute inset-y-0 left-0 w-full rounded-full bg-progress" />
          </span>
          <span className="text-right font-mono text-[11.5px] font-semibold text-text">
            {formatMeasure(index.measure.before, index.measure.unit)}
          </span>
          <span>With index</span>
          <span className="relative h-2.5 overflow-hidden rounded-full bg-surface-2">
            <span
              className="absolute inset-y-0 left-0 min-w-0.75 rounded-full bg-progress"
              style={{ width: `${share * 100}%` }}
            />
          </span>
          <span className="text-right font-mono text-[11.5px] font-semibold text-text">
            {formatMeasure(index.measure.after, index.measure.unit)}
          </span>
        </div>
        <code className="block overflow-x-auto rounded-[8px] border border-border bg-code px-2.5 py-1.25 font-mono text-[12px]/5 whitespace-pre text-text max-phone:px-1.5 max-phone:text-[11px]">
          <DrizzleLine line={index.drizzle} />
        </code>
      </div>
    </section>
  );
}

export interface PlansNoticeProps {
  flag: QueryPlansSettings;
  /** The shown run's own settings, when it was planned. */
  planned: QueryPlansSettings | undefined;
  onRun?: () => void;
  canRun?: boolean;
}

/** The flag is on, the shown run predates it: plans come with the next run, which only the user starts. */
export function PlansNotice({ flag, planned, onRun, canRun = false }: PlansNoticeProps) {
  const size = sizeLabels[flag.size];
  const before =
    planned === undefined ? "This run happened before." : `This run was planned at ${sizeLabels[planned.size]}.`;

  return (
    <div
      className={cn(
        "mx-4 mt-3.5 mb-1 flex items-center gap-3 rounded-lg border-[1.5px] border-card-border bg-surface px-3.5 py-3 text-[13px] shadow-sticker-card [&>svg]:size-4 [&>svg]:shrink-0",
        "max-phone:mx-3 max-phone:mb-0 max-phone:flex-col max-phone:gap-3 max-phone:border-0 max-phone:bg-transparent max-phone:px-5 max-phone:py-7 max-phone:text-center max-phone:shadow-none max-phone:[&>svg]:hidden",
      )}
      data-slot="plans-notice"
    >
      <ListTreeIcon aria-hidden="true" />
      <p className="flex flex-1 flex-col gap-0.5 max-phone:items-center max-phone:gap-3">
        <b className="font-semibold max-phone:hidden">Query plans are on</b>
        <b className="text-[14px] font-semibold phone:hidden">Run again to plan each query</b>
        <span className="text-[12px] text-muted max-phone:hidden">
          {before} Run again to plan each query at {size}.
        </span>
        <span className="text-[13px] text-muted phone:hidden">
          Query plans are on. The next run plans every query your code sends.
        </span>
      </p>
      {onRun && (
        <button
          type="button"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border-[1.5px] border-run-border bg-lime px-3.5 text-[13px] font-semibold text-on-lime shadow-action enabled:hover:brightness-97 enabled:active:translate-0.5 enabled:active:shadow-none disabled:opacity-55 disabled:shadow-none max-phone:h-touch [&_svg]:size-3.25 [&_svg]:fill-current"
          disabled={!canRun}
          onClick={onRun}
        >
          <PlayIcon aria-hidden="true" />
          Run
        </button>
      )}
    </div>
  );
}

/** Explain plan verdicts using examples from the report. */
export function PlansLegend({ report }: { report: QueryPlansReport }) {
  const grows = report.queries.flatMap((query) =>
    query.reading?.verdict.kind === "grows" ? query.reading.verdict.tables : [],
  );
  const table = grows[0];

  return (
    <p
      className="sticky bottom-0 z-1 mt-auto flex flex-wrap gap-3 border-t border-border bg-surface px-4 py-2.5 text-[11.5px] text-muted max-phone:hidden"
      data-slot="plans-legend"
    >
      <span className="inline-flex items-center gap-1.5">
        <Verdict verdict={{ kind: "stays_fast" }} />
        reads a fixed number of rows
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Verdict verdict={{ kind: "grows", tables: table === undefined ? ["a table"] : [table] }} />
        reads more as the table grows
      </span>
    </p>
  );
}

/** "Planning pass · tables filled to 1M posts, 100k users · 4.7 s", or why planning stopped. */
export function renderPlanningPassLabel(report: QueryPlansReport): ReactNode {
  return (
    <>
      Planning pass · {summarizeFill(report)}
      {" · "}
      <span data-duration="">{formatRunDuration(report.durationMs)}</span>
      {report.error && <span className="text-err"> · stopped: {report.error.message}</span>}
    </>
  );
}
