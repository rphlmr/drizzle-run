import type { Diagnostic, QueryPlansSettings } from "@drizzle-run/core/contracts";
import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { useRunInProgress, useRunSelector } from "@drizzle-run/react";
import { useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { FirstRunCard, type FirstRunStatus } from "../ui/first-run-card";
import { DEFAULT_LOGS_STATE, LogsView, type LogsState } from "../ui/logs-view";
import { formatRunDuration } from "../ui/output-tab";
import { OutputTimeline } from "../ui/output-timeline";
import { needsPlannedRun } from "../ui/query-plans";
import { PlansLegend, PlansNotice } from "../ui/query-plans-view";
import { ResultCard } from "../ui/results";
import { RunningDot, RunningDuration, RunningNote } from "../ui/run-loader";
import { buildRunTimeline, countTimeline, filterTimeline, type TimelineFilter } from "../ui/run-timeline";

/**
 * An output view for one side. Problems and Debug depend on the run's contents. Embeds also offer Story.
 */
export type SideTab = TimelineFilter | "debug";

const sideViews = ["results", "logs"] as const satisfies readonly TimelineFilter[];

export const sideTabLabels: Record<SideTab, string> = {
  results: "Results",
  story: "Story",
  logs: "Logs",
  problems: "Problems",
  debug: "Debug",
};

/** What a side's pane head says about its run. */
export interface SidePill {
  label: string;
  /** The run's time, such as "1.2 s"; the screenshot suite hides it since it changes between runs. */
  duration?: string;
  tone: "idle" | "running" | "ok" | "err";
  /** When the going run started, as the run machine's `startedAt`. */
  startedAt?: number;
}

const pillTones: Record<SidePill["tone"], string> = {
  idle: "bg-surface-2 text-muted",
  running: "bg-mark text-text",
  ok: "bg-ok-bg text-ok",
  err: "bg-err-bg text-err",
};

/**
 * The side's run as the pane draws it: running, waiting for the other side, or its last outcome. Reads the run
 * machine of the closest `RunProvider`, one per side.
 */
function useSideRun() {
  const running = useRunInProgress();
  const context = useRunSelector((state) => state);
  const { result, error, durationMs, submission } = context;
  const outcome = result?.outcome ?? (error ? "failed" : undefined);
  const entries = buildRunTimeline(result, error || undefined);

  return {
    running,
    context,
    result,
    error,
    durationMs,
    submission,
    outcome,
    entries,
    counts: countTimeline(entries),
    ran: !running && outcome !== undefined,
    debug: submission?.debug ?? false,
  };
}

/** A side's run as its output pane shows it. */
export type SideRun = ReturnType<typeof useSideRun>;

/** The status pill of a side: running, preparing, or how its last run ended. */
function getSidePill(run: SideRun, preparing: string | undefined): SidePill {
  if (run.running) {
    return { label: "Running", tone: "running", startedAt: run.context.startedAt };
  }

  const duration = run.durationMs === undefined ? undefined : formatRunDuration(run.durationMs);

  if (run.outcome === "succeeded") {
    return { label: "✓", duration, tone: "ok" };
  }

  if (run.outcome === "failed") {
    return { label: "Failed", duration, tone: "err" };
  }

  if (run.outcome === "cancelled") {
    return { label: "Cancelled", tone: "idle" };
  }

  return { label: preparing ?? "Not run yet", tone: "idle" };
}

/**
 * The side's run and its status pill, from the closest `RunProvider`.
 *
 * @param preparing - What the pill says before a first run while the side's runtime is not ready, such as
 * "Preparing"; undefined once it is.
 */
export function useSideStatus(preparing: string | undefined): { run: SideRun; pill: SidePill } {
  const run = useSideRun();

  return { run, pill: getSidePill(run, preparing) };
}

/** Draws a side's status pill. */
export function SidePillChip({ pill, className }: { pill: SidePill; className?: string }) {
  return (
    <output
      data-side-pill=""
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-pill px-2 text-[11px] font-semibold whitespace-nowrap",
        pillTones[pill.tone],
        className,
      )}
    >
      {pill.tone === "running" && <RunningDot />}
      {pill.label}
      {pill.tone === "running" && <RunningDuration startedAt={pill.startedAt} />}
      {pill.duration !== undefined && (
        <span className="whitespace-pre" data-duration="">
          {pill.tone === "ok" ? " " : " · "}
          {pill.duration}
        </span>
      )}
    </output>
  );
}

