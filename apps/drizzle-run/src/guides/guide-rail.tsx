import type { RunResult } from "@drizzle-run/core/contracts";
import {
  isPairProject,
  parseRichText,
  resolveStep,
  type GuideManifest,
  type GuideStep,
  type RunResultDiff,
} from "@drizzle-run/core/guide";
import { pairSideLabels } from "@drizzle-run/core/pair";
import { useGuideActions, useGuideStep, useRunOutput } from "@drizzle-run/react";
import { guideRunOutcome, isPairRunResult } from "@drizzle-run/runtime/guides";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LockIcon,
  PauseIcon,
  PencilIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Link } from "react-router";

import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import type { AsideControls } from "../project/project-view";
import { RunButtonIcon, RunShortcut } from "../ui/run-button";
import { readGuideMark, readStepMeta } from "./catalog";
import { RichLine, RichText } from "./rich-text";
import { getStepEdits } from "./step-edits";
import { describeChanges, describeComparedRun, listFieldChanges } from "./what-changed";

/** What the rail shows once the guide is finished. */
export interface GuideDone {
  /** The finished card's text, under "Editor unlocked". */
  text: string;
  /** The finished card's main actions, such as Close guide. */
  actions?: ReactNode;
  /** The guide after this one, linked under the card. */
  next?: { title: string; href: string };
}

/**
 * What leaving the guide does: an example pauses it to experiment on a throwaway copy,
 * a guided project skips it for good.
 */
export type GuideLeave = "pause" | "skip";

const leaveButtons = {
  pause: { label: "Pause guide and experiment", Icon: PauseIcon },
  skip: { label: "Skip guide and edit", Icon: PencilIcon },
} satisfies Record<GuideLeave, { label: string; Icon: typeof PencilIcon }>;

export interface GuideRailProps {
  guide: GuideManifest;
  controls: AsideControls;
  leave: GuideLeave;
  done: GuideDone;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

/** At most this many changed lines show in a step's edit box; the editor shows them all. */
const EDIT_LINES = 4;

type Segment = "done" | "now" | "todo";

const segmentTones: Record<Segment, string> = {
  done: "border border-run-border bg-lime",
  now: "bg-segment",
  todo: "bg-surface-2",
};

const numberTones = {
  done: "border-[1.5px] border-run-border bg-lime text-on-lime",
  now: "bg-segment text-segment-fg",
  next: "border-[1.5px] border-faint text-muted",
  failed: "bg-err-bg text-err",
} as const;

function StepNumber({ tone, children }: { tone: keyof typeof numberTones; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "grid size-5.5 shrink-0 place-items-center rounded-full text-[11px] font-bold [&>svg]:size-2.75 [&>svg]:stroke-[3.5]",
        numberTones[tone],
      )}
    >
      {tone === "done" ? <CheckIcon aria-hidden="true" /> : children}
    </span>
  );
}

