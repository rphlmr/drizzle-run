import type { Diagnostic, QueryPlansSettings, RunResult, SqlEvent } from "@drizzle-run/core/contracts";
import type { RunResultDiff } from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { useRunActions, useRunSelector } from "@drizzle-run/react";
import { useState, type ReactNode } from "react";

import { Segmented, SegmentedItem, SegmentedList, SegmentedPanel } from "../components/ui/segmented";
import { cn } from "../lib/utils";
import { DebugReport } from "./debug-report";
import { FirstRunCard, type FirstRunStatus } from "./first-run-card";
import { DEFAULT_LOGS_STATE, getLogRowId, LogsView, type LogsState } from "./logs-view";
import { OutputSettings, type OutputSettingsProps } from "./output-settings";
import {
  DEFAULT_OUTPUT_TAB,
  formatRunDuration,
  getOfferedTab,
  getRunOutcomeLabel,
  getRunOutcomeMark,
  readOutputTab,
  type OutputTab,
} from "./output-tab";
import { OutputTimeline } from "./output-timeline";
import { needsPlannedRun } from "./query-plans";
import { PlansNotice, PlansTabMark } from "./query-plans-view";
import { OutputEmpty, ResultCard, ResultsEmpty } from "./results";
import { OlderRunNote, RunHistoryMenu } from "./run-history-menu";
import { RunningDot, RunningDuration, RunningNote } from "./run-loader";
import {
  buildRunTimeline,
  countTimeline,
  filterTimeline,
  getResultStatements,
  type TimelineFilter,
} from "./run-timeline";
import { useFadeInOnChange } from "./use-fade-in-on-change";
import { useTabAfterRun } from "./use-tab-after-run";

const timelineFilters = ["results", "story", "logs", "problems"] as const satisfies readonly TimelineFilter[];

const tabLabels: Record<OutputTab, string> = {
  results: "Results",
  story: "Story",
  logs: "Logs",
  problems: "Problems",
  debug: "Debug",
};

/** What a filter shows after a run that has nothing of its kind; Logs says it under its own filters. */
const emptyNotes: Record<Exclude<TimelineFilter, "results" | "logs">, string> = {
  story: "This run produced no output.",
  problems: "No problems in this run.",
};
/** After a failed run, an empty filter says the error came first. */
const failedNotes: Partial<Record<TimelineFilter, string>> = {
  results: "No results: the run failed before $.display.",
};

function toSentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const pillTones: Record<RunResult["outcome"], string> = {
  succeeded: "bg-ok-bg text-ok",
  failed: "bg-err-bg text-err",
  cancelled: "bg-surface-2 text-muted",
};

const scrollClass = cn("flex min-h-0 flex-1 flex-col overflow-auto pt-1 pb-3 text-[13px]");

const viewMotionClass = cn(
  "transition-[opacity,translate] duration-(--motion-fast) ease-out starting:translate-y-1 starting:opacity-0",
);
const dotGrid = "bg-[radial-gradient(var(--dot)_1px,transparent_1.2px)] bg-size-[18px_18px]";
const phoneDotGrid = "max-phone:bg-[radial-gradient(var(--dot)_1px,transparent_1.2px)] max-phone:bg-size-[18px_18px]";
const phoneRows = "max-phone:bg-surface";

/**
 * A desktop column under about 480 px (a guide's rail, onboarding, the chat dock beside the editor) puts the status
 * and its buttons on a second, ruled row under the tabs, the way phones do.
 */
const stacked = {
  row: "phone:@max-[480px]:flex-wrap phone:@max-[480px]:gap-0 phone:@max-[480px]:p-0",
  tabs: "phone:@max-[480px]:mx-2 phone:@max-[480px]:my-2",
  tab: "phone:@max-[480px]:px-2 phone:@max-[480px]:text-[12.5px]",
  cluster:
    "phone:@max-[480px]:ml-0 phone:@max-[480px]:basis-full phone:@max-[480px]:border-t phone:@max-[480px]:border-border phone:@max-[480px]:px-2 phone:@max-[480px]:py-1.5",
} as const;

