import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { CheckIcon, EyeIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../lib/utils";
import { SideBySideTag } from "../ui/side-by-side-tag";
import type { OfficialExample } from "./catalog";
import { getExampleComparison } from "./gallery-model";
import type { ExampleProgress } from "./progress";

/** Props of a gallery card: the version it opens, what the reader did with it, and the quick look. */
export interface ExampleCardProps {
  version: OfficialExample;
  /** The family title, without the database it names. */
  title: string;
  status: ExampleProgress;
  /** Saved progress, for a guide started in this browser. */
  progress?: GuideProgress;
  /** Where the card opens: the version, or a step of its guide. */
  href?: string;
  /** Shown instead of the description, such as the step a search matched. */
  detail?: ReactNode;
  /** The database the reader picked, when the example does not run on it. */
  onlyOn?: string;
  onQuickLook: () => void;
}

/** The status tag of a card: the steps done of a guide in progress, done, or viewed. */
function StatusTag({ status, done, steps }: { status: ExampleProgress; done: number; steps: number | undefined }) {
  if (status === "not_viewed") {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] px-1.75 py-px text-[11px] font-semibold whitespace-nowrap",
        status === "completed" && "bg-ok-bg text-ok",
        status === "in_progress" && "bg-mark text-accent-text",
        status === "viewed" && "text-muted",
      )}
      data-slot="example-status"
    >
      {status === "completed" && <CheckIcon className="size-3" aria-hidden="true" />}
      {status === "completed" ? "Done" : status === "in_progress" ? `${done}/${steps} steps` : "Viewed"}
    </span>
  );
}

/**
 * One example of the gallery. The whole card is a link that opens the example; Space on it, or the eye button, opens
 * the quick look instead. The eye shows on hover and focus, and always on touch screens.
 */
export function ExampleCard({
  version,
  title,
  status,
  progress,
  href = `/examples/${version.slug}`,
  detail,
  onlyOn,
  onQuickLook,
}: ExampleCardProps) {
  const steps = version.guide?.steps.length;
  const done = progress?.finished ? (steps ?? 0) : (progress?.completed.length ?? 0);
  const comparison = getExampleComparison(version);

  return (
    <article
      className="group/card relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-3.5 text-text transition-[border-color,box-shadow] hover:border-card-border hover:shadow-sticker-card has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-accent-text"
      data-example-slug={version.slug}
    >
      <span className="pr-8 text-[11px] font-medium tracking-[0.02em] text-muted uppercase">
        {steps === undefined ? "Example" : `Guide · ${steps} steps`}
      </span>
      <h3 className="pr-6 text-[14px]/[1.35] font-semibold">
        <Link
          to={href}
          className="text-text no-underline decoration-card-border underline-offset-4 group-hover/card:underline after:absolute after:inset-0 after:rounded-lg"
          onKeyDown={(event) => {
            if (event.key === " " && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              event.preventDefault();
              onQuickLook();
            }
          }}
        >
          {title}
        </Link>
      </h3>
      {detail ?? <p className="line-clamp-2 text-[12.5px]/[1.5] text-soft">{version.description}</p>}
      {comparison && <p className="truncate text-[12px] text-muted">{comparison}</p>}
      {status === "in_progress" && steps !== undefined && (
        <span className="mt-0.5 h-0.75 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <span className="block h-full rounded-full bg-ok" style={{ width: `${(done / steps) * 100}%` }} />
        </span>
      )}
      <span className="mt-auto flex min-h-5 flex-wrap items-center gap-1.5 pt-1">
        {comparison && <SideBySideTag className="relative z-1" />}
        {onlyOn && (
          <span className="rounded-[4px] bg-err-bg px-1.75 py-px text-[11px] font-semibold whitespace-nowrap text-err">
            {onlyOn} only
          </span>
        )}
        <span className="ml-auto">
          <StatusTag status={status} done={done} steps={steps} />
        </span>
      </span>
      <button
        type="button"
        className="absolute top-2.5 right-2.5 z-1 flex size-7 items-center justify-center rounded-md border border-border bg-surface text-muted opacity-0 transition-opacity group-hover/card:opacity-100 group-has-[a:focus-visible]/card:opacity-100 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 pointer-coarse:opacity-100"
        aria-label={`Quick look: ${title}`}
        title="Quick look (Space)"
        onClick={onQuickLook}
      >
        <EyeIcon className="size-3.5" aria-hidden="true" />
      </button>
    </article>
  );
}
