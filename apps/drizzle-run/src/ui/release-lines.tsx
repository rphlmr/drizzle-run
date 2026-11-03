import { DIALECTS, type Dialect, type GuestFlavor } from "@drizzle-run/core/catalog";

import { cn } from "../lib/utils";
import { KindBadge } from "./kind-badge";
import { formatPairText, getReleaseLabel } from "./release-options";
import { EffectBadge } from "./release-pair";

/** One side of a project or share, as a list row shows it. */
export interface ReleaseLine {
  /** The author's name for the side; undefined when it goes by its release. */
  name: string | undefined;
  dialect: Dialect;
  ormVersion: string;
  kitVersion: string;
  guestFlavor: GuestFlavor;
}

/**
 * Each side's database, exact ORM and Kit pair, release line and Effect flavor, one line per side
 *
 * A named side starts with its name, so the two lines of a side by side read apart.
 */
export function ReleaseLines({ lines, className }: { lines: readonly ReleaseLine[]; className?: string }) {
  return (
    <span className={cn("flex flex-col gap-1", className)}>
      {lines.map((line, index) => (
        <span key={index} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="flex items-center gap-2 whitespace-nowrap">
            {line.name !== undefined && <span className="text-[12px] text-muted">{line.name}</span>}
            <span>{DIALECTS[line.dialect].label}</span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-[12.5px] whitespace-nowrap text-soft">
              {formatPairText(line.ormVersion, line.kitVersion)}
            </span>
            <KindBadge tone="neutral">{getReleaseLabel(line.ormVersion)}</KindBadge>
            {line.guestFlavor === "effect" && <EffectBadge />}
          </span>
        </span>
      ))}
    </span>
  );
}
