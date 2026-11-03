import { resolveGuestFlavor, type CompanionLibrary } from "@drizzle-run/core/catalog";
import {
  EXECUTION_PHASES,
  PLANNING_ABANDONED_CLEANUP_REASON,
  type ExecutionPhase,
  type PhaseResult,
  type PhaseStatus,
  type PhaseTimings,
  type RunEvent,
  type RunResult,
  type RunSnapshot,
} from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";

import { listReleaseLibraries } from "./release-options";

const optInPhases: ReadonlySet<ExecutionPhase> = new Set(["plan"]);

/** A phase is slow when it takes at least this share of the run. */
export const SLOW_SHARE = 0.2;

/** One phase in the waterfall: where it starts and how long it took. */
export interface PhaseBar {
  phase: ExecutionPhase;
  /** "not_run" when the run never reached the phase. */
  status: PhaseStatus | "not_run";
  /** From the first phase's start. */
  startMs: number;
  durationMs: number | undefined;
  slow: boolean;
}

/** A round time marked on the waterfall's axis. */
export interface AxisTick {
  ms: number;
  label: string;
  /** Position on the track, 0 to 100. */
  percent: number;
}

/** The phases of a run laid out on one time scale. */
export interface PhaseWaterfall {
  bars: PhaseBar[];
  /** The track's length: the run's total time, or the end of its last phase when that is later. */
  scaleMs: number;
  ticks: AxisTick[];
  /**
   * "compile and open_database take 69%", and "286 ms between phases" when time outside the phases
   * (a fresh guest starting, messages between workers) is a large share; undefined when neither applies.
   */
  summary: string | undefined;
}

/** "92 ms" under a second, "1.5 s" above. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

/** A round step that cuts the scale into two to five parts: 1, 2 or 5 times a power of ten. */
function getAxisStep(scaleMs: number): number {
  const rough = scaleMs / 3;
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));

  return [1, 2, 5, 10].map((factor) => factor * power).find((step) => step >= rough) ?? 10 * power;
}

/** "a", "a and b", "a, b and c". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Place execution phases on one time axis, including optional phases when reached. Each bar starts where the runtime
 * started the phase. A phase with no start time follows the one before it. Unreached required phases keep an empty row.
 */
export function buildPhaseWaterfall(phases: readonly PhaseResult[], timings: PhaseTimings): PhaseWaterfall {
  const byPhase = new Map(phases.map((phase) => [phase.phase, phase]));
  const starts = phases
    .flatMap((phase) => (phase.startedAt === undefined ? [] : [Date.parse(phase.startedAt)]))
    .filter(Number.isFinite);
  const origin = starts.length > 0 ? Math.min(...starts) : 0;
  let cursor = 0;

  const reached = EXECUTION_PHASES.filter(
    (phase) => !optInPhases.has(phase) || byPhase.has(phase) || timings[phase] !== undefined,
  );
  const placed = reached.map((phase) => {
    const result = byPhase.get(phase);
    const durationMs = result?.durationMs ?? timings[phase];
    const started = result?.startedAt === undefined ? Number.NaN : Date.parse(result.startedAt) - origin;
    const startMs = Number.isFinite(started) ? Math.max(0, started) : cursor;

    if (durationMs !== undefined) {
      cursor = Math.max(cursor, startMs + durationMs);
    }

    return { phase, status: result?.status ?? "not_run", startMs, durationMs } as const;
  });
  const total = timings.total ?? cursor;
  const scaleMs = Math.max(total, cursor, 1);
  const bars = placed.map((bar): PhaseBar => ({
    ...bar,
    slow: bar.durationMs !== undefined && total > 0 && bar.durationMs / total >= SLOW_SHARE,
  }));
  const slow = bars.filter((bar) => bar.slow);
  const share = Math.round((slow.reduce((sum, bar) => sum + (bar.durationMs ?? 0), 0) / Math.max(total, 1)) * 100);
  const between = Math.max(0, total - bars.reduce((sum, bar) => sum + (bar.durationMs ?? 0), 0));
  const summary = [
    slow.length > 0 && `${listNames(slow.map((bar) => bar.phase))} ${slow.length === 1 ? "takes" : "take"} ${share}%`,
    total > 0 && between / total >= SLOW_SHARE && `${formatMs(between)} between phases`,
  ].filter((part) => part !== false);
  const step = getAxisStep(scaleMs);
  const ticks: AxisTick[] = [];

  for (let ms = 0; ms <= scaleMs; ms += step) {
    ticks.push({ ms, label: ms === 0 ? "0" : formatMs(ms), percent: (ms / scaleMs) * 100 });
  }

  return {
    bars,
    scaleMs,
    ticks,
    summary: summary.length > 0 ? summary.join(" · ") : undefined,
  };
}

/** A run machine snapshot where the state or the phase changed. */
export interface StateRow {
  /** The snapshot's place among every snapshot the run machine sent. */
  index: number;
  atMs: number;
  state: string;
  phase: ExecutionPhase | undefined;
}

/** The run machine's snapshots, keeping only those where the state or the phase changed. */
export function getStateRows(states: readonly RunSnapshot[]): StateRow[] {
  const rows: StateRow[] = [];

  states.forEach((snapshot, index) => {
    const previous = rows.at(-1);

    if (previous && previous.state === snapshot.state && previous.phase === snapshot.phase) {
      return;
    }

    rows.push({ index, atMs: snapshot.elapsedMs, state: snapshot.state, phase: snapshot.phase });
  });

  return rows;
}

