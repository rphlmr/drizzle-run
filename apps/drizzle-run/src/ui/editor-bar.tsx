import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export interface EditorBarProps {
  /** The file tabs. */
  tabs: ReactNode;
  /** After the tabs, such as "Files for both sides". */
  note?: ReactNode;
  /** Run, at the bar's right edge. */
  run?: ReactNode;
  /** The top of the editor card, or a card of its own above both sides of a side-by-side project. */
  layout?: "pane" | "card";
}

/**
 * The desktop editor bar
 *
 * Keeps Run visible while overflowing file tabs scroll. The layout can sit inside a pane or above both sides.
 */
export function EditorBar({ tabs, note, run, layout = "pane" }: EditorBarProps) {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 bg-surface px-2",
        layout === "pane" ? "border-b border-border" : "rounded-lg border border-border",
        "**:data-[size=run]:h-8.5 **:data-[size=run]:gap-1.5 **:data-[size=run]:rounded-base **:data-[size=run]:pr-2.5 **:data-[size=run]:pl-3 **:data-[size=run]:text-[13px] **:data-[size=run]:font-bold",
      )}
      data-slot="files-bar"
    >
      <div className="-my-1 min-w-0 flex-[0_1_auto] scrollbar-none overflow-x-auto py-1 [&::-webkit-scrollbar]:hidden">
        {tabs}
      </div>
      {note}
      {run !== undefined && <div className="ml-auto flex shrink-0 items-center">{run}</div>}
    </div>
  );
}