function EditBox({ guide, index, step }: { guide: GuideManifest; index: number; step: GuideStep }) {
  const { project } = resolveStep(guide, index);
  const names = isPairProject(project) ? pairSideLabels(project) : undefined;
  const edits = getStepEdits(guide, index).map((edit) => ({
    ...edit,
    side: edit.side === undefined ? undefined : names?.[edit.side],
  }));

  if (edits.length === 0) {
    return (
      <div className="overflow-hidden rounded-md border border-border" data-slot="guide-edits">
        <b className="block bg-surface-2 px-2.5 py-1.25 text-[11px] font-semibold text-muted">
          No code changes in this step
        </b>
        <p className="m-0 px-2.5 py-1.5 text-[11.5px] leading-normal text-muted">
          <RichLine value={readStepMeta(guide, step).summary} />
        </p>
      </div>
    );
  }

  const lines = edits.flatMap(({ file, side, lines: changed }) => changed.map((line) => ({ file, side, ...line })));
  const shown = lines.slice(0, EDIT_LINES);
  const indent = getCommonIndent(shown.map((line) => line.text));
  const gutterWidth = `${Math.max(...shown.map((line) => String(line.line).length))}ch`;

  return (
    <div className="overflow-hidden rounded-md border border-border" data-slot="guide-edits">
      <b className="flex items-center gap-2 bg-surface-2 px-2.5 py-1.25 text-[11px] font-semibold text-muted">
        Changes in this step
        <span className="ml-auto font-mono font-normal">{[...new Set(edits.map(({ file }) => file))].join(", ")}</span>
      </b>
      <ol className="m-0 list-none p-0" aria-label="Changed lines">
        {shown.flatMap((line, position) => {
          const previousLine = shown[position - 1];
          const opensSide =
            line.side !== undefined && (previousLine?.side !== line.side || previousLine.file !== line.file);
          const heading = opensSide && (
            <li
              key={`${position}-side`}
              className="border-t border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-semibold text-muted first:border-t-0"
            >
              {line.side} · <span className="font-mono font-normal">{line.file}</span>
            </li>
          );

          return [
            heading,
            <li
              key={position}
              className={cn(
                "grid gap-x-2 px-2.5 py-1 font-mono text-[11.5px]",
                line.kind === "removed" ? "bg-err-bg text-err" : "bg-mark text-text",
              )}
              style={{ gridTemplateColumns: `${gutterWidth} 1ch minmax(0, 1fr)` }}
            >
              <span className="text-right tabular-nums opacity-60 select-none">{line.line}</span>
              <span className="font-bold select-none" aria-hidden="true">
                {line.kind === "removed" ? "−" : "+"}
              </span>
              <span
                className={cn("min-w-0 wrap-anywhere whitespace-pre-wrap", line.kind === "removed" && "line-through")}
              >
                <span className="sr-only">{line.kind === "removed" ? "Removed: " : "Added: "}</span>
                {line.text.trim() === "" ? " " : line.text.slice(indent)}
              </span>
            </li>,
          ];
        })}
        {lines.length > shown.length && (
          <li className="px-2.5 py-1 text-[11.5px] text-muted">
            {lines.length - shown.length} more changed lines in the editor
          </li>
        )}
      </ol>
    </div>
  );
}

/** The leading whitespace every non-blank line shares, so shown lines keep their relative indentation. */
function getCommonIndent(texts: readonly string[]) {
  const indents = texts.filter((text) => text.trim() !== "").map((text) => text.length - text.trimStart().length);

  return indents.length === 0 ? 0 : Math.min(...indents);
}

function RunStepButton({
  controls,
  phone,
  pair,
  onCancel,
}: {
  controls: AsideControls;
  phone: boolean;
  /** A step on two sides runs both, as the header's Run both does. */
  pair: boolean;
  onCancel: () => void;
}) {
  const running = controls.runState === "running";
  const preparing = controls.runState === "preparing";

  return (
    <Button
      variant="run"
      size="run"
      data-state={controls.runState}
      className={cn("w-full justify-center", phone ? "h-12 text-[15px]" : "h-10")}
      disabled={!running && !controls.canRun}
      aria-busy={preparing || undefined}
      onClick={running ? onCancel : controls.run}
    >
      <RunButtonIcon state={controls.runState} />
      {running ? "Cancel" : pair ? "Run both" : "Run"}
      {!running && !phone && <RunShortcut />}
    </Button>
  );
}

