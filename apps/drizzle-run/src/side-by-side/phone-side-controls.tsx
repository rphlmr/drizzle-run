import type { PairSideIndex } from "@drizzle-run/core/pair";

import { cn } from "../lib/utils";
import { PhoneOutputSlot } from "../ui/phone-output-slot";
import { phoneTabClass } from "../ui/phone-view-switch";
import type { WorkView } from "../workspace/workspace-view-machine";
import type { SideRelease } from "./side-labels";
import { getShownSideTab, listSideTabs, sideTabLabels, useSideStatus, type SideTab } from "./side-output";

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
}

/**
 * Switch sides and output views on phones: the sides as a segmented track, then Code and the output views as one row
 * of tabs; the output draws the shown side's run status. Run status comes from the closest `RunProvider`.
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
}: PhoneSideControlsProps) {
  const { run } = useSideStatus(preparing);
  const release = releases[side];
  const shownTab = getShownSideTab(tab, run);
  const views = [
    { key: "code", label: "Code", count: "", selected: view === "code", pick: () => onView("code") },
    ...listSideTabs(run).map((item) => ({
      key: item,
      label: sideTabLabels[item],
      count: run.ran && item !== "debug" && item !== "story" ? String(run.counts[item]) : "",
      selected: view === "output" && item === shownTab,
      pick: () => onTab(item),
    })),
  ];

  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-1 bg-surface pt-2.5">
      <div className="mx-3 flex rounded-md bg-surface-2 p-0.75" role="tablist" aria-label="Side">
        {releases.map((item) => (
          <button
            key={item.side}
            type="button"
            role="tab"
            aria-selected={item.side === side}
            title={`${item.line} · ${item.pair}`}
            className="relative inline-flex min-h-8.5 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-base border-0 bg-transparent px-2 text-[13px] font-medium text-muted after:absolute after:inset-x-0 after:-inset-y-1 aria-selected:bg-surface aria-selected:text-text aria-selected:shadow-[0_0_0_1px_var(--card-border),var(--shadow-sticker-lg)]"
            onClick={() => onSide(item.side)}
          >
            <span className="max-w-28 truncate font-mono">{item.label}</span>
            <span className="shrink-0 text-[12px] text-muted">{item.name === "" ? item.line : item.short}</span>
          </button>
        ))}
      </div>
      <div className="flex min-h-13 min-w-0 items-center gap-2 border-b border-border px-3">
        <div
          className="flex min-w-0 flex-1 scrollbar-none gap-0.5 overflow-x-auto mask-[linear-gradient(to_right,black_calc(100%-24px),transparent)] py-1 pr-6 [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label={`${release.label} view`}
        >
          {views.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.selected}
              className={phoneTabClass}
              onClick={item.pick}
            >
              {item.label}
              {item.count !== "" && (
                <span className={cn("text-[11px] text-muted", item.key === "problems" && "text-err")}>
                  {item.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <PhoneOutputSlot />
      </div>
    </div>
  );
}
