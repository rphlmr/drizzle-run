import type { ElementSizePx } from "../ui/use-element-size";

/** Where a project view draws: a desktop window, the embed, or a phone. */
export type WorkspaceLayoutMode = "desktop" | "compact" | "phone";

/** Under this, the editor and output stack top and bottom: two columns would be too narrow to read. */
export const STACK_WORK_AREA_BELOW_PX = 720;
/** From this width, the embed puts the editor beside the output instead of over it. */
export const COMPACT_SIDE_BY_SIDE_FROM_PX = 900;
/** The narrowest the editor or the output gets side by side: the output tabs and first-run card still fit. */
export const SIDE_BY_SIDE_PANE_MIN_PX = 340;
/** The shortest the editor or the output gets when stacked. */
export const STACKED_PANE_MIN_PX = 200;
/** The editor/output handle's thickness, between the two panes. */
export const PANE_HANDLE_PX = 12;
/** The embed's editor and output, half each at first; the output scrolls inside past it. */
export const COMPACT_WORK_AREA_HEIGHT_PX = 470;

/** The narrowest a side of a side-by-side project gets when the two sides are resized. */
export const SIDE_MIN_PX = 320;
/** The shortest the code or the output of a side gets. */
export const SIDE_SPLIT_PANE_MIN_PX = 120;
/** A side's output height in pixels before any resize. */
export const SIDE_OUTPUT_DEFAULT_PX = 358;

/**
 * Resolve the layout mode
 *
 * The embed keeps its compact layout at every width, so a phone-sized embed is still compact.
 */
export function resolveWorkspaceLayoutMode({
  phone,
  compact,
}: {
  phone: boolean;
  compact: boolean;
}): WorkspaceLayoutMode {
  if (compact) {
    return "compact";
  }

  return phone ? "phone" : "desktop";
}

/** How the editor and the output share the work area. */
export interface WorkAreaLayout {
  /** The split's direction: the editor beside the output, or over it. */
  orientation: "horizontal" | "vertical";
  /** A desktop stacks the editor over the output, and its output panel stacks its tabs to match. */
  stacked: boolean;
  /** The narrowest (side by side) or shortest (stacked) either pane gets. */
  paneMinPx: number;
  /** False when both panes already sit at their minimum, so the handle between them cannot move. */
  panesResizable: boolean;
}

/** Options of `getWorkAreaLayout`. */
export interface WorkAreaLayoutOptions {
  mode: WorkspaceLayoutMode;
  /** A resizable side rail and the AI chat dock are both open beside the work area. */
  railAndDockOpen: boolean;
  /** The work area's measured size, null before it is measured. */
  workAreaSizePx: ElementSizePx | null;
}

/**
 * Get the work area layout
 *
 * Only a desktop stacks: with a rail and the chat dock both open, four columns leave code and output too narrow to
 * read, so the code stacks over the output in the middle. Without both, they stack only when the work area is
 * narrower than `STACK_WORK_AREA_BELOW_PX`. Before the first measure the handle counts as movable.
 *
 * The embed puts the editor over the output, and beside it from `COMPACT_SIDE_BY_SIDE_FROM_PX`. Before the first
 * measure it keeps them stacked, the shape most embeds have.
 */
export function getWorkAreaLayout({ mode, railAndDockOpen, workAreaSizePx }: WorkAreaLayoutOptions): WorkAreaLayout {
  const narrow = workAreaSizePx !== null && workAreaSizePx.widthPx < STACK_WORK_AREA_BELOW_PX;
  const stacked = mode === "desktop" && (railAndDockOpen || narrow);
  const compactBeside = workAreaSizePx !== null && workAreaSizePx.widthPx >= COMPACT_SIDE_BY_SIDE_FROM_PX;
  const orientation = (mode === "compact" ? !compactBeside : stacked) ? "vertical" : "horizontal";
  const paneMinPx = stacked ? STACKED_PANE_MIN_PX : SIDE_BY_SIDE_PANE_MIN_PX;
  const panesResizable =
    workAreaSizePx === null ||
    (stacked ? workAreaSizePx.heightPx : workAreaSizePx.widthPx) > 2 * paneMinPx + PANE_HANDLE_PX;

  return { orientation, stacked, paneMinPx, panesResizable };
}

/** Where the file tabs and Run go. */
export interface HeaderPlacement {
  /** The embed's file tabs, in its header. */
  tabsInHeader: boolean;
  /** Run at the end of the header's actions. */
  runInActions: boolean;
  /** A desktop's file tabs and Run, in the editor bar above the code. */
  editorBar: boolean;
}

/** Options of `getHeaderPlacement`. */
export interface HeaderPlacementOptions {
  mode: WorkspaceLayoutMode;
  /** A message, such as the capability check's, replaces the work area. */
  blocked: boolean;
  /** Whether a phone's header holds Run; off when a side panel has its own. */
  phoneRun: boolean;
}

/**
 * Get the header placement
 *
 * A desktop draws the file tabs and Run in the editor bar, over the code they run. The embed keeps its tabs in its
 * header and Run at the header's end; a phone moves the tabs under its view switch and Run to the header's end too.
 * While a message replaces the work area there are no tabs, and Run, when the view keeps it, moves to the end.
 */
export function getHeaderPlacement({ mode, blocked, phoneRun }: HeaderPlacementOptions): HeaderPlacement {
  const editorBar = mode === "desktop" && !blocked;

  return {
    tabsInHeader: mode === "compact" && !blocked,
    runInActions: !editorBar && (mode !== "phone" || phoneRun),
    editorBar,
  };
}
