import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { RunShortcut } from "./run-button";
import { WavingMark } from "./run-loader";

/** What the card's status row says before the first run of the tab. */
export type FirstRunStatus =
  | { state: "preparing"; percent: number | null }
  | { state: "ready" }
  | { state: "unavailable" };

export interface FirstRunCardProps {
  status: FirstRunStatus;
  dialect: RunManifestTarget["dialect"];
  /** Use the compact embed layout. */
  compact?: boolean;
  /** Fit the output below the editor. */
  stacked?: boolean;
  /** Omit to hide the Run button. */
  onRun?: () => void;
  /** False keeps the card's Run disabled, such as a project without a run file. */
  canRun?: boolean;
}

const databaseEngines: Record<RunManifestTarget["dialect"], string> = {
  postgresql: "PGlite",
  sqlite: "SQLite WASM",
};

/** Read by assistive tech once per change; the percent stays out so progress ticks are not announced. */
const statusAnnouncements: Record<FirstRunStatus["state"], string> = {
  preparing: "Preparing the runtime",
  ready: "Runtime ready",
  unavailable: "Runtime unavailable",
};

function StripedBar({ percent, moving, label }: { percent: number | null; moving: boolean; label?: string }) {
  const fill = (
    <span
      className={cn(
        "block h-full bg-[repeating-linear-gradient(-45deg,var(--lime)_0_7px,var(--lime-stripe)_7px_14px)] bg-size-[20px_20px]",
        moving && "animate-stripes",
      )}
      style={{ width: `${percent ?? 100}%` }}
    />
  );

  return (
    <div
      className="h-2.5 overflow-hidden rounded-pill border-[1.5px] border-run-border bg-surface-2"
      {...(label === undefined
        ? { "aria-hidden": true }
        : {
            role: "progressbar",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            ...(percent === null ? {} : { "aria-valuenow": percent }),
          })}
    >
      {fill}
    </div>
  );
}

function StatusLine({
  title,
  tone = "text",
  detail,
  percent,
}: {
  title: ReactNode;
  tone?: "text" | "ok" | "err";
  detail: ReactNode;
  percent?: number | null;
}) {
  return (
    <div className="flex items-baseline gap-2 whitespace-nowrap">
      <b className={cn("font-semibold", tone === "ok" ? "text-ok" : tone === "err" ? "text-err" : "text-text")}>
        {title}
      </b>
      <span className="min-w-0 truncate text-muted">{detail}</span>
      {percent !== undefined && percent !== null && (
        <span className="ml-auto font-mono text-[11px] text-muted" aria-hidden="true" data-slot="first-run-percent">
          {percent}%
        </span>
      )}
    </div>
  );
}

function StatusRow({
  status,
  dialect,
  compact = false,
  onRun,
  canRun = true,
}: Omit<FirstRunCardProps, "status"> & { status: FirstRunStatus }) {
  switch (status.state) {
    case "preparing": {
      const percent = status.percent !== null && status.percent >= 100 ? null : status.percent;

      return (
        <>
          <StatusLine
            title="Preparing the runtime"
            detail={`${databaseEngines[dialect]} and Drizzle packages, once per browser`}
            percent={percent}
          />
          <StripedBar percent={percent} moving label="Preparing the runtime" />
        </>
      );
    }
    case "ready":
      return (
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-nowrap">
            <b className="truncate font-semibold text-ok">✓ Runtime ready</b>
            <span className="truncate text-muted">{databaseEngines[dialect]} and Drizzle are loaded</span>
          </div>
          {onRun && (
            <Button
              variant="run"
              size="run"
              className="relative h-9 min-h-0 shrink-0 gap-1.5 rounded-[9px] px-3 text-[13px] after:absolute after:inset-[-5.5px] max-phone:h-9"
              data-state="ready"
              data-slot="first-run-run"
              aria-label="Run this project"
              disabled={!canRun}
              onClick={onRun}
            >
              <PlayIcon aria-hidden="true" />
              Run
              {!compact && <RunShortcut className="mr-0 h-4.5 text-[11px] @max-[400px]:hidden [&_svg]:size-2.75" />}
            </Button>
          )}
        </div>
      );
    case "unavailable":
      return (
        <>
          <StatusLine title="Runtime unavailable" tone="err" detail="Nothing runs until it prepares" />
          <StripedBar percent={0} moving={false} />
        </>
      );
  }
}

function RunTile({ status, compact }: Pick<FirstRunCardProps, "status" | "compact">) {
  return (
    <span
      className={cn(
        "grid size-11 shrink-0 place-items-center overflow-hidden rounded-[12px] border-[1.5px] border-run-border bg-lime text-on-lime shadow-sticker",
        compact && "size-8 rounded-[9px]",
      )}
    >
      {status.state === "preparing" ? (
        <WavingMark />
      ) : (
        <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
      )}
    </span>
  );
}

const helperCode = "text-[11.5px] text-text [overflow-wrap:anywhere]";

