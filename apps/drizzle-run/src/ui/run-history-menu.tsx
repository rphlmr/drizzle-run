import type { RunRecord } from "@drizzle-run/orchestration";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { formatRunAge, formatRunDuration, summarizeRun } from "./output-tab";

export interface RunHistoryMenuProps {
  runs: readonly RunRecord[];
  /** The run whose output shows; undefined before the first run. */
  shown: number | undefined;
  /** While a run is in flight the picker stays in place but cannot open. */
  disabled?: boolean;
  onView: (run: number) => void;
}

/** Drawn at 32 px (36 on phones) with a 44 px hit area; viewing an older run, it names it: "Run 3". */
const triggerClass = cn(
  "relative inline-flex size-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-[8px] border border-border bg-surface p-0 text-[12.5px] font-semibold whitespace-nowrap text-text after:absolute after:top-1/2 after:left-1/2 after:size-touch after:-translate-1/2 hover:bg-surface-2 disabled:opacity-60 data-popup-open:bg-surface-2 data-popup-open:shadow-[0_0_0_2px_var(--lime)] max-phone:size-9 max-phone:min-w-9 [&>svg]:size-3.5 max-phone:[&>svg]:size-3.75",
);

/**
 * The output bar's history button: the runs of this tab, newest first. Picking one shows its output again; the
 * editor keeps the current code. Before the first run the button keeps its place, hidden, so the bar does not move
 * when it appears.
 */
export function RunHistoryMenu({ runs, shown, disabled = false, onView }: RunHistoryMenuProps) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const latest = runs.at(-1)?.number;

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      setNow(Date.now());
    }

    setOpen(nextOpen);
  };

  if (shown === undefined || latest === undefined) {
    return (
      <button
        type="button"
        className={cn(triggerClass, "invisible")}
        aria-hidden="true"
        tabIndex={-1}
        disabled
        data-slot="run-picker"
      >
        <HistoryIcon aria-hidden="true" />
      </button>
    );
  }

  return (
    <Popover open={open && !disabled} onOpenChange={changeOpen}>
      <PopoverTrigger
        className={cn(triggerClass, shown !== latest && "w-auto bg-mark pr-2.5 pl-2 max-phone:w-auto")}
        disabled={disabled}
        title="Run history"
        aria-label={shown === latest ? "Run history" : `Run history, showing Run ${shown}`}
        data-slot="run-picker"
      >
        <HistoryIcon aria-hidden="true" />
        {shown !== latest && <span>Run {shown}</span>}
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-[12px] border-[1.5px] border-card-border p-0 shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
        align="end"
      >
        <div className="flex items-baseline gap-2 px-3.5 pt-3 pb-2">
          <PopoverTitle className="text-[13.5px] font-[650]">Runs in this tab</PopoverTitle>
          <span className="text-[12px] text-muted">{runs.length === 1 ? "1 run" : `${runs.length} runs`}</span>
        </div>
        <ul
          className="m-0 flex max-h-[min(360px,60vh)] list-none flex-col gap-0.5 overflow-auto px-1.5 pb-1.5"
          aria-label="Pick a run to see its output"
        >
          {runs.toReversed().map((run) => {
            const failed = (run.result?.outcome ?? "failed") === "failed";

            return (
              <li key={run.number}>
                <button
                  type="button"
                  className={cn(
                    "grid min-h-touch w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-base border-0 px-2.5 py-2 text-left text-text",
                    run.number === shown ? "bg-mark" : "bg-transparent hover:bg-surface-2",
                  )}
                  aria-current={run.number === shown ? "true" : undefined}
                  onClick={() => {
                    onView(run.number);
                    setOpen(false);
                  }}
                >
                  <span className={cn("size-2 rounded-full", failed ? "bg-err" : "bg-ok")} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold">
                      Run {run.number}
                      <span className="font-normal text-muted"> · {formatRunAge(run.settledAt, now)}</span>
                    </span>
                    <span className={cn("block truncate text-[12px] text-muted", failed && "text-err")}>
                      {summarizeRun(run)}
                    </span>
                  </span>
                  {run.durationMs !== undefined && (
                    <span className={cn("font-mono text-[11px] text-muted", failed && "text-err")} data-duration="">
                      {formatRunDuration(run.durationMs)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="m-0 border-t border-border bg-surface-2 px-3.5 py-2.5 text-[12px] leading-normal text-muted">
          Picking a run shows its output, not its code. Runs stay until you close this tab; your files are saved as you
          type.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export interface OlderRunNoteProps {
  runs: readonly RunRecord[];
  shown: number | undefined;
  onView: (run: number) => void;
}

/**
 * Under the output bar while an older run shows: which run, how old, and Back to latest. Nothing while the latest
 * run shows.
 */
export function OlderRunNote({ runs, shown, onView }: OlderRunNoteProps) {
  const [now] = useState(() => Date.now());
  const latest = runs.at(-1);
  const run = runs.find((item) => item.number === shown);

  if (latest === undefined || run === undefined || run.number === latest.number) {
    return undefined;
  }

  const age = formatRunAge(run.settledAt, now);

  return (
    <div
      role="note"
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-mark py-2 pr-2.5 pl-3 text-[12.5px] text-text [&>svg]:size-3.5 [&>svg]:shrink-0"
      data-slot="older-run-note"
    >
      <HistoryIcon aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">Run {run.number}</b> from {age === "now" ? "just now" : age}. Its output only: your
        code may have changed since.
      </span>
      <Button
        variant="outline"
        className="relative h-7 shrink-0 px-2.5 text-[12.5px] font-semibold after:absolute after:inset-x-0 after:top-1/2 after:h-touch after:-translate-y-1/2"
        onClick={() => onView(latest.number)}
      >
        Back to latest
      </Button>
    </div>
  );
}
