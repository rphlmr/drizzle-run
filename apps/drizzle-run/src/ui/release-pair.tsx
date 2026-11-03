import { cn } from "../lib/utils";
import { EFFECT_BADGE_TEXT } from "./release-options";

/** ORM and Kit versions on two lines that never wrap. */
export function ReleasePair({ ormVersion, kitVersion }: { ormVersion: string; kitVersion: string }) {
  return (
    <span className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[12.5px] whitespace-nowrap text-muted">
      <span>ORM</span>
      <span className="font-semibold text-text">{ormVersion}</span>
      <span>Kit</span>
      <span className="text-text">{kitVersion}</span>
    </span>
  );
}

/** The lime "Newest" badge on the newest pair of a release line. */
export function NewestBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn("shrink-0 rounded-[4px] bg-lime px-1.75 py-0.5 text-[11px] font-semibold text-on-lime", className)}
    >
      Newest
    </span>
  );
}

/** The neutral "+ Effect 4" badge on a pair that runs on the Effect image. Its border keeps Newest's height. */
export function EffectBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[4px] border border-border bg-surface px-1.5 py-px text-[11px] font-semibold text-text",
        className,
      )}
    >
      {EFFECT_BADGE_TEXT}
    </span>
  );
}
