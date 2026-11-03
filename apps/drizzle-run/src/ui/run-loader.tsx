import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { drizzleMarkBars } from "./logo-tile";
import { formatRunDuration } from "./output-tab";

const waveDelays = ["", "[animation-delay:.15s]", "[animation-delay:.3s]", "[animation-delay:.45s]"];

/** The Drizzle mark, its bars lighting up in turn while the runtime prepares or a run goes. Size it with `className`. */
export function WavingMark({ className }: { className?: string }) {
  return (
    <svg className={cn("h-3.25 w-6", className)} viewBox="0 0 317 166" fill="none" aria-hidden="true">
      <g className="stroke-on-lime" strokeWidth="30" strokeLinecap="round">
        {drizzleMarkBars.map(([x1, y1, x2, y2], index) => (
          <line key={x1} className={cn("animate-wave", waveDelays[index])} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Text a highlight sweeps across, as chat apps draw a reply in progress. Reduced motion keeps the text plain, since
 * a still gradient would leave part of it brighter.
 */
export function ShimmerText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "motion-safe:animate-shimmer motion-safe:bg-[linear-gradient(90deg,var(--text-muted)_40%,var(--text)_50%,var(--text-muted)_60%)] motion-safe:bg-size-[200%_100%] motion-safe:bg-clip-text motion-safe:text-transparent",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The dot a run pill pulses while a run goes. */
export function RunningDot({ className }: { className?: string }) {
  return (
    <span className={cn("size-1.75 shrink-0 animate-pulse-soft rounded-full bg-ok", className)} aria-hidden="true" />
  );
}

/**
 * The time since the run started, ticking while it goes
 *
 * Counts from the run machine's `startedAt` (a `performance.now()` time), so a pill mounted mid-run, such as a phone's
 * after a side switch, shows the run's own time. Without one it counts from its mount.
 */
export function RunningDuration({ startedAt }: { startedAt: number | undefined }) {
  const [mountedAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());
  const elapsedMs = Math.max(0, now - (startedAt ?? mountedAt));

  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 100);

    return () => clearInterval(timer);
  }, []);

  // Hidden from assistive tech: run pills are live regions, and a tick every 100 ms would flood them.
  return (
    <span className="tabular-nums" aria-hidden="true" data-duration="">
      {formatRunDuration(elapsedMs)}
    </span>
  );
}

/** An output while a run goes and nothing has come back yet: the waving mark over shimmering text. */
export function RunningNote({ detail = "You can keep editing." }: { detail?: ReactNode }) {
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
      <span className="mb-1 grid size-11 shrink-0 place-items-center rounded-[12px] border-[1.5px] border-run-border bg-lime shadow-action">
        <WavingMark />
      </span>
      <p className="max-w-70 font-medium">
        <ShimmerText>Your query is running</ShimmerText>
      </p>
      <p className="max-w-70 text-muted">{detail}</p>
    </div>
  );
}
