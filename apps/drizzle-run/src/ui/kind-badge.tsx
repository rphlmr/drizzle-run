import type { ReactNode } from "react";

import { cn } from "../lib/utils";

const tones = {
  neutral: "bg-surface-2 text-text",
  lime: "bg-lime text-on-lime",
  outline: "rounded-pill border border-border bg-surface py-px text-text",
} as const;

/** The project header's tags: uppercase pills, the outline one on the card border. */
const headerTones = {
  neutral: "bg-surface-2 text-text",
  lime: "bg-lime text-on-lime",
  outline: "border border-card-border py-px text-text",
} as const;

/** A small tag naming what something is: Official, Guided, Example. */
export function KindBadge({
  tone,
  header = false,
  className,
  children,
}: {
  tone: keyof typeof tones;
  header?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "shrink-0 font-bold whitespace-nowrap",
        header
          ? cn("rounded-pill px-1.75 py-0.5 text-[10.5px] tracking-[0.02em] uppercase", headerTones[tone])
          : cn("rounded-[4px] px-2 py-0.5 text-[11px]", tones[tone]),
        className,
      )}
    >
      {children}
    </span>
  );
}
