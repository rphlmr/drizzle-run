import type { Diagnostic, RunResult } from "@drizzle-run/core/contracts";
import { RUN_ERROR_DIAGNOSTIC_CODE } from "@drizzle-run/core/contracts";
import type { RunLanding } from "@drizzle-run/orchestration";
import * as z from "zod/mini";

const OutputTabSchema = z.enum(["results", "story", "logs", "problems", "debug"]);

/** A view of the output panel. */
export type OutputTab = z.output<typeof OutputTabSchema>;

/** The output opens on Results; Story is a tab to pick, never the default. */
export const DEFAULT_OUTPUT_TAB: OutputTab = "results";

/** A tab name from storage or a link, or undefined when it names no tab. */
export function readOutputTab(value: unknown): OutputTab | undefined {
  const parsed = OutputTabSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

/**
 * Where the output goes when a run settles, given where the run machine says it
 * lands. A failed run opens Problems. A successful run leaves Problems for
 * Results and keeps any other tab the reader picked. A cancelled run lands
 * nowhere and changes nothing.
 */
export function getTabAfterRun(landing: RunLanding | undefined, current: OutputTab): OutputTab {
  if (landing === "problems") {
    return "problems";
  }

  if (landing === "results" && current === "problems") {
    return "results";
  }

  return current;
}

/**
 * The tab to show when a panel offers only some views, such as the embed's Results, Story and Logs: a
 * missing view falls back to Story, which lists everything, a failed run's error included.
 */
export function getOfferedTab(tab: OutputTab, views: readonly OutputTab[]): OutputTab {
  if (tab === "debug" || views.includes(tab)) {
    return tab;
  }

  return views.includes("story") ? "story" : (views[0] ?? DEFAULT_OUTPUT_TAB);
}

/** A run's diagnostics and its error, if any. */
export interface RunProblems {
  /** The diagnostic that locates the run error in source, shown on the error's card. */
  errorLocation: Diagnostic | undefined;
  /** Diagnostics left after the located run error is folded into its card. */
  diagnostics: readonly Diagnostic[];
}

/** Collects a run's problems; none before the first run. */
export function getRunProblems(result: Pick<RunResult, "diagnostics" | "error"> | undefined): RunProblems {
  const diagnostics = result?.diagnostics ?? [];
  const errorLocation = result?.error
    ? (diagnostics.find((diagnostic) => diagnostic.code === RUN_ERROR_DIAGNOSTIC_CODE) ??
      (result.error.phase === "compile"
        ? diagnostics.find(
            (diagnostic) => diagnostic.severity === "error" && diagnostic.message === result.error?.message,
          )
        : undefined))
    : undefined;

  return {
    errorLocation,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic !== errorLocation),
  };
}

const outcomeLabels: Record<RunResult["outcome"], string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** "92 ms" under a second, "1.3 s" above. */
export function formatRunDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

/** The run pill's outcome; the pill sets the duration beside it, so screenshots can hide it alone. */
export function getRunOutcomeLabel(outcome: RunResult["outcome"]): string {
  return outcomeLabels[outcome];
}

const outcomeMarks: Record<RunResult["outcome"], string> = {
  succeeded: "✓",
  failed: "✕",
  cancelled: "Cancelled",
};

/**
 * The run pill's short text, "✓ 1.3 s" or "✕ 92 ms", so the output bar keeps its tabs on one row. The pill's title
 * and screen reader text keep the full label from `getRunOutcomeLabel`.
 */
export function getRunOutcomeMark(outcome: RunResult["outcome"]): string {
  return outcomeMarks[outcome];
}

/** How long ago a run settled, in the run picker: "now", "2 min ago", "1 h ago". */
export function formatRunAge(settledAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - settledAt) / 60_000);

  if (minutes < 1) {
    return "now";
  }

  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

/** One line on what a run produced: its first result and row count, or why it failed. */
export function summarizeRun(run: {
  result: Pick<RunResult, "outcome" | "displays" | "error"> | undefined;
  error: string;
}): string {
  const { result } = run;

  if (!result) {
    return run.error || "The run failed";
  }

  if (result.outcome === "cancelled") {
    return "Cancelled";
  }

  if (result.outcome === "failed") {
    return result.error?.message ?? "The run failed";
  }

  const [first] = result.displays;

  if (!first) {
    return "Nothing displayed";
  }

  const [value] = first.values;
  const rows =
    first.values.length === 1 && value?.type === "array"
      ? ` · ${value.value.length === 1 ? "1 row" : `${value.value.length} rows`}`
      : "";
  const more = result.displays.length > 1 ? ` and ${result.displays.length - 1} more` : "";

  return `${first.label}${rows}${more}`;
}