/** "Chrome 141", "Safari 26.0", "Firefox 144", from a user agent string. */
export function getBrowserName(userAgent: string): string {
  const patterns: [RegExp, string][] = [
    [/Edg\/(\d+)/, "Edge"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+(?:\.\d+)?).*Safari\//, "Safari"],
  ];

  for (const [pattern, name] of patterns) {
    const version = pattern.exec(userAgent)?.[1];

    if (version !== undefined) {
      return `${name} ${version}`;
    }
  }

  return "Unknown browser";
}

/** "812 B", "48 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A labelled fact of the report; `varies` marks values that change between runs. */
export interface ReportFact {
  label: string;
  value: string;
  /** Differs between machines or runs of the same project, so screenshots hide it. */
  varies?: boolean;
  /** "full" takes a whole row and wraps, for a long value such as the library list. */
  width?: "half" | "full";
}

/** What the debug report's facts are read from: the run, the manifest and the browser. */
export interface FactsInput {
  result: Pick<RunResult, "tuple" | "cleanup" | "cleanupErrors"> | undefined;
  manifest: Pick<RunManifest, "target" | "dependencies" | "guestFlavor"> | undefined;
  events: number;
  userAgent: string;
  isolated: boolean;
}

const databases: Record<RunManifest["target"]["dialect"], string> = {
  postgresql: "PGlite · PostgreSQL",
  sqlite: "SQLite WASM · SQLite",
};

/**
 * List the libraries the run's Drizzle version ships besides Drizzle, such as zod or effect
 *
 * Reads the pair from the run's tuple, or from the submitted manifest while it runs, and the flavor from the manifest.
 * Empty when neither is known or the pair is no longer shipped.
 */
export function getRunLibraries({
  result,
  manifest,
}: Pick<FactsInput, "result" | "manifest">): readonly CompanionLibrary[] {
  const dialect = result?.tuple.target.dialect ?? manifest?.target.dialect;
  const ormVersion = result?.tuple.ormVersion ?? manifest?.dependencies["drizzle-orm"];
  const kitVersion = result?.tuple.kitVersion ?? manifest?.dependencies["drizzle-kit"];

  if (dialect === undefined || ormVersion === undefined || kitVersion === undefined) {
    return [];
  }

  return listReleaseLibraries({ dialect }, { ormVersion, kitVersion, guestFlavor: resolveGuestFlavor(manifest ?? {}) });
}

/** How the playground ran this project: its pair, its database and guest, the browser, and its own issues. */
export function collectReportFacts({ result, manifest, events, userAgent, isolated }: FactsInput): ReportFact[] {
  const orm = result?.tuple.ormVersion ?? manifest?.dependencies["drizzle-orm"];
  const kit = result?.tuple.kitVersion ?? manifest?.dependencies["drizzle-kit"];
  const dialect = result?.tuple.target.dialect ?? manifest?.target.dialect;
  const planningAbandoned =
    result?.cleanup.database.mode === "forced" && result.cleanup.database.reason === PLANNING_ABANDONED_CLEANUP_REASON;
  const forced = [
    result?.cleanup.guest.mode === "forced" && "guest",
    result?.cleanup.database.mode === "forced" && !planningAbandoned && "database",
  ].filter((item) => item !== false && item !== undefined);
  const errors = result?.cleanupErrors.length ?? 0;
  const issues = [
    errors > 0 && `${errors} cleanup ${errors === 1 ? "error" : "errors"}`,
    forced.length > 0 && `${forced.join(" and ")} stopped by force`,
    planningAbandoned && "database closed after query planning ran out of time",
  ].filter((item) => item !== false);
  const libraries = getRunLibraries({ result, manifest });

  return [
    { label: "Release pair", value: orm && kit ? `orm ${orm} · kit ${kit}` : "unknown" },
    { label: "Database", value: dialect ? databases[dialect] : "unknown" },
    { label: "Guest", value: "fresh · QuickJS" },
    {
      label: "Browser",
      value: `${getBrowserName(userAgent)} · ${isolated ? "isolated" : "not isolated"}`,
      varies: true,
    },
    { label: "Events", value: `${events} kept` },
    {
      label: "Runtime issues",
      value: result === undefined ? "still running" : issues.length > 0 ? issues.join(" · ") : "none",
    },
    {
      label: "Libraries",
      value:
        libraries.length > 0
          ? libraries.map(({ packageName, version }) => `${packageName} ${version}`).join(" · ")
          : "unknown",
      width: "full",
    },
  ];
}

/** What the debug report's raw JSON is built from. */
export interface RawReportInput {
  states: readonly RunSnapshot[];
  events: readonly RunEvent[];
  result: Pick<RunResult, "timings" | "sql" | "diagnostics"> | undefined;
  /** The libraries the run's Drizzle version ships, so a bug report says which zod or effect ran. */
  libraries: readonly CompanionLibrary[];
}

/** The report's raw JSON, as the Debug tab shows and copies it. */
export function buildRawReport({ states, events, result, libraries }: RawReportInput) {
  return {
    libraries: Object.fromEntries(libraries.map(({ packageName, version }) => [packageName, version])),
    states,
    timings: result?.timings,
    events,
    sql: result?.sql,
    diagnostics: result?.diagnostics,
  };
}
