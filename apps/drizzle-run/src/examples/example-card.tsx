import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { BookOpenIcon, CheckCircle2Icon, Code2Icon, Columns2Icon } from "lucide-react";
import { Link } from "react-router";

import { cn } from "../lib/utils";
import { formatProjectDialects } from "../project/projects";
import { resolveExampleSides, type OfficialExample } from "./catalog";
import { getExampleProgress } from "./progress";

export interface ExampleCardProps {
  example: OfficialExample;
  /** The featured gallery card, with a prominent action and "Start here" for new readers. */
  featured?: boolean;
  /** Saved progress, for a guide the reader started in this browser. */
  progress?: GuideProgress;
  viewedAt?: string;
  className?: string;
}

export function getExampleCallToAction(guided: boolean, progress: GuideProgress | undefined): string {
  if (!guided) {
    return "Open example";
  }

  if (progress?.finished) {
    return "Revisit guide";
  }

  return progress ? "Continue guide" : "Start guide";
}

/** An example library row, or its featured panel, with saved guide progress. */
export function ExampleCard({ example, featured = false, progress, viewedAt, className }: ExampleCardProps) {
  const steps = example.guide?.steps.length;
  const done = progress?.finished ? (steps ?? 0) : (progress?.completed.length ?? 0);
  const status = getExampleProgress({ progress, viewedAt });
  const started = status !== "not_viewed";
  const statusLabels = {
    not_viewed: "Not viewed",
    viewed: "Viewed",
    in_progress: "In progress",
    completed: "Completed",
  };
  const progressBadge = started && (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        status === "completed" ? "bg-ok-bg text-ok" : "bg-surface-2 text-muted",
      )}
      data-slot={steps === undefined ? "example-status" : "guide-status"}
    >
      {status === "completed" && <CheckCircle2Icon className="size-3.5" aria-hidden="true" />}
      {statusLabels[status]}
    </span>
  );
  const sides = resolveExampleSides(example);
  const comparison = sides
    ?.map((side) => {
      if (side.name === undefined) {
        return `Drizzle ${side.ormVersion}`;
      }

      return sides[0].ormVersion === sides[1].ormVersion ? side.name : `${side.name} (${side.ormVersion})`;
    })
    .join(" vs ");
  const cta = `${getExampleCallToAction(steps !== undefined, progress)} →`;
  const EntryIcon = steps === undefined ? Code2Icon : BookOpenIcon;
  const entryProgress = started && (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      {progressBadge}
      {status === "in_progress" && (
        <span
          className="text-[12px] text-muted"
          data-slot="guide-progress"
          aria-label={`${done} of ${steps} steps completed`}
        >
          {done}/{steps} steps
        </span>
      )}
    </span>
  );

  if (featured) {
    return (
      <Link
        to={`/examples/${example.slug}`}
        className={cn(
          "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-8 gap-y-4 rounded-lg border border-card-border bg-surface px-5 py-4 text-text no-underline shadow-sticker-card transition-colors hover:border-muted focus-visible:border-muted max-phone:grid-cols-1 max-phone:px-4",
          className,
        )}
      >
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted max-phone:hidden">
            <EntryIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {!started && <span className="text-[12px] font-semibold text-muted">Start here</span>}
              <h2 className="font-display text-[20px]/[1.3] font-bold">{example.title}</h2>
            </div>
            <p className="max-w-170 text-[13px]/[1.5] text-soft">{example.description}</p>
            <p className="text-[12px] text-muted">
              {steps === undefined ? "Example" : `Guide · ${steps} steps`} · {formatProjectDialects(example.manifest)}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 max-phone:flex-row max-phone:justify-between">
          {entryProgress}
          <span className="ml-auto rounded-sm border border-run-border bg-lime px-3 py-2 text-[13px] font-semibold whitespace-nowrap text-on-lime shadow-action transition-all group-active:translate-0.5 group-active:shadow-none">
            {cta}
          </span>
        </div>
      </Link>
    );
  }

  return (
    <Link
      to={`/examples/${example.slug}`}
      className={cn(
        "group grid min-w-0 grid-cols-[minmax(0,1fr)_108px_128px_148px] items-center gap-x-6 gap-y-3 px-5 py-4 text-text no-underline transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 max-wide:grid-cols-[minmax(0,1fr)_128px_148px] max-phone:grid-cols-[minmax(0,1fr)_auto] max-phone:gap-x-3 max-phone:px-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3 max-phone:col-span-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-border text-muted max-phone:hidden">
          <EntryIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <h2 className="text-[15px]/[1.5] font-semibold decoration-border underline-offset-4 group-hover:underline">
              {example.title}
            </h2>
            <span className="text-[11px] text-muted">{example.topics.join(" · ")}</span>
          </div>
          <p className="text-[13px]/[1.5] text-soft">{example.description}</p>
          {comparison && (
            <p className="mt-0.5 flex items-start gap-1.5 text-[12px]/[1.5] text-muted">
              <Columns2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{comparison}</span>
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1 text-[12px]/[1.5] text-muted">
        <p>{steps === undefined ? "Example" : `Guide · ${steps} steps`}</p>
        <p className="hidden max-wide:block">{formatProjectDialects(example.manifest)}</p>
      </div>
      <p className="text-[12px]/[1.5] text-muted max-wide:hidden">{formatProjectDialects(example.manifest)}</p>
      <div className="flex flex-col items-end gap-2">
        {entryProgress}
        <span className="text-[13px] font-semibold whitespace-nowrap">{cta}</span>
      </div>
    </Link>
  );
}
