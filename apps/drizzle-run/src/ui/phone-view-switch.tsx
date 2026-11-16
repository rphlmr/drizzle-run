import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { PhoneOutputSlot } from "./phone-output-slot";

/**
 * Fades a phone pane in each time it is shown. Panes stay mounted behind `hidden`, so the editor keeps its state, and
 * leaving `display: none` restarts the transition from its `starting:` style.
 */
export const phonePaneMotionClass = cn("transition-opacity duration-(--motion-fast) ease-out starting:opacity-0");

/** The pane a phone shows at a time. */
export type PhoneView = "aside" | "code" | "output";

/** What the shown run left in the output, for the badge on the Output switch. */
export interface PhoneOutputBadge {
  outcome: "succeeded" | "failed";
  /** Results after a success, problems after a failure. */
  count: number;
}

export interface PhoneViewSwitchProps {
  view: PhoneView;
  onChange: (view: PhoneView) => void;
  /** A run settled since the reader last looked at the output. */
  hasNewOutput: boolean;
  /** Undefined before the first run of the tab. */
  badge?: PhoneOutputBadge;
  /** Names a first view for a side panel, such as "Guide". */
  aside?: string;
}

/** A phone's view tab, drawn as the desktop output's tabs: muted text, a gray pill on the shown one, a 44 px hit area. */
export const phoneTabClass = cn(
  "relative flex h-9 shrink-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-3 text-[13px] font-medium whitespace-nowrap text-muted transition-colors duration-(--motion-fast) after:absolute after:inset-x-0 after:-inset-y-1 aria-selected:bg-surface-2 aria-selected:text-text aria-[current=page]:bg-surface-2 aria-[current=page]:text-text",
);

function ViewTab({ current, onClick, children }: { current: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={phoneTabClass} aria-current={current ? "page" : undefined} onClick={onClick}>
      {children}
    </button>
  );
}

/** The count a run left on a tab: results after a success, problems after a failure, and a dot while it is unseen. */
function OutputMark({ badge, fresh }: { badge: PhoneOutputBadge | undefined; fresh: boolean }) {
  const failed = badge?.outcome === "failed";

  return (
    <>
      {badge && badge.count > 0 && (
        <span
          className={cn(
            "rounded-pill px-1.5 py-px text-[11px] font-semibold",
            failed ? "bg-err-bg text-err" : "bg-lime text-on-lime",
          )}
        >
          {badge.count}
          <span className="sr-only">
            {failed ? (badge.count === 1 ? " problem" : " problems") : badge.count === 1 ? " result" : " results"}
          </span>
        </span>
      )}
      {fresh && (
        <span className={cn("size-1.75 rounded-full", failed ? "bg-err" : "bg-ok")}>
          <span className="sr-only">, new results</span>
        </span>
      )}
    </>
  );
}

/**
 * The phone's views under the header, as one row of tabs drawn like the desktop output's: the side panel when it has a
 * view, Code and Output. The output's run status ends the row, so it shows from every view.
 */
export function PhoneViewSwitch({ view, onChange, hasNewOutput, badge, aside }: PhoneViewSwitchProps) {
  return (
    <div className="flex min-h-13 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <nav
        className="flex min-w-0 flex-1 scrollbar-none gap-1 overflow-x-auto py-1 [&::-webkit-scrollbar]:hidden"
        aria-label="Workspace views"
      >
        {aside && (
          <ViewTab current={view === "aside"} onClick={() => onChange("aside")}>
            {aside}
          </ViewTab>
        )}
        <ViewTab current={view === "code"} onClick={() => onChange("code")}>
          Code
        </ViewTab>
        <ViewTab current={view === "output"} onClick={() => onChange("output")}>
          Output
          <OutputMark badge={badge} fresh={hasNewOutput} />
        </ViewTab>
      </nav>
      <PhoneOutputSlot />
    </div>
  );
}