/** "What changed": the step's own words when it has them, else the result's differences. */
function WhatChanged({
  guide,
  step,
  result,
  pair,
  changes,
  error,
  since,
  phone,
}: {
  guide: GuideManifest;
  step: GuideStep;
  /** A one-version run's result; a side-by-side run's shows in each side's output. */
  result: RunResult | undefined;
  /** The run was side by side, so nothing compares it. */
  pair: boolean;
  changes: RunResultDiff | undefined;
  error: string;
  /** What the run is compared with, such as "step 3". */
  since: string | undefined;
  phone: boolean;
}) {
  const textClass = phone ? phoneTextClass : bodyTextClass;

  if (error !== "" || result?.outcome === "failed") {
    return (
      <p className={cn("m-0 text-muted", textClass)}>
        Run failed:{" "}
        <span className="font-mono text-[12px] wrap-anywhere text-err">{error || result?.error?.message}</span>
      </p>
    );
  }

  const written = readStepMeta(guide, step).changed;

  if (written) {
    return <RichText value={written} className={cn("m-0 text-muted", textClass)} />;
  }

  if (pair) {
    return <p className={cn("m-0 text-muted", textClass)}>Both sides ran. Each side's output shows its result.</p>;
  }

  if (!changes || since === undefined) {
    return <p className={cn("m-0 text-muted", textClass)}>No previous run to compare with. Output is in Results.</p>;
  }

  const fields = listFieldChanges(changes).slice(0, 3);

  return (
    <div className={cn("flex flex-col gap-1.5 text-muted", textClass)}>
      <p className="m-0">{describeChanges(changes, since)}</p>
      {fields.map((field, position) => (
        <p key={position} className="m-0">
          {field.label}, row {field.row}: <span className="font-mono">{field.field}</span>{" "}
          <span className="font-mono text-text">{field.before}</span> to{" "}
          <span className="rounded-[3px] bg-lime px-0.75 font-mono text-on-lime">{field.after}</span>
        </p>
      ))}
    </div>
  );
}

