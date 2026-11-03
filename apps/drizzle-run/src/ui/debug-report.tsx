import type { RunState } from "@drizzle-run/orchestration";
import { CheckIcon, ChevronRightIcon, CopyIcon, DownloadIcon, LayersIcon, XIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useCopyFeedback } from "./clipboard";
import { Hint } from "./hint";
import { formatRunDuration } from "./output-tab";
import { download } from "./results";
import {
  buildPhaseWaterfall,
  buildRawReport,
  collectReportFacts,
  getRunLibraries,
  formatBytes,
  getStateRows,
  type PhaseBar,
} from "./run-report";

type RunContext = RunState;

const copyLabels = {
  idle: "Copy JSON",
  copied: "Copied",
  failed: "Couldn't copy",
} as const;

const stateTones: Record<string, string> = {
  running: "bg-mark text-ok",
  succeeded: "bg-ok-bg text-ok",
  failed: "bg-err-bg text-err",
};

const labelClass = cn("text-[10.5px] font-bold tracking-[0.06em] text-muted uppercase");

/** An uppercase label, a rule, and an optional note at the right. */
function SectionLabel({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <h3 className={cn(labelClass, "m-0 flex items-center gap-2")}>
      {children}
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      {note !== undefined && (
        <span className="text-[10.5px] font-medium tracking-normal normal-case" data-varies="">
          {note}
        </span>
      )}
    </h3>
  );
}

const phaseGrid =
  "grid grid-cols-[132px_minmax(0,1fr)_46px] items-center gap-x-2.5 max-phone:grid-cols-[124px_minmax(0,1fr)_40px] max-phone:gap-x-2";

function PhaseRow({ bar, scaleMs }: { bar: PhaseBar; scaleMs: number }) {
  const failed = bar.status === "failed" || bar.status === "cancelled";

  return (
    <li className={cn(phaseGrid, "h-5.25")} data-slot="phase" data-phase={bar.phase} data-slow={bar.slow || undefined}>
      <span className="truncate font-mono text-[11.5px] text-muted max-phone:text-[10.5px]">{bar.phase}</span>
      <span className="relative h-2.5 rounded-pill bg-surface-2" aria-hidden="true">
        {bar.durationMs !== undefined && (
          <span
            className={cn(
              "absolute inset-y-0 min-w-0.75 rounded-pill",
              failed ? "bg-err" : bar.slow ? "bg-progress" : "bg-faint",
            )}
            style={{ left: `${(bar.startMs / scaleMs) * 100}%`, width: `${(bar.durationMs / scaleMs) * 100}%` }}
            data-varies=""
          />
        )}
      </span>
      <span
        className={cn(
          "text-right font-mono text-[11.5px] whitespace-nowrap max-phone:text-[10.5px]",
          bar.slow && "font-semibold",
          bar.durationMs === undefined && "text-faint",
        )}
      >
        {bar.durationMs === undefined ? (
          bar.status === "skipped" ? (
            "skipped"
          ) : (
            "–"
          )
        ) : (
          <span data-duration="">{bar.durationMs < 1 ? "<1" : Math.round(bar.durationMs)} ms</span>
        )}
      </span>
    </li>
  );
}

export interface DebugReportProps {
  context: RunContext;
  running: boolean;
}