type Entrypoints = RunManifest["entrypoints"];

/** The file a phase ran, when the manifest names one. */
function getPhaseSource(phase: string, entrypoints: Entrypoints | undefined): string {
  const file =
    phase === "schema"
      ? entrypoints?.schema
      : phase === "seed"
        ? entrypoints?.seed
        : phase === "run"
          ? entrypoints?.run
          : undefined;

  return file ?? phase;
}

function CountChip({ tab, held = false, children }: { tab: TimelineFilter; held?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "ml-1.5 inline-grid h-4.5 min-w-4.5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition-opacity",
        tab === "problems"
          ? "bg-err-bg text-err"
          : tab === "results"
            ? "bg-lime text-on-lime"
            : "bg-surface-2 text-muted",
        held && "opacity-40",
      )}
    >
      {children}
    </span>
  );
}

/** A filter with nothing to show after a run, as a dashed note. */
function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-4.5 rounded-[12px] border border-dashed border-faint bg-surface px-5 py-7 text-center text-[13px] leading-[1.55] text-muted max-phone:mx-3 max-phone:my-3.5 max-phone:px-4.5 max-phone:py-6.5">
      {children}
    </p>
  );
}

function SourceLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="border-0 bg-transparent p-0 text-left font-mono text-[12px] text-accent-text underline max-phone:relative max-phone:text-[11.5px] max-phone:after:absolute max-phone:after:-inset-x-1 max-phone:after:-inset-y-3.5"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface RowSourceProps {
  phase: string;
  source: string | undefined;
  line: number | undefined;
  entrypoints: Entrypoints | undefined;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/**
 * Where a row came from, as `file:line` when the runtime knew the call site. Without one, the phase's
 * entrypoint still opens its file; a phase with no file (bootstrap) stays plain text.
 */
function RowSource({ phase, source, line, entrypoints, onDiagnostic }: RowSourceProps) {
  const file = source ?? getPhaseSource(phase, entrypoints);

  if (source === undefined && file === phase) {
    return file;
  }

  return (
    <SourceLink
      onClick={() => onDiagnostic({ severity: "info", message: "", source: file, line: line ?? 1, column: 1 })}
    >
      {line === undefined ? file : `${file}:${line}`}
    </SourceLink>
  );
}

/** Marks what a run changed since an earlier one, such as a guide step since the step before. */
export interface OutputComparison {
  /** The run these marks describe; any other run in the picker shows plain. */
  result: RunResult;
  /** Undefined when there is nothing to compare with, such as a guide's first run. */
  changes: RunResultDiff | undefined;
  /** Replaces the outcome in the status pill, such as "Step 2 run". */
  runLabel: string;
  /** A run from an earlier step: the pill stays neutral. */
  earlier: boolean;
  /** Shown on each changed result card, such as "vs step 1". */
  compareLabel?: string;
}

export interface OutputPanelProps {
  revision: number;
  onDiagnostic: (diagnostic: Diagnostic) => void;
  /** False inside the embed, whose single frame already draws the edge. */
  framed?: boolean;
  /**
   * Shows the first-run card before the first run of the tab, with the runtime's status
   * (preparing, ready, or unavailable). Without it the output keeps a plain placeholder (the embed).
   */
  firstRun?: {
    status: FirstRunStatus;
    dialect: RunManifest["target"]["dialect"];
    compact?: boolean;
    /** The output sits under the code, wide and short: the card lays its parts side by side. */
    stacked?: boolean;
    /** Run from the card once the runtime is ready. */
    onRun?: () => void;
    canRun?: boolean;
  };
  comparison?: OutputComparison;
  /** The display labels a guide step points at; their result cards scroll into view. */
  highlightedDisplays?: readonly string[];
  /** Off beside a side panel such as a guide's rail, whose pill names each run, so the tabs keep the row. */
  runPicker?: boolean;
  /**
   * The views to offer, in order; all of them by default. Without Problems, a failed run opens Story,
   * which lists the error with everything else.
   */
  views?: readonly TimelineFilter[];
  /**
   * The Query plans flag as the next run will submit it. On while the shown run was planned differently, the
   * Logs tab asks for a run (with the first-run card's Run).
   */
  queryPlans?: QueryPlansSettings;
  /** The open view, when the host controls it; a settled run still moves it to Results or Problems. */
  tab?: OutputTab;
  onTabChange?: (tab: OutputTab) => void;
  /** The gear's settings (Query plans); without them the bar has no gear, as in an embed. */
  settings?: OutputSettingsProps;
  /** The AI chat is open and can run this project too, so every run says who started it: "Started by you" or the agent. */
  chatRuns?: boolean;
  /** Names the output and its tabs, such as "rc.5 output", where a page has more than one: a side by side's sides. */
  label?: string;
  /**
   * False leaves out the tabs and the run pill, for a host that draws them itself: a side by side on a phone. The
   * history and gear buttons stay.
   */
  bar?: boolean;
}

/** The status pill before the first run: its short text in the bar, and the full label it stands for. */
const firstRunPills: Record<FirstRunStatus["state"], { short: string; full: string }> = {
  preparing: { short: "Preparing", full: "Preparing runtime" },
  ready: { short: "Not run", full: "Not run yet" },
  unavailable: { short: "Unavailable", full: "Runtime unavailable" },
};

interface RunPillProps {
  short: string;
  full: string;
  durationMs?: number;
  tone?: RunResult["outcome"];
  /** Before the first run: a minimum width, so "Preparing" turns into "Not run" without moving the bar. */
  steady?: boolean;
  /** A run is going: the pill pulses a dot and counts the seconds since it started. */
  running?: boolean;
  /** When the going run started, as the run machine's `startedAt`. */
  startedAt?: number;
  /** The short text is a run's name, such as "Step 3 run": a narrow bar drops the duration first, the title keeps it. */
  named?: boolean;
}

/**
 * The run status uses a short mark in the bar ("✓ 1.3 s"), with the full label as its title
 * and its text ("Succeeded · 1.3 s"). The short mark is drawn from `data-short`, so the status text stays the full
 * label. Phones have the room for the full label. A narrow bar cuts the short mark, such as a guide's "Step 3 run",
 * before the tabs. The screenshot suite hides [data-duration], which changes between runs.
 */
function RunPill({
  short,
  full,
  durationMs,
  tone,
  steady = false,
  running = false,
  startedAt,
  named = false,
}: RunPillProps) {
  const duration = durationMs === undefined ? undefined : formatRunDuration(durationMs);
  const label = duration === undefined ? full : `${full} · ${duration}`;

  return (
    <output
      className={cn(
        "inline-flex h-8 min-w-0 shrink items-center justify-center gap-1 rounded-full bg-surface-2 px-2.5 text-[12px] font-semibold whitespace-nowrap text-muted max-phone:h-7.5 phone:before:min-w-0 phone:before:truncate phone:before:content-[attr(data-short)]",
        tone && pillTones[tone],
        running && "bg-mark text-text",
        steady && "max-phone:min-w-32 phone:min-w-20",
      )}
      title={label}
      data-short={short}
      data-slot="run-pill"
    >
      {running && <RunningDot className="order-first" />}
      <span className="phone:sr-only">
        {full}
        {duration !== undefined && " · "}
      </span>
      {duration !== undefined && (
        <span className={cn("shrink-0", named && "phone:@min-[480px]:@max-[560px]:hidden")} data-duration="">
          {duration}
        </span>
      )}
      {running && <RunningDuration startedAt={startedAt} />}
    </output>
  );
}

/** The Logs tab's filter and open rows, for the run they were picked on. */
interface PanelLogsState extends LogsState {
  run: number | undefined;
}

/**
 * Show the selected run's output, status and history from the closest `RunProvider`.
 */
export function OutputPanel({
  revision,
  onDiagnostic,
  framed = true,
  firstRun,
  comparison,
  highlightedDisplays,
  runPicker = true,
  views = timelineFilters,
  queryPlans,
  tab: controlledTab,
  onTabChange,
  settings,
  chatRuns = false,
  label,
  bar = true,
}: OutputPanelProps) {
  const actor = useRunActions();
  const state = useRunSelector((snapshot) => snapshot);
  const [ownTab, setOwnTab] = useState<OutputTab>(DEFAULT_OUTPUT_TAB);
  const tab = controlledTab ?? ownTab;
  const setTab = (next: OutputTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  const {
    result,
    error,
    submission,
    progress,
    durationMs,
    history: runs,
    selectedHistoryEntry: shown,
    startedAt,
  } = state;
  const [pickedLogs, setPickedLogs] = useState<PanelLogsState>({ ...DEFAULT_LOGS_STATE, run: shown });
  const logs: LogsState = pickedLogs.run === shown ? pickedLogs : { filter: pickedLogs.filter, open: [] };
  const setLogs = (next: LogsState) => setPickedLogs({ ...next, run: shown });
  const running = state.status === "running" || state.status === "disposing";
  const entries = buildRunTimeline(result, error || undefined);
  const counts = countTimeline(entries);
  const debug = submission?.debug ?? false;
  const visibleTab = tab === "debug" ? (debug ? tab : DEFAULT_OUTPUT_TAB) : getOfferedTab(tab, views);
  const settledOutcome = result?.outcome ?? (error ? "failed" : undefined);
  const stale = submission !== undefined && submission.revision !== revision;
  const ran = result !== undefined || error !== "";
  const viewRef = useFadeInOnChange<HTMLDivElement>(shown);
  const beforeFirstRun = firstRun !== undefined && runs.length === 0;
  const firstRunStatus = beforeFirstRun && !running ? firstRun.status : undefined;
  const settledPill = !running && !firstRunStatus ? settledOutcome : undefined;
  const compared = comparison && !running && comparison.result === result ? comparison : undefined;
  const pill: RunPillProps = running
    ? { short: toSentenceCase(progress), full: toSentenceCase(progress), running: true, startedAt }
    : firstRun && firstRunStatus
      ? firstRunPills[firstRun.status.state]
      : settledPill && compared
        ? {
            short: compared.runLabel,
            full: compared.runLabel,
            named: true,
            durationMs,
            tone: compared.earlier ? undefined : settledPill,
          }
        : settledPill
          ? {
              short: getRunOutcomeMark(settledPill),
              full: getRunOutcomeLabel(settledPill),
              durationMs: settledPill === "cancelled" ? undefined : durationMs,
              tone: settledPill,
            }
          : { short: toSentenceCase(progress), full: toSentenceCase(progress) };
  const plans = running ? undefined : result?.queryPlans;
  const heldRun = running ? runs.find((run) => run.number === shown) : undefined;
  const tabCounts = heldRun ? countTimeline(buildRunTimeline(heldRun.result, heldRun.error || undefined)) : counts;
  const tabPlans = heldRun ? heldRun.result?.queryPlans : plans;
  const planNotice = ran && !running && needsPlannedRun(queryPlans, submission?.queryPlans);
  const agent = submission?.startedBy;
  const startedByLabel =
    agent !== undefined
      ? running
        ? `Running for ${agent}`
        : `Started by ${agent}`
      : chatRuns && submission && !running
        ? "Started by you"
        : undefined;
  const showInLogs = (statements: readonly SqlEvent[]) => {
    setLogs({ filter: "sql", open: statements.map((statement) => getLogRowId(statement)) });
    setTab("logs");
  };

  useTabAfterRun({ tab, views, onTabChange: setTab });

  return (
    <section
      className={cn(
        "@container relative flex h-full min-h-0 flex-col overflow-clip rounded-lg border border-border bg-panel max-phone:rounded-none max-phone:border-0",
        !framed && "rounded-none border-0",
      )}
      aria-label={label === undefined ? "Execution output" : `${label} output`}
      data-guide="output"
    >
      <Segmented
        className="flex min-h-0 flex-1 flex-col"
        value={visibleTab}
        onValueChange={(value) => {
          const picked = readOutputTab(value);

          if (picked) {
            setTab(picked);
          }
        }}
      >
        <div
          className={cn(
            "flex min-h-12 min-w-0 shrink-0 flex-nowrap items-center gap-2 border-b border-border bg-surface px-2.5 max-phone:min-h-0 max-phone:flex-wrap max-phone:gap-0 max-phone:p-0",
            stacked.row,
            !bar && !(runPicker || settings) && "hidden",
          )}
          data-slot="output-bar"
        >
          <SegmentedList
            aria-label={label === undefined ? "Output views" : `${label} output`}
            indicatorClassName="rounded-base bg-surface-2 shadow-none max-phone:rounded-pill max-phone:bg-segment"
            className={cn(
              "max-w-full min-w-0 shrink scrollbar-none gap-0.5 overflow-x-auto rounded-[10px] bg-transparent p-0.75 max-phone:max-w-none max-phone:shrink-0 max-phone:basis-full max-phone:gap-1.5 max-phone:rounded-none max-phone:px-3 max-phone:pt-1.25 max-phone:pb-2.5 [&::-webkit-scrollbar]:hidden",
              stacked.tabs,
              !bar && "hidden",
            )}
          >
            {[...views, ...(debug ? ["debug" as const] : [])].map((item) => (
              <SegmentedItem
                key={item}
                value={item}
                className={cn(
                  "inline-flex h-7.5 items-center rounded-base px-2.75 py-0 text-[13px] font-medium text-muted data-active:text-text max-phone:relative max-phone:h-9 max-phone:min-w-11 max-phone:shrink-0 max-phone:rounded-pill max-phone:border max-phone:border-border max-phone:px-3 max-phone:py-0 max-phone:after:absolute max-phone:after:inset-x-0 max-phone:after:-inset-y-1.25 max-phone:data-active:border-segment max-phone:data-active:text-segment-fg",
                  stacked.tab,
                )}
              >
                {tabLabels[item]}
                {item !== "story" && item !== "debug" && tabCounts[item] > 0 && (
                  <CountChip tab={item} held={heldRun !== undefined}>
                    {tabCounts[item]}
                  </CountChip>
                )}
                {item === "logs" && tabPlans && (
                  <PlansTabMark report={tabPlans} className={cn("ml-1.5", heldRun && "opacity-40")} />
                )}
              </SegmentedItem>
            ))}
          </SegmentedList>
          <div
            className={cn(
              "ml-auto flex min-w-0 shrink-100 items-center gap-2 max-phone:ml-0 max-phone:basis-full max-phone:border-t max-phone:border-border max-phone:px-3 max-phone:py-1.5",
              stacked.cluster,
              !bar && "max-phone:border-t-0",
            )}
          >
            {bar && <RunPill {...pill} steady={beforeFirstRun} />}
            {bar && startedByLabel && (
              <span className="min-w-0 truncate text-[12px] text-muted max-phone:hidden">{startedByLabel}</span>
            )}
            {(runPicker || settings) && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {runPicker && (
                  <RunHistoryMenu
                    runs={runs}
                    shown={shown}
                    disabled={running}
                    onView={(run) => actor.selectHistoryEntry(run)}
                  />
                )}
                {settings && <OutputSettings {...settings} />}
              </div>
            )}
          </div>
        </div>
        {runPicker && (
          <OlderRunNote
            key={shown}
            runs={runs}
            shown={running ? undefined : shown}
            onView={(run) => actor.selectHistoryEntry(run)}
          />
        )}
        {stale && !running && !compared?.earlier && (
          <p className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-pill border border-border bg-surface px-3 py-1 text-[12px] whitespace-nowrap text-muted shadow-[var(--shadow-pop)]">
            Edited since this run.
          </p>
        )}
        {views.map((filter) => {
          const rows = filterTimeline(entries, filter, result);
          const dotted = filter !== "logs" || firstRunStatus !== undefined;
          const listed = !dotted && ran && (rows.length > 0 || filter === "logs");

          return (
            <SegmentedPanel
              key={filter}
              ref={viewRef}
              value={filter}
              className={cn(
                scrollClass,
                !firstRunStatus && viewMotionClass,
                dotted ? cn(dotGrid, "py-0") : listed ? phoneRows : phoneDotGrid,
                filter === "logs" && listed && "pt-0 pb-0 max-phone:bg-panel",
                "max-phone:py-0",
              )}
            >
              {firstRun && firstRunStatus ? (
                <FirstRunCard
                  status={firstRunStatus}
                  dialect={firstRun.dialect}
                  compact={firstRun.compact}
                  stacked={firstRun.stacked}
                  onRun={firstRun.onRun}
                  canRun={firstRun.canRun}
                />
              ) : !ran ? (
                <div className="flex flex-1 flex-col p-3">
                  {running ? (
                    <RunningNote />
                  ) : (
                    <OutputEmpty title="Output shows up here">
                      Each run lists its SQL, console lines and results in the order they happened. Use{" "}
                      <code>$.display("Users", rows)</code> to add a labelled result.
                    </OutputEmpty>
                  )}
                </div>
              ) : filter === "logs" ? (
                <>
                  {planNotice && queryPlans && (
                    <PlansNotice
                      flag={queryPlans}
                      planned={submission?.queryPlans}
                      onRun={firstRun?.onRun}
                      canRun={firstRun?.canRun}
                    />
                  )}
                  <div className={cn("contents", planNotice && queryPlans && "max-phone:hidden")}>
                    <LogsView
                      rows={rows}
                      counts={counts}
                      state={logs}
                      onStateChange={setLogs}
                      entrypoints={submission?.manifest.entrypoints}
                      failed={settledOutcome === "failed"}
                      plans={plans}
                      onDiagnostic={onDiagnostic}
                    />
                  </div>
                </>
              ) : rows.length === 0 ? (
                settledOutcome === "failed" && failedNotes[filter] ? (
                  <EmptyNote>{failedNotes[filter]}</EmptyNote>
                ) : filter === "results" ? (
                  <div className="flex flex-1 flex-col p-3">
                    <ResultsEmpty />
                  </div>
                ) : (
                  <EmptyNote>{emptyNotes[filter]}</EmptyNote>
                )
              ) : filter === "results" ? (
                <div
                  className="flex flex-col gap-4 p-4.5 max-phone:gap-2.5 max-phone:px-3 max-phone:py-3.5"
                  data-slot="result-cards"
                >
                  {rows.map((entry) => {
                    if (entry.kind !== "result") {
                      return undefined;
                    }

                    const statements = getResultStatements(entries, entry);

                    return (
                      <ResultCard
                        key={entry.key}
                        label={entry.label}
                        values={entry.values}
                        source={
                          entry.source === undefined ? undefined : (
                            <RowSource
                              phase="run"
                              source={entry.source}
                              line={entry.line}
                              entrypoints={submission?.manifest.entrypoints}
                              onDiagnostic={onDiagnostic}
                            />
                          )
                        }
                        statements={statements}
                        onShowInLogs={views.includes("logs") ? () => showInLogs(statements) : undefined}
                        change={compared?.changes?.displays.find((display) => display.label === entry.label)}
                        compareLabel={compared?.compareLabel}
                        highlighted={entry.label !== undefined && highlightedDisplays?.includes(entry.label) === true}
                      />
                    );
                  })}
                </div>
              ) : (
                <OutputTimeline
                  rows={rows}
                  filter={filter}
                  entrypoints={submission?.manifest.entrypoints}
                  dialect={submission?.manifest.target.dialect}
                  onDiagnostic={onDiagnostic}
                />
              )}
            </SegmentedPanel>
          );
        })}
        {debug && (
          <SegmentedPanel value="debug" className={cn(scrollClass, "py-0 max-phone:bg-surface")}>
            <DebugReport context={state} running={running} />
          </SegmentedPanel>
        )}
      </Segmented>
    </section>
  );
}