/** The tabs a side offers: Results and Logs, Problems when the shown run has some, and Debug with traces. */
export function listSideTabs(run: SideRun): readonly SideTab[] {
  return [
    ...sideViews,
    ...(run.counts.problems > 0 ? (["problems"] as const) : []),
    ...(run.debug ? (["debug"] as const) : []),
  ];
}

/** A tab the side offers, or Results. */
export function getShownSideTab(tab: SideTab, run: SideRun): SideTab {
  return listSideTabs(run).includes(tab) ? tab : "results";
}

const emptyNotes: Record<Exclude<TimelineFilter, "logs">, string> = {
  results: "Nothing displayed on this side.",
  story: "Nothing ran on this side.",
  problems: "No problems on this side.",
};
/** After a failed run, an empty view says the error came first. */
const failedNotes: Partial<Record<TimelineFilter, string>> = {
  results: "No results: the run failed before $.display.",
};

/** Explain why a side's output is empty. */
export function SideNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 rounded-[12px] border border-dashed border-faint bg-surface px-5 py-7 text-center text-[13px] leading-[1.55] text-muted">
      {children}
    </p>
  );
}

/** Props of the body of a side's output: the run and the view to draw. */
export interface SideOutputBodyProps {
  run: SideRun;
  /** The view to draw: a side's tab, or the embed's Story. */
  tab: TimelineFilter;
  /** The side's release, which the loader names while its runtime starts. */
  short: string;
  /** Before the side's first run: the loader while its runtime prepares, as the one-version output shows it. */
  firstRun?: { status: FirstRunStatus; dialect: RunManifestTarget["dialect"] };
  /**
   * The Query plans flag as the next run will submit it. On while the shown run was planned differently, Logs says
   * the next run plans them.
   */
  queryPlans?: QueryPlansSettings;
  onDiagnostic: (diagnostic: Diagnostic) => void;
}

/** One view of a side's output: its result cards, story, logs or problems. */
export function SideOutputBody({ run, tab, short, firstRun, queryPlans, onDiagnostic }: SideOutputBodyProps) {
  const [logs, setLogs] = useState<LogsState>(DEFAULT_LOGS_STATE);

  if (run.running) {
    return <RunningNote detail={`On a fresh ${short} runtime.`} />;
  }

  if (!run.ran) {
    return firstRun ? (
      <FirstRunCard compact status={firstRun.status} dialect={firstRun.dialect} />
    ) : (
      <SideNote>Not run yet</SideNote>
    );
  }

  const rows = filterTimeline(run.entries, tab, run.result);
  const plans = run.result?.queryPlans;
  const planNotice =
    tab === "logs" && queryPlans !== undefined && needsPlannedRun(queryPlans, run.submission?.queryPlans) ? (
      <PlansNotice flag={queryPlans} planned={run.submission?.queryPlans} />
    ) : undefined;

  if (tab === "logs") {
    return (
      <>
        {planNotice}
        <LogsView
          compact
          rows={rows}
          counts={run.counts}
          state={logs}
          onStateChange={setLogs}
          entrypoints={run.submission?.manifest.entrypoints}
          failed={run.outcome === "failed"}
          plans={plans}
          onDiagnostic={onDiagnostic}
        />
        {plans && <PlansLegend report={plans} />}
      </>
    );
  }

  if (rows.length === 0) {
    return <SideNote>{(run.outcome === "failed" && failedNotes[tab]) || emptyNotes[tab]}</SideNote>;
  }

  if (tab === "results") {
    return (
      <>
        {rows.map(
          (entry) =>
            entry.kind === "result" && (
              <ResultCard
                key={entry.key}
                compact
                label={entry.label}
                values={entry.values}
                statements={[]}
                source={
                  entry.source === undefined ? undefined : (
                    <button
                      type="button"
                      className="border-0 bg-transparent p-0 font-mono text-[11px] text-accent-text underline"
                      onClick={() =>
                        onDiagnostic({
                          severity: "info",
                          message: "",
                          source: entry.source,
                          line: entry.line ?? 1,
                          column: 1,
                        })
                      }
                    >
                      {entry.line === undefined ? entry.source : `${entry.source}:${entry.line}`}
                    </button>
                  )
                }
              />
            ),
        )}
      </>
    );
  }

  return (
    <OutputTimeline
      rows={rows}
      filter={tab}
      entrypoints={run.submission?.manifest.entrypoints}
      dialect={run.submission?.manifest.target.dialect}
      className="p-0 max-phone:p-0"
      onDiagnostic={onDiagnostic}
    />
  );
}