/** Show runtime readiness and output helpers before the first run. */
export function FirstRunCard({ status, dialect, compact = false, stacked = false, onRun, canRun }: FirstRunCardProps) {
  const statusRow = (
    <>
      {/* A live region without the status role: the run pill stays the output's only status. */}
      <span className="sr-only" aria-live="polite">
        {statusAnnouncements[status.state]}
      </span>
      <StatusRow status={status} dialect={dialect} compact={compact} onRun={onRun} canRun={canRun} />
    </>
  );

  if (compact) {
    return (
      <div className="grid min-h-full shrink-0 grid-cols-[minmax(0,1fr)] place-items-center p-3">
        <div
          className="relative flex w-full max-w-140 min-w-0 flex-col gap-2 overflow-hidden rounded-[12px] border-[1.5px] border-dashed border-faint bg-surface px-4 pt-4 text-left"
          data-slot="first-run"
        >
          <div className="flex items-center gap-2.5">
            <RunTile status={status} compact />
            <h2 className="font-display text-[17px] font-[750] tracking-[-0.01em]">Your results land here</h2>
          </div>
          <p className="text-[12.5px] leading-[1.55] text-muted">
            Press Run and every <code className="text-[11.5px] text-text">$.display()</code> becomes a card here.{" "}
            <code className={helperCode}>$.random.fullName()</code> gives the same fake data on every run,{" "}
            <code className={helperCode}>$.wait(500)</code> pauses.{" "}
            <b className="font-semibold text-text">console.log</b> and every query Drizzle sends land in Logs.
          </p>
          <div
            className="-mx-4 mt-1 flex h-16.5 flex-col justify-center gap-1.75 self-stretch border-t-[1.5px] border-dashed border-border px-4 pt-3 pb-4 text-[12px]"
            data-slot="first-run-status"
          >
            {statusRow}
          </div>
        </div>
      </div>
    );
  }

  if (stacked) {
    return (
      <div className="@container grid min-h-full shrink-0 grid-cols-[minmax(0,1fr)] place-items-center p-4 @max-[400px]:p-3">
        <div
          className="relative grid w-full max-w-105 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border-[1.5px] border-dashed border-faint bg-surface text-left @min-[680px]:max-w-205 @min-[680px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
          data-slot="first-run"
        >
          <div className="flex min-w-0 flex-col gap-2.5 px-5 pt-5 @min-[680px]:pb-4">
            <div className="flex items-center gap-3">
              <RunTile status={status} />
              <h2 className="font-display text-[19px] font-[750] tracking-[-0.01em]">Your results land here</h2>
            </div>
            <p className="text-[13px] leading-[1.55] text-muted">
              Press Run and every <code className="text-[12px] text-text">$.display()</code> in your code becomes a card
              here. Nothing shows up unless you display it.
            </p>
            <p className="text-[12px] leading-normal text-muted">
              <b className="font-semibold text-text">console.log</b> and every query Drizzle sends land in Logs.
            </p>
          </div>
          <dl className="mx-5 mt-3 mb-4 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] content-center items-baseline gap-x-3 gap-y-2 self-center rounded-md bg-surface-2 px-3.5 py-3 text-[12.5px] leading-[1.45] text-muted @max-[400px]:grid-cols-[minmax(0,1fr)] @max-[400px]:gap-y-0.5 @min-[680px]:mt-5 @min-[680px]:ml-0 @max-[400px]:[&>dd:not(:last-child)]:mb-2">
            <dt>
              <code className={helperCode}>$.display("Balances", rows)</code>
            </dt>
            <dd>A titled card. Rows show as a table you can flip to JSON.</dd>
            <dt>
              <code className={helperCode}>$.random.fullName()</code>
            </dt>
            <dd>Fake data from a fixed seed, the same on every run.</dd>
            <dt>
              <code className={helperCode}>$.wait(500)</code>
            </dt>
            <dd>Pause between steps.</dd>
          </dl>
          <div
            className="col-span-full flex h-16.5 flex-col justify-center gap-1.75 border-t-[1.5px] border-dashed border-border px-5 py-3 text-[12px]"
            data-slot="first-run-status"
          >
            {statusRow}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="@container grid min-h-full shrink-0 grid-cols-[minmax(0,1fr)] place-items-center p-6 max-phone:p-3 @max-[400px]:p-3">
      {/* Relative so the screen reader text stays inside the output's scroll area: escaping it would give the
          page a scrollbar, and WebKit then measures the viewport narrower and flips the phone layout in a loop. */}
      <div
        className="relative flex w-full max-w-105 min-w-0 flex-col items-center gap-2.5 overflow-hidden rounded-lg border-[1.5px] border-dashed border-faint bg-surface px-5.5 pt-6.5 text-center"
        data-slot="first-run"
      >
        <RunTile status={status} />
        <h2 className="font-display text-[21px] font-[750] tracking-[-0.01em]">Your results land here</h2>
        <p className="text-[13px] leading-[1.55] text-muted">
          Press Run and every <code className="text-[12px] text-text">$.display()</code> in your code becomes a card
          here. Nothing shows up unless you display it.
        </p>
        <dl className="mt-1 grid w-full grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 rounded-md bg-surface-2 px-3.5 py-3 text-left text-[12.5px] leading-[1.45] text-muted max-phone:grid-cols-[minmax(0,1fr)] max-phone:gap-y-0.5 @max-[400px]:grid-cols-[minmax(0,1fr)] @max-[400px]:gap-y-0.5 max-phone:[&>dd:not(:last-child)]:mb-2 @max-[400px]:[&>dd:not(:last-child)]:mb-2">
          <dt>
            <code className={helperCode}>$.display("Balances", rows)</code>
          </dt>
          <dd>A titled card. Rows show as a table you can flip to JSON.</dd>
          <dt>
            <code className={helperCode}>$.random.fullName()</code>
          </dt>
          <dd>Fake data from a fixed seed, the same on every run.</dd>
          <dt>
            <code className={helperCode}>$.wait(500)</code>
          </dt>
          <dd>Pause between steps.</dd>
        </dl>
        <p className="text-[12px] leading-normal text-muted">
          <b className="font-semibold text-text">console.log</b> and every query Drizzle sends land in Logs.
        </p>
        <div
          className="-mx-5.5 mt-1.5 flex h-20.5 flex-col justify-center gap-1.75 self-stretch border-t-[1.5px] border-dashed border-border px-5.5 pt-4 pb-6.5 text-left text-[12px]"
          data-slot="first-run-status"
        >
          {statusRow}
        </div>
      </div>
    </div>
  );
}