/** How Drizzle Run itself ran this project: facts, its phases on a time axis, its machine states, and the raw JSON. */
export function DebugReport({ context, running }: DebugReportProps) {
  const { result, error, submission, states, events, durationMs, history: runs, selectedHistoryEntry: shown } = context;
  const { outcome, copy } = useCopyFeedback();
  const manifest = submission?.manifest;
  const raw = useMemo(
    () => buildRawReport({ states, events, result, libraries: getRunLibraries({ result, manifest }) }),
    [states, events, result, manifest],
  );
  const json = useMemo(() => JSON.stringify(raw, null, 2), [raw]);
  const size = useMemo(() => new Blob([json]).size, [json]);
  const waterfall = result && buildPhaseWaterfall(result.phases, result.timings);
  const rows = getStateRows(states);
  const runNumber = running ? (runs.at(-1)?.number ?? 0) + 1 : shown;
  const facts = collectReportFacts({
    result,
    manifest,
    events: events.length,
    userAgent: navigator.userAgent,
    isolated: globalThis.crossOriginIsolated,
  });
  const copyLabel = copyLabels[outcome ?? "idle"];

  return (
    // Relative keeps the Copy announcement inside the output's scroll area.
    <div className="relative flex flex-col gap-3.5 px-4 py-3.5 max-phone:px-3" data-slot="debug-report">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
        <h2 className="m-0 font-display text-[17px] font-[750]">Drizzle Run report</h2>
        <span className="text-[11.5px] text-muted">
          {runNumber !== undefined && <>Run {runNumber}</>}
          {running
            ? " · running"
            : durationMs !== undefined && (
                <>
                  {" "}
                  · <span data-duration="">{formatRunDuration(durationMs)}</span>
                </>
              )}
        </span>
        <div className="ml-auto flex gap-2 max-phone:ml-0 max-phone:basis-full">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "gap-1.5 text-[12px] max-phone:min-h-touch max-phone:flex-1 [&_svg]:size-3.25",
              outcome === "failed" && "text-err",
            )}
            onClick={() => copy(json)}
          >
            {outcome === "copied" ? (
              <CheckIcon aria-hidden="true" />
            ) : outcome === "failed" ? (
              <XIcon aria-hidden="true" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
            {copyLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-[12px] max-phone:min-h-touch max-phone:flex-1 [&_svg]:size-3.25"
            onClick={() => download("drizzle-run-debug.json", { run: runNumber, ...raw, result, error })}
          >
            <DownloadIcon aria-hidden="true" />
            Download report
          </Button>
        </div>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {outcome ? copyLabel : ""}
        </span>
      </header>
      <div
        className="flex gap-2.5 rounded-md bg-surface-2 px-3 py-2.5 text-[12.5px] leading-normal text-muted [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0"
        role="note"
      >
        <LayersIcon aria-hidden="true" />
        <span>
          <b className="font-semibold text-text">How Drizzle Run itself prepared and ran this project.</b> Attach it to
          a playground bug report. Your queries and database are in Logs and Problems.
        </span>
      </div>
      <dl className="m-0 grid grid-cols-2 overflow-hidden rounded-[12px] border border-border">
        {facts.map((fact, index) => (
          <div
            key={fact.label}
            className={cn(
              "flex min-w-0 flex-col gap-0.75 px-3 py-2.25",
              index % 2 === 1 && "border-l border-border",
              index > 1 && "border-t border-border",
              fact.width === "full" && "col-span-2",
            )}
          >
            <dt className={labelClass}>{fact.label}</dt>
            {fact.width === "full" ? (
              <dd className="m-0 font-mono text-[12px] wrap-break-word" data-varies={fact.varies || undefined}>
                {fact.value}
              </dd>
            ) : (
              <Hint content={fact.value}>
                <dd
                  className="m-0 truncate font-mono text-[12px] max-phone:text-clip max-phone:whitespace-normal"
                  data-varies={fact.varies || undefined}
                >
                  {fact.value}
                </dd>
              </Hint>
            )}
          </div>
        ))}
      </dl>
      <section className="flex flex-col gap-2" aria-label="Drizzle Run phases">
        <SectionLabel note={waterfall?.summary}>Drizzle Run phases</SectionLabel>
        {waterfall ? (
          <>
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {waterfall.bars.map((bar) => (
                <PhaseRow key={bar.phase} bar={bar} scaleMs={waterfall.scaleMs} />
              ))}
            </ol>
            <div className={cn(phaseGrid, "font-mono text-[10.5px] text-faint")} aria-hidden="true">
              <span />
              <span className="relative h-3.5" data-varies="">
                {waterfall.ticks.map((tick) => (
                  <i
                    key={tick.ms}
                    className={cn(
                      "absolute whitespace-nowrap not-italic",
                      tick.ms > 0 && (tick.percent > 90 ? "-translate-x-full" : "-translate-x-1/2"),
                    )}
                    style={{ left: `${tick.percent}%` }}
                  >
                    {tick.label}
                  </i>
                ))}
              </span>
              <span />
            </div>
          </>
        ) : (
          <p className="m-0 text-[12.5px] text-muted">
            {running ? "The phases show when the run settles." : "This run returned no phases."}
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2" aria-label="Run machine states">
        <SectionLabel note={`${states.length} ${states.length === 1 ? "transition" : "transitions"} in Drizzle Run`}>
          Run machine states
        </SectionLabel>
        <div className="overflow-hidden rounded-[12px] border border-border">
          <table className="w-full table-fixed border-collapse font-mono text-[11.5px] leading-[1.4]">
            <colgroup>
              <col className="w-11.5" />
              <col className="w-16.5" />
              <col className="w-25.5" />
              <col />
            </colgroup>
            <thead className="bg-surface-2 text-muted">
              <tr>
                {["#", "at", "state", "phase"].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-1.25 text-left font-medium first:pr-0">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.index} className="border-t border-border">
                  <td className="px-3 py-1.25 pr-0">{row.index}</td>
                  <td className="px-3 py-1.25 whitespace-nowrap">
                    <span data-duration="">{Math.round(row.atMs)} ms</span>
                  </td>
                  <td className="px-3 py-1.25">
                    <span
                      className={cn(
                        "inline-flex h-4.5 items-center rounded-pill px-1.75 font-sans text-[11px] font-semibold",
                        stateTones[row.state] ?? "bg-surface-2 text-muted",
                      )}
                    >
                      {row.state}
                    </span>
                  </td>
                  <td className="truncate px-3 py-1.25 text-muted">{row.phase}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="flex flex-col gap-2" aria-label="Report JSON">
        <SectionLabel>Report JSON</SectionLabel>
        <details className="group rounded-[12px] border border-border">
          <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12.5px] [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.25 shrink-0 text-muted group-open:rotate-90" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono text-[12px]">{Object.keys(raw).join(", ")}</span>
            <span className="ml-auto shrink-0 text-[11.5px] text-muted">
              <span data-varies="">{formatBytes(size)}</span> · JSON
            </span>
          </summary>
          <pre className="max-h-120 overflow-auto border-t border-border px-3 py-2.5 text-[11.5px]">{json}</pre>
        </details>
      </section>
    </div>
  );
}
