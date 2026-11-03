import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { phonePaneMotionClass, type PhoneOutputBadge } from "../ui/phone-view-switch";
import { useElementSizePx } from "../ui/use-element-size";
import { CodeOutputSplit } from "./code-output-split";
import type { WorkspaceView } from "./use-workspace-view";
import {
  COMPACT_WORK_AREA_HEIGHT_PX,
  getWorkAreaLayout,
  type WorkAreaLayout,
  type WorkspaceLayoutMode,
} from "./workspace-layout";

/** One work area: the editor beside or over its output. The panes float as cards in a padded row. */
export interface WorkspaceSplitWork {
  shape: "split";
  /** The editor, with the desktop editor bar to draw at its top; the bar is false on the embed and phones. */
  renderEditor: (editorBar: ReactNode) => ReactNode;
  /** The output, told whether the editor sits over it. */
  renderOutput: (layout: WorkAreaLayout) => ReactNode;
  /** The phone's Output switch badge, undefined before the first run. */
  badge?: PhoneOutputBadge;
}

export interface SplitWorkAreaProps {
  mode: WorkspaceLayoutMode;
  view: WorkspaceView;
  work: WorkspaceSplitWork;
  /** The desktop's file tabs and Run, at the top of the editor. */
  editorBar: ReactNode;
  /** A rail or the AI chat dock sits in the row, so the work area may shrink below its content. */
  besideColumns: boolean;
  /** A resizable rail and the AI chat dock are both open. */
  railAndDockOpen: boolean;
}

/**
 * Split work area
 *
 * The editor and its output in one resizable split. A desktop puts them side by side, or stacks them when the work
 * area is narrow or a rail and the chat dock are both open; the embed stacks them until it is wide. A handle that cannot move
 * is not drawn. A phone shows one pane at a time and fades it in.
 *
 * The embed's work area starts at `COMPACT_WORK_AREA_HEIGHT_PX`, its flex basis rather than its height: the embed
 * reports it, and a host page that gives the embed a height of its own wins. The output scrolls inside either way.
 */
export function SplitWorkArea({ mode, view, work, editorBar, besideColumns, railAndDockOpen }: SplitWorkAreaProps) {
  const phone = mode === "phone";
  const compact = mode === "compact";
  const { ref: workArea, sizePx: workAreaSizePx } = useElementSizePx();
  const layout = getWorkAreaLayout({ mode, railAndDockOpen, workAreaSizePx });
  const { orientation, stacked, paneMinPx, panesResizable } = layout;

  return (
    <CodeOutputSplit
      elementRef={workArea}
      orientation={orientation}
      className={cn("min-h-0 flex-1", besideColumns && "min-w-0", phone && phonePaneMotionClass)}
      style={compact ? { flexBasis: COMPACT_WORK_AREA_HEIGHT_PX } : undefined}
      hidden={phone && view.asideShown}
      phone={phone}
      phoneView={view.phoneView}
      motion
      code={{ content: work.renderEditor(editorBar), defaultSize: "50%", minSize: compact ? "30%" : paneMinPx }}
      output={{ content: work.renderOutput(layout), defaultSize: "50%", minSize: compact ? "25%" : paneMinPx }}
      handle={{
        label: "Resize editor and output",
        className: cn(
          compact && "bg-border",
          stacked && "aria-[orientation=horizontal]:h-3",
          !compact && !panesResizable && "pointer-events-none after:hidden",
        ),
        disabled: !compact && !panesResizable,
      }}
    />
  );
}
