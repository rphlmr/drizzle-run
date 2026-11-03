import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { Link } from "react-router";

import { cn } from "../lib/utils";
import { formatProjectDialects, isPairManifest } from "../project/projects";
import { Hint } from "../ui/hint";
import { KindBadge } from "../ui/kind-badge";
import { SideBySideTag } from "../ui/side-by-side-tag";
import { getPairLabel, resolveExampleSides, type OfficialExample } from "./catalog";

export interface ExampleCardProps {
  example: OfficialExample;
  /** The featured gallery card: a sticker card with "Start here". */
  featured?: boolean;
  /** Saved progress, for a guide the reader started in this browser. */
  progress?: GuideProgress;
  className?: string;
}

function getCallToAction(guided: boolean, progress: GuideProgress | undefined): string {
  if (!guided) {
    return "Open example";
  }

  if (progress?.finished) {
    return "Open guide";
  }

  return progress && progress.completed.length > 0 ? "Continue guide" : "Start guide";
}

/** A gallery card for an official example; a guided one shows its steps and the reader's progress. */
export function ExampleCard({ example, featured = false, progress, className }: ExampleCardProps) {
  const steps = example.guide?.steps.length;
  const done = progress?.finished ? (steps ?? 0) : (progress?.completed.length ?? 0);
  const started = steps !== undefined && done > 0;
  const pair = isPairManifest(example.manifest) ? null : getPairLabel(example.manifest);
  const sides = resolveExampleSides(example);
  const versions = sides && (
    <ul className="flex flex-wrap gap-1.5" aria-label="Versions">
      {sides.map((side, index) => (
        <li key={index} className="rounded-[6px] bg-surface-2 px-1.75 py-0.5 font-mono text-[11.5px]">
          {side.name !== undefined && `${side.name} · `}
          orm {side.ormVersion}
        </li>
      ))}
    </ul>
  );
  const cta = `${getCallToAction(steps !== undefined, progress)} →`;
  const kind =
    steps === undefined ? (
      <KindBadge tone="neutral">Example</KindBadge>
    ) : (
      <KindBadge tone={featured ? "neutral" : "lime"}>Guided · {steps} steps</KindBadge>
    );

  if (featured) {
    return (
      <Link
        to={`/examples/${example.slug}`}
        className={cn(
          "flex min-w-0 flex-col gap-2 rounded-[16px] border-[1.5px] border-card-border bg-surface p-4.5 text-text no-underline shadow-sticker-lg hover:brightness-99",
          className,
        )}
      >
        <span className="flex items-center gap-2">
          <KindBadge tone="lime">Start here</KindBadge>
          {kind}
          {sides && <SideBySideTag />}
          <span className="text-[12px] text-muted">{formatProjectDialects(example.manifest)}</span>
        </span>
        <span className="font-display text-[22px] font-extrabold">{example.title}</span>
        <span className="text-[13px]/[1.5] text-muted">{example.description}</span>
        {versions}
        <span className="text-[14px] font-semibold">{cta}</span>
      </Link>
    );
  }

  return (
    <Link
      to={`/examples/${example.slug}`}
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-[14px] border border-border bg-surface p-4 text-text no-underline hover:border-muted",
        className,
      )}
    >
      <span className="flex items-center gap-2">
        {kind}
        {sides || pair === null ? (
          <SideBySideTag />
        ) : (
          <Hint content={pair.title}>
            <span className="ml-auto font-mono text-[12px] text-muted">
              {pair.label}
              <span className="sr-only">, {pair.title}</span>
            </span>
          </Hint>
        )}
      </span>
      <span className="font-display text-[18px] font-bold">{example.title}</span>
      <span className="text-[13px]/[1.5] text-muted">{example.description}</span>
      {versions}
      <span className="mt-auto flex items-center gap-2 text-[12px] text-muted">
        <span className="font-semibold text-text">{example.topic}</span>
        <span aria-hidden="true">·</span>
        <span>{formatProjectDialects(example.manifest)}</span>
        <span className="ml-auto text-[13px] font-semibold whitespace-nowrap text-text">{cta}</span>
      </span>
      {started && (
        <span className="flex items-center gap-2 text-[12px] text-muted" data-slot="guide-progress">
          <span className="h-1 flex-1 overflow-hidden rounded-pill bg-surface-2" aria-hidden="true">
            <span className="block h-full bg-accent-text" style={{ width: `${Math.round((done / steps) * 100)}%` }} />
          </span>
          {progress?.finished ? "Guide done" : `Step ${Math.min(done + 1, steps)} of ${steps}`}
        </span>
      )}
    </Link>
  );
}
