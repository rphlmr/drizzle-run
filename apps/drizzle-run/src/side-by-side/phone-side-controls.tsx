import type { PairSideIndex } from "@drizzle-run/core/pair";

import { cn } from "../lib/utils";
import type { WorkView } from "../workspace/workspace-view-machine";
import type { SideRelease } from "./side-labels";
import { getShownSideTab, listSideTabs, SidePillChip, sideTabLabels, useSideStatus, type SideTab } from "./side-output";

export interface PhoneSideControlsProps {
  releases: readonly [SideRelease, SideRelease];
  side: PairSideIndex;
  onSide: (side: PairSideIndex) => void;
  /** The shown side's pill label before a first run while its runtime is not ready. */
  preparing: string | undefined;
  view: WorkView;
  /** The shown side's output view: a phone picks it beside Code. */
  tab: SideTab;
  onView: (view: WorkView) => void;
  onTab: (tab: SideTab) => void;
  selected: string;
}

/**
 * Switch sides and output views on phones. Run status comes from the closest `RunProvider`.
 */
export function PhoneSideControls({
  releases,
  side,
  onSide,
  preparing,
  view,
  tab,
  onView,
  onTab,
  selected,
}: PhoneSideControlsProps) {
  const { run, pill } = useSideStatus(preparing);
  const release = releases[side];
  const shownTab = getShownSideTab(tab, run);
  const views = [
    { key: "code", label: "Code", count: selected, selected: view === "code", pick: () => onView("code") },
    ...listSideTabs(run).map((item) => ({
      key: item,
      label: sideTabLabels[item],
      count: run.ran && item !== "debug" && item !== "story" ? String(run.counts[item]) : "",
      selected: view === "output" && item === shownTab,
      pick: () => onTab(item),
    })),
  ];

  return (
    <div className="grid shrink-0 gap-2 px-4 pt-3">
      <div
        className="flex rounded-md border-[1.5px] border-card-border bg-surface p-0.75"
        role="tablist"
        aria-label="Side"
      >
        {releases.map((item) => (
          <button
            key={item.side}
            type="button"
            role="tab"
            aria-selected={item.side === side}
            className="relative inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-base border-0 bg-transparent text-[13.5px] font-semibold text-muted after:absolute after:inset-x-0 after:-inset-y-1 aria-selected:bg-segment aria-selected:text-segment-fg"
            onClick={() => onSide(item.side)}
          >
            <span className="max-w-32 truncate font-mono text-[14px]">{item.label}</span>
            <span className="shrink-0 text-[12px] opacity-80">{item.name === "" ? item.line : item.short}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span className="min-w-0 truncate font-mono">
          {release.line} · {release.pair}
        </span>
        <span className="flex-1" />
        <SidePillChip pill={pill} />
      </div>
      <div className="flex gap-1 rounded-md bg-surface-2 p-0.75" role="tablist" aria-label={`${release.label} view`}>
        {views.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={item.selected}
            className="relative inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-base border-0 bg-transparent text-[13.5px] font-semibold text-muted after:absolute after:inset-x-0 after:-inset-y-1 aria-selected:bg-surface aria-selected:text-text aria-selected:shadow-[0_0_0_1px_var(--border)]"
            onClick={item.pick}
          >
            {item.label}
            {item.count !== "" && (
              <span
                className={cn(
                  "inline-flex h-5 max-w-24 items-center truncate rounded-pill bg-surface-2 px-2 text-[11px] font-semibold text-muted",
                  item.key === "problems" && "bg-err-bg text-err",
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
