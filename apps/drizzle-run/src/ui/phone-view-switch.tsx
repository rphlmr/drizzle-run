import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { selectionIndicatorClass, useSelectionIndicator } from "./use-selection-indicator";

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

function ViewButton({
  option,
  current,
  onClick,
  children,
}: {
  option: PhoneView;
  current: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="relative flex h-9 flex-1 items-center justify-center gap-1.5 rounded-base border-0 bg-transparent text-[13px] font-medium text-muted after:absolute after:inset-x-0 after:-inset-y-1 aria-[current=page]:font-[650] aria-[current=page]:text-text"
      aria-current={current ? "page" : undefined}
      data-option={option}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The phone's Code and Output switch under the header, as a segmented track. */
export function PhoneViewSwitch({ view, onChange, hasNewOutput, badge, aside }: PhoneViewSwitchProps) {
  const failed = badge?.outcome === "failed";
  const { trackRef, indicatorStyle } = useSelectionIndicator(view);

  return (
    <nav className="shrink-0 bg-surface px-3 pt-2 pb-0.75" aria-label="Workspace views">
      <div ref={trackRef} className="relative flex rounded-[11px] bg-surface-2 p-0.75">
        {indicatorStyle && (
          <span
            aria-hidden="true"
            className={cn(selectionIndicatorClass, "rounded-base bg-surface shadow-[0_0_0_1px_var(--border)]")}
            style={indicatorStyle}
          />
        )}
        {aside && (
          <ViewButton option="aside" current={view === "aside"} onClick={() => onChange("aside")}>
            {aside}
          </ViewButton>
        )}
        <ViewButton option="code" current={view === "code"} onClick={() => onChange("code")}>
          Code
        </ViewButton>
        <ViewButton option="output" current={view === "output"} onClick={() => onChange("output")}>
          Output
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
          {hasNewOutput && (
            <span className={cn("size-1.75 rounded-full", failed ? "bg-err" : "bg-ok")}>
              <span className="sr-only">, new results</span>
            </span>
          )}
        </ViewButton>
      </div>
    </nav>
  );
}