function FlatStep({
  tone,
  number,
  title,
  line,
  onOpen,
}: {
  tone: "done" | "next";
  number: number;
  title: string;
  line: ReactNode;
  /** Set on a finished step: the row becomes a button that goes back to it. */
  onOpen?: () => void;
}) {
  const content = (
    <>
      <StepNumber tone={tone}>{number}</StepNumber>
      <span className="block">
        <span className={cn("block text-[14px] font-semibold", tone === "done" && "text-muted")}>{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-[1.4] text-muted">{line}</span>
      </span>
    </>
  );
  const rowClass = "grid items-start gap-2.5 px-[15.5px]";

  if (!onOpen) {
    return (
      <li className={cn(rowClass, "grid-cols-[24px_minmax(0,1fr)]", tone === "next" && "opacity-50")}>{content}</li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={cn(
          rowClass,
          "group -my-1.5 w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto] rounded-[10px] border-0 bg-transparent py-1.5 text-left text-text",
          "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent-text",
        )}
        aria-label={`Go back to step ${number}: ${title}`}
        onClick={onOpen}
      >
        {content}
        <span className="inline-flex items-center gap-1 self-center text-[11.5px] font-semibold text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [&>svg]:size-3 [@media(hover:none)]:opacity-100">
          <RotateCcwIcon aria-hidden="true" />
          Revisit
        </span>
      </button>
    </li>
  );
}

/** The step's docs links, labelled so they read as further reading rather than actions. */
function StepDocs({ links }: { links: ReactNode[] }) {
  if (links.length === 0) {
    return null;
  }

  return (
    <nav
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border pt-2"
      aria-label="Read more in the Drizzle docs"
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] text-muted uppercase [&>svg]:size-3.5">
        <BookOpenIcon aria-hidden="true" />
        Docs
      </span>
      {links}
    </nav>
  );
}

const cardClass = cn("relative flex flex-col gap-2.5 rounded-lg bg-surface p-3.5");

/** A step's copy while the guide loads: its title, a few lines of body, and the Run button. */
function StepCardSkeleton() {
  return (
    <>
      <Skeleton className="h-4.5 w-1/2" />
      <div className="grid gap-2">
        <Skeleton className="h-3.5 w-full max-w-none" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
      <Skeleton className="h-10 w-full max-w-none rounded-[10px]" />
    </>
  );
}

/**
 * The rail's step list while the guide restores its progress.
 * It keeps the loaded list's shape, the open card at `index` and a row per other step, so nothing jumps.
 */
function StepListSkeleton({ index, count }: { index: number; count: number }) {
  return Array.from({ length: count }, (_, position) =>
    position === index ? (
      <li key={position} className={cn(cardClass, "border-[1.5px] border-border")} aria-hidden="true">
        <StepCardSkeleton />
      </li>
    ) : (
      <li
        key={position}
        className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5 px-[15.5px]"
        aria-hidden="true"
      >
        <Skeleton className="size-5.5 rounded-full" />
        <span className="grid gap-1.5 pt-0.5">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-4/5" />
        </span>
      </li>
    ),
  );
}
const nowCardClass = cn(cardClass, "border border-card-border shadow-sticker");
const pastCardClass = cn(cardClass, "border border-border");
const cardTitleClass = cn("text-[14.5px] font-bold");
const bodyTextClass = cn("text-[14px] leading-[1.5]");
const phoneTextClass = cn("text-[13.5px] leading-[1.55]");
const cardTextClass = cn("m-0 text-muted", bodyTextClass);
const phoneCardTextClass = cn("m-0 text-muted", phoneTextClass);

/** The guided example's rail (desktop) or bottom sheet (phone), rendered from the guide manifest. */
export function GuideRail({ guide, controls, leave: leaveMode, done, collapsed, onCollapsedChange }: GuideRailProps) {
  const sheetGesture = useRef<{ id: number; y: number; moved: boolean } | null>(null);
  const view = useGuideStep();
  const guideOutput = useRunOutput();
  const output = {
    ...guideOutput,
    result: guideOutput.result === undefined || isPairRunResult(guideOutput.result) ? undefined : guideOutput.result,
  };
  const events = useGuideActions();
  const { stage, index, count, step, completed } = view;
  const finished = stage === "done";
  const ran = stage === "after";
  const pairRan = guideOutput.result !== undefined && isPairRunResult(guideOutput.result);
  const pairStep = isPairProject(view.project);
  const succeeded = ran && guideOutput.result !== undefined && guideRunOutcome(guideOutput.result) === "succeeded";
  const stepDone = (position: number) => finished || completed.includes(guide.steps[position].id) || position < index;
  const last = index === count - 1;
  const title = readGuideMark(guide);
  const phone = controls.phone;
  const label = finished
    ? phone
      ? "Guide complete"
      : "Guide · complete"
    : `${phone ? "" : "Guide · "}${phone ? "Step" : "step"} ${index + 1} of ${count}${succeeded ? " done" : ""}`;
  const nowIndex = finished ? -1 : succeeded ? index + 1 : index;
  const segments: Segment[] = guide.steps.map((_, position) =>
    position === nowIndex ? "now" : stepDone(position) || (succeeded && position === index) ? "done" : "todo",
  );
  const links = finished ? [] : (step.links ?? []);
  const since = guideOutput.since && describeComparedRun(guide, guideOutput.since, index);

  if (collapsed && !phone) {
    return (
      <div className="flex h-full flex-col items-center gap-2 rounded-[14px] border border-border bg-surface px-1.5 py-3">
        <Button variant="ghost" size="icon-sm" aria-label="Expand guide" onClick={() => onCollapsedChange(false)}>
          <ChevronRightIcon aria-hidden="true" />
        </Button>
        <span className="text-[11px] font-bold text-muted [writing-mode:vertical-rl]">{label}</span>
      </div>
    );
  }

  const segmentBar = (
    <div className={cn("flex gap-1", phone && "flex-1")} aria-hidden="true">
      {segments.map((segment, position) => (
        <span key={position} className={cn("h-1.25 flex-1 rounded-pill", segmentTones[segment])} />
      ))}
    </div>
  );
  const heading = (
    <h2
      className={cn(
        "m-0 font-display font-[750] tracking-[-0.02em]",
        phone ? "text-[21px]/[1.15]" : "text-[20px]/[1.15]",
      )}
      id="guide-title"
    >
      {title.before}
      {title.mark && <mark className="rounded-[4px] px-1">{title.mark}</mark>}
      {title.after}
    </h2>
  );
  const leaveButton = leaveButtons[leaveMode];
  const leave = stage !== "left" && !finished && (
    <Button
      variant="outline"
      size="sm"
      className={cn("text-[12.5px]", phone && "border-transparent px-1 text-muted")}
      onClick={events.leave}
    >
      {!phone && <leaveButton.Icon aria-hidden="true" />}
      {leaveButton.label}
    </Button>
  );
  const back = phone && stage !== "left" && !finished && (
    <Button
      variant="outline"
      size="sm"
      className={cn("text-[12.5px]", phone && "border-transparent px-1 text-muted")}
      disabled={!view.canBack}
      onClick={events.back}
    >
      Back
    </Button>
  );
  const linkItems = links.map((link) => {
    const content = (
      <>
        {link.label}
        <ArrowUpRightIcon aria-hidden="true" />
      </>
    );
    const className =
      "inline-flex min-h-9 items-center gap-1.5 text-[12.5px] font-semibold whitespace-nowrap text-accent-text no-underline [&>svg]:size-3";

    return link.href.startsWith("/") ? (
      <Link key={link.href} to={link.href} className={className}>
        {content}
      </Link>
    ) : (
      <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  });
  const nextButton = (
    <Button
      variant="sticker"
      className={cn("w-full", phone ? "h-11 flex-[1.3]" : "h-10")}
      disabled={!view.canNext}
      onClick={events.next}
    >
      {last ? "Finish guide" : "Next step"}
      <ArrowRightIcon aria-hidden="true" />
    </Button>
  );
  const nextGuide = done.next && (
    <Link
      to={done.next.href}
      className="flex items-center gap-2.5 rounded-[12px] border border-border px-3.5 py-3 text-text no-underline hover:border-muted [&>svg]:size-4"
    >
      <span className="flex-1">
        <span className="block text-[11px] text-muted">Next guide</span>
        <span className="block text-[13.5px] font-[650]">{done.next.title}</span>
      </span>
      <ArrowRightIcon aria-hidden="true" />
    </Link>
  );

  if (phone) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 rounded-t-[20px] border-t-[1.5px] border-card-border bg-surface px-4 pt-2 pb-5 shadow-pop"
        aria-labelledby={collapsed ? undefined : "guide-title"}
      >
        <button
          type="button"
          className="-mx-4 -mt-2 flex min-h-11 touch-none items-center justify-between gap-3 rounded-t-[20px] border-0 border-b border-border bg-surface px-4 text-[12px] font-semibold text-muted select-none"
          aria-label={collapsed ? "Expand guide" : "Collapse guide"}
          aria-expanded={!collapsed}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            sheetGesture.current = { id: event.pointerId, y: event.clientY, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = sheetGesture.current;
            if (gesture?.id === event.pointerId && Math.abs(event.clientY - gesture.y) > 10) {
              gesture.moved = true;
            }
          }}
          onPointerUp={(event) => {
            const gesture = sheetGesture.current;
            if (gesture?.id !== event.pointerId) return;
            const distance = event.clientY - gesture.y;
            if (Math.abs(distance) >= 30) onCollapsedChange(distance > 0);
          }}
          onPointerCancel={() => {
            sheetGesture.current = null;
          }}
          onClick={(event) => {
            if (event.detail === 0 || !sheetGesture.current?.moved) onCollapsedChange(!collapsed);
            sheetGesture.current = null;
          }}
        >
          <span>{collapsed ? "Show guide steps" : "Hide guide steps"}</span>
          <span className="flex items-center gap-1.5 font-normal">
            Swipe {collapsed ? "up" : "down"}
            {collapsed ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
          </span>
        </button>
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-muted uppercase">
            {label}
          </span>
          {segmentBar}
        </div>
        {!collapsed && (
          <div className="-m-1 flex min-h-0 flex-col gap-3 overflow-y-auto p-1 *:shrink-0">
            {stage === "loading" ? (
              <StepCardSkeleton />
            ) : stage === "left" ? (
              <LeftCard step={index + 1} onResume={events.resume} />
            ) : finished ? (
              <>
                {heading}
                <h3 className="m-0 font-display text-[19px] font-[750] tracking-[-0.02em]">Editor unlocked</h3>
                <p className={phoneCardTextClass}>{done.text}</p>
                {done.actions && <div className="flex flex-col gap-2">{done.actions}</div>}
                <Button variant="outline" className="h-11" onClick={events.restart}>
                  Restart guide
                </Button>
                {nextGuide}
              </>
            ) : ran ? (
              <>
                <div className="flex items-center gap-2.5">
                  <StepNumber tone={succeeded ? "done" : "failed"}>{index + 1}</StepNumber>
                  <h2 className="m-0 font-display text-[19px] font-[750] tracking-[-0.02em]" id="guide-title">
                    {step.title}
                  </h2>
                </div>
                <WhatChanged
                  guide={guide}
                  step={step}
                  result={output.result}
                  changes={output.changes}
                  error={output.error}
                  pair={pairRan}
                  since={since}
                  phone
                />
                <div className="flex gap-2">
                  {succeeded ? (
                    <Button variant="outline" className="h-11 flex-1" onClick={() => controls.showOutput("story")}>
                      Replay in Story
                    </Button>
                  ) : (
                    <Button variant="outline" className="h-11 flex-1" onClick={() => controls.showOutput("problems")}>
                      Open Problems
                    </Button>
                  )}
                  {succeeded || step.run !== "required" ? (
                    nextButton
                  ) : (
                    <RunStepButton controls={controls} phone pair={pairStep} onCancel={events.cancel} />
                  )}
                </div>
              </>
            ) : (
              <>
                <h2 className="m-0 font-display text-[21px]/[1.15] font-[750] tracking-[-0.02em]" id="guide-title">
                  {step.title}
                </h2>
                <RichText value={parseRichText(step.body)} className={phoneCardTextClass} />
                <EditBox guide={guide} index={index} step={step} />
                {stage === "failed" && (
                  <p className="m-0 text-[13px] text-err" role="alert">
                    {output.error}
                  </p>
                )}
                {step.run === "none" ? (
                  nextButton
                ) : (
                  <RunStepButton controls={controls} phone pair={pairStep} onCancel={events.cancel} />
                )}
                {step.run === "optional" && (
                  <Button variant="outline" className="h-11" disabled={!view.canNext} onClick={events.next}>
                    Continue without running
                  </Button>
                )}
                <StepDocs links={linkItems} />
                <div className="flex items-center gap-3">
                  {back}
                  {leave}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface"
      aria-labelledby="guide-title"
    >
      <div className="flex flex-col gap-2.5 border-b border-border pt-3.5 pr-3 pb-3 pl-4">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] font-bold tracking-[0.06em] text-muted uppercase">{label}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0 text-muted"
            aria-label="Collapse guide"
            onClick={() => onCollapsedChange(true)}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
        </div>
        {segmentBar}
        {heading}
      </div>
      <ol
        className="m-0 flex min-h-0 flex-1 list-none flex-col gap-3.5 overflow-y-auto bg-panel px-4 py-3.5 *:shrink-0"
        aria-label="Guide steps"
        aria-busy={stage === "loading"}
      >
        {stage === "loading" ? (
          <StepListSkeleton index={index} count={count} />
        ) : stage === "left" ? (
          <li>
            <LeftCard step={index + 1} onResume={events.resume} />
          </li>
        ) : (
          <>
            {guide.steps.map((item, position) => {
              const copy = readStepMeta(guide, item);

              if (finished || position < index) {
                return (
                  <FlatStep
                    key={item.id}
                    tone="done"
                    number={position + 1}
                    title={item.title}
                    line={<RichLine value={copy.changed ?? copy.summary} />}
                    onOpen={() => events.goToStep(position)}
                  />
                );
              }

              if (position > nowIndex) {
                return (
                  <FlatStep
                    key={item.id}
                    tone="next"
                    number={position + 1}
                    title={item.title}
                    line={<RichLine value={copy.summary} />}
                  />
                );
              }

              if (position === index && ran) {
                return (
                  <li key={item.id} className={pastCardClass} aria-current={succeeded ? undefined : "step"}>
                    <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5">
                      <StepNumber tone={succeeded ? "done" : "failed"}>{position + 1}</StepNumber>
                      <div className={cardTitleClass}>{item.title}</div>
                    </div>
                    <div className="text-[11px] font-bold tracking-[0.06em] text-accent-text uppercase">
                      What changed
                    </div>
                    <WhatChanged
                      guide={guide}
                      step={item}
                      result={output.result}
                      changes={output.changes}
                      error={output.error}
                      pair={pairRan}
                      since={since}
                      phone={false}
                    />
                    <div className="flex flex-wrap gap-2">
                      {succeeded ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[12.5px]"
                            onClick={() => controls.showOutput("results")}
                          >
                            Show in Results
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[12.5px]"
                            onClick={() => controls.showOutput("story")}
                          >
                            Replay in Story
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[12.5px]"
                            onClick={() => controls.showOutput("problems")}
                          >
                            Open Problems
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[12.5px]"
                            disabled={!controls.canRun}
                            onClick={controls.run}
                          >
                            Run again
                          </Button>
                        </>
                      )}
                    </div>
                    {last && (succeeded || step.run !== "required") && nextButton}
                    <StepDocs links={linkItems} />
                  </li>
                );
              }

              if (position === index + 1 && ran) {
                return (
                  <li key={item.id} className={nowCardClass} aria-current="step">
                    <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5">
                      <StepNumber tone="now">{position + 1}</StepNumber>
                      <div className={cardTitleClass}>{item.title}</div>
                    </div>
                    <p className={cardTextClass}>
                      <RichLine value={copy.summary} />
                    </p>
                    {nextButton}
                  </li>
                );
              }

              return (
                <li key={item.id} className={nowCardClass} aria-current="step">
                  <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5">
                    <StepNumber tone="now">{position + 1}</StepNumber>
                    <div className={cardTitleClass}>{item.title}</div>
                  </div>
                  <span className="sr-only">
                    Step {position + 1} of {count}
                  </span>
                  <RichText value={parseRichText(item.body)} className={cardTextClass} />
                  <EditBox guide={guide} index={position} step={item} />
                  {stage === "failed" && (
                    <p className="m-0 text-[13px] text-err" role="alert">
                      {output.error}
                    </p>
                  )}
                  {item.run === "none" ? (
                    nextButton
                  ) : (
                    <RunStepButton controls={controls} phone={false} pair={pairStep} onCancel={events.cancel} />
                  )}
                  {item.run === "optional" && (
                    <Button variant="outline" className="h-9" disabled={!view.canNext} onClick={events.next}>
                      Continue without running
                    </Button>
                  )}
                  <StepDocs links={linkItems} />
                </li>
              );
            })}
            {finished && (
              <>
                <li className={nowCardClass}>
                  <div className={cardTitleClass}>Editor unlocked</div>
                  <p className={cardTextClass}>{done.text}</p>
                  {done.actions}
                  <Button variant="outline" className="h-8.5" onClick={events.restart}>
                    Restart guide
                  </Button>
                </li>
                {nextGuide && <li>{nextGuide}</li>}
              </>
            )}
          </>
        )}
      </ol>
      {leave && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2.5">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted [&>svg]:size-3.5">
            <LockIcon aria-hidden="true" />
            Editor is read-only
          </span>
          <span className="ml-auto">{leave}</span>
        </div>
      )}
    </div>
  );
}

function LeftCard({ step, onResume }: { step: number; onResume: () => void }) {
  return (
    <div className={nowCardClass}>
      <div className={cardTitleClass}>Guide paused</div>
      <p className={cardTextClass}>
        The editor is unlocked, so try anything. Edits are not kept: resuming restores the code of step {step}.
      </p>
      <Button variant="sticker" className="h-10" onClick={onResume}>
        Resume guide
      </Button>
    </div>
  );
}
