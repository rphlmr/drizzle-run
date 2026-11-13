import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { ChatTarget } from "../connect/chat-panel";
import { ChatDock } from "../connect/chat-panel";
import { cn } from "../lib/utils";
import { AppHeader } from "../shell/app-header";
import { EditorBar } from "../ui/editor-bar";
import { PhoneViewSwitch, phonePaneMotionClass, type PhoneView } from "../ui/phone-view-switch";
import { RailResizeHandle } from "../ui/rail-resize-handle";
import { isRunShortcut } from "../ui/run-shortcut";
import { SidesWorkArea, type WorkspaceSidesWork } from "./sides-work-area";
import { SplitWorkArea, type WorkspaceSplitWork } from "./split-work-area";
import type { WorkspaceView } from "./use-workspace-view";
import { getHeaderPlacement, type WorkspaceLayoutMode } from "./workspace-layout";
import type { WorkspaceViewEvent } from "./workspace-view-machine";

/** The header's own content; the layout places the file tabs and Run. */
export interface WorkspaceHeader {
  leading?: ReactNode;
  /** Header buttons, before Run when Run ends the header. */
  actions: ReactNode;
  /** In the desktop editor bar, or at the end of the embed's and the phone's header. */
  run?: ReactNode;
  /** Whether a phone's header holds Run. Defaults to true. */
  phoneRun?: boolean;
}

/** A panel beside the work area, such as a guide's rail. */
export interface WorkspaceAside {
  /** Names the panel and its phone view. */
  label: string;
  content: ReactNode;
  /** A phone shows it as a bottom sheet below the code and output instead of a view of its own. */
  sheet?: boolean;
  /** Drawn at its content's width, without a resize handle. */
  collapsed?: boolean;
  /**
   * The width a person dragged the rail to, kept by the caller so it outlives this layout, such as a guide whose steps
   * switch between a project and its sides. The rail then keeps the split's drawn width on the sides too.
   */
  railWidth?: RailWidth;
}

/** A rail width kept outside the layout: `null` keeps the rail's drawn width. */
export interface RailWidth {
  px: number | null;
  onChange: (widthPx: number | null) => void;
}

export interface WorkspaceLayoutProps {
  mode: WorkspaceLayoutMode;
  view: WorkspaceView;
  /** Runs on the run shortcut anywhere in the view. */
  onRunShortcut: () => void;
  header: WorkspaceHeader;
  fileTabs: ReactNode;
  banner?: ReactNode;
  /** Replaces the work area, such as the capability message; the editors stay mounted behind it. */
  blocked?: ReactNode;
  aside?: WorkspaceAside;
  work: WorkspaceSplitWork | WorkspaceSidesWork;
  /** The AI chat dock, desktop only: no target means no dock. */
  chat: { target: ChatTarget | undefined; open: boolean; onClose: () => void };
  /** Over the work row, such as a preparation failure dialog. */
  overlay?: ReactNode;
  /** The desktop's status bar. */
  statusBar?: ReactNode;
  /** A phone's footer; phones have no status bar. */
  phoneFooter?: ReactNode;
  dialogs?: ReactNode;
}

type WorkShape = WorkspaceLayoutProps["work"]["shape"];

/** The rail floats as a card: the split pads its row, while the sides keep their own spacing. */
const RAIL_CLASS_NAMES = {
  split: [
    "relative flex min-h-0 max-w-1/2 shrink-0 flex-col",
    "max-phone:w-auto max-phone:max-w-none max-phone:min-w-0 max-phone:flex-1 max-phone:p-3",
  ],
  sides: [
    "relative my-3 ml-3 flex min-h-0 max-w-1/2 shrink-0 flex-col",
    "max-phone:m-0 max-phone:w-auto max-phone:max-w-none max-phone:min-w-0 max-phone:flex-1 max-phone:p-3",
  ],
} as const satisfies Record<WorkShape, readonly string[]>;

/** The rail's drawn width, also the narrowest it goes: the sides leave more room to their two columns. */
const RAIL_WIDTH_CLASS_NAMES = {
  split: "w-[clamp(340px,28vw,440px)] min-w-[clamp(340px,28vw,440px)]",
  sides: "w-75 min-w-75",
} as const satisfies Record<WorkShape, string>;

/** The dock floats in a padded row; beside the sides it keeps the work area's spacing itself. */
const DOCK_CLASS_NAMES = { split: undefined, sides: "my-3 mr-3" } as const satisfies Record<
  WorkShape,
  string | undefined
>;

/** What each button of the phone's view switch sends. */
const PHONE_VIEW_EVENTS = {
  aside: "aside.show",
  code: "code.show",
  output: "output.show",
} as const satisfies Record<PhoneView, WorkspaceViewEvent["type"]>;

/**
 * Workspace layout
 *
 * The three layouts of a project view around the content each view passes in. A desktop draws the header, the work
 * area with the side rail and the AI chat dock, and the status bar; its file tabs and Run sit in the editor bar, at the
 * top of the editor or above both sides. The compact embed draws the code over the output.
 * A phone shows one view at a time under a view switch, the side panel as a view or a bottom sheet, Run in the
 * header, and no status bar.
 */
export function WorkspaceLayout({
  mode,
  view,
  onRunShortcut,
  header,
  fileTabs,
  banner,
  blocked,
  aside,
  work,
  chat,
  overlay,
  statusBar,
  phoneFooter,
  dialogs,
}: WorkspaceLayoutProps) {
  const phone = mode === "phone";
  const compact = mode === "compact";
  const isBlocked = blocked !== undefined;
  const placement = getHeaderPlacement({ mode, blocked: isBlocked, phoneRun: header.phoneRun ?? true });
  const [ownRailWidthPx, setOwnRailWidthPx] = useState<number | null>(null);
  const railWidthPx = aside?.railWidth ? aside.railWidth.px : ownRailWidthPx;
  const setRailWidthPx = aside?.railWidth?.onChange ?? setOwnRailWidthPx;
  const railResizable = aside !== undefined && !aside.collapsed && !phone;
  const dockOpen = chat.target !== undefined && chat.open;
  const editorBar = placement.editorBar && (
    <EditorBar
      tabs={fileTabs}
      layout={work.shape === "sides" ? "card" : "pane"}
      note={
        work.shape === "sides" && <span className="text-[12px] whitespace-nowrap text-muted">Files for both sides</span>
      }
      run={header.run}
    />
  );

  const runShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isRunShortcut(event, event.currentTarget)) {
      event.preventDefault();
      event.stopPropagation();
      onRunShortcut();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={runShortcut}>
      <AppHeader
        logo={!compact}
        compact={compact}
        playground={!compact && !isBlocked}
        leading={compact ? undefined : header.leading}
        tabs={placement.tabsInHeader ? fileTabs : undefined}
        actions={
          <>
            {header.actions}
            {placement.runInActions && header.run}
          </>
        }
      />
      {banner}
      {phone && !isBlocked && work.shape === "sides" && aside && !aside.sheet && (
        <PhoneAsideSwitch label={aside.label} view={view} />
      )}
      {phone && !isBlocked && work.shape === "split" && (
        <>
          <PhoneViewSwitch
            aside={aside !== undefined && !aside.sheet ? aside.label : undefined}
            view={view.phoneView}
            hasNewOutput={view.unseenOutput}
            badge={work.badge}
            onChange={(next) => view.send({ type: PHONE_VIEW_EVENTS[next] })}
          />
          {view.phoneView === "code" && (
            <div className="shrink-0 scrollbar-none overflow-x-auto border-b border-border bg-surface px-3 pt-1.25 pb-2.5">
              {fileTabs}
            </div>
          )}
        </>
      )}
      {isBlocked && (
        <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-6 *:my-auto max-phone:py-5 max-phone:*:my-0">
          {blocked}
        </main>
      )}
      <div
        className={
          work.shape === "sides"
            ? cn("flex min-h-0 flex-1", phone && aside?.sheet && "flex-col")
            : cn(
                "flex min-h-0 flex-1 flex-col p-3",
                compact && "p-0",
                (aside || dockOpen) && "relative flex-row gap-3 max-phone:flex-col max-phone:gap-0",
                phone && "p-0",
              )
        }
        hidden={isBlocked}
      >
        {aside &&
          (phone && aside.sheet ? (
            <section
              className={cn(
                "relative z-10 order-last flex max-h-[70%] min-h-0 shrink-0 flex-col",
                // Keep result updates from resizing the editor and its panel observers during a run.
                !aside.collapsed && "h-[70%]",
              )}
              aria-label={aside.label}
            >
              {aside.content}
            </section>
          ) : (
            <WorkspaceRail
              aside={aside}
              shape={work.shape}
              phone={phone}
              shown={!phone || view.asideShown}
              resizable={railResizable}
              widthPx={railWidthPx}
              onWidthChange={setRailWidthPx}
            />
          ))}
        {work.shape === "sides" ? (
          <SidesWorkArea phone={phone} view={view} work={work} fileTabs={fileTabs} editorBar={editorBar} />
        ) : (
          <SplitWorkArea
            mode={mode}
            view={view}
            work={work}
            editorBar={editorBar}
            besideColumns={aside !== undefined || chat.target !== undefined}
            railAndDockOpen={railResizable && dockOpen}
          />
        )}
        {chat.target && (
          <ChatDock {...chat.target} open={chat.open} onClose={chat.onClose} className={DOCK_CLASS_NAMES[work.shape]} />
        )}
        {overlay}
      </div>
      {!isBlocked && mode === "desktop" && statusBar}
      {!isBlocked && phone && phoneFooter}
      {dialogs}
    </div>
  );
}

interface WorkspaceRailProps {
  aside: WorkspaceAside;
  shape: WorkShape;
  phone: boolean;
  /** False while a phone shows another view. */
  shown: boolean;
  resizable: boolean;
  widthPx: number | null;
  onWidthChange: (widthPx: number | null) => void;
}

/** The side panel as a rail before the work area, or as a phone's view of its own. */
function WorkspaceRail({ aside, shape, phone, shown, resizable, widthPx, onWidthChange }: WorkspaceRailProps) {
  const rail = useRef<HTMLElement>(null);
  const widthShape: WorkShape = aside.railWidth ? "split" : shape;

  return (
    <aside
      ref={rail}
      className={cn(
        RAIL_WIDTH_CLASS_NAMES[widthShape],
        ...RAIL_CLASS_NAMES[shape],
        aside.collapsed && "w-auto min-w-0",
        phone && shape === "split" && phonePaneMotionClass,
      )}
      style={resizable && widthPx !== null ? { width: widthPx } : undefined}
      aria-label={aside.label}
      hidden={!shown}
    >
      {aside.content}
      {resizable && (
        <RailResizeHandle
          rail={rail}
          edge="right"
          onWidthChange={onWidthChange}
          label={`Resize ${aside.label.toLowerCase()}`}
          className="-right-3"
        />
      )}
    </aside>
  );
}

/** A phone's switch between the side panel and the sides, each side with its own Code and Output switch. */
function PhoneAsideSwitch({ label, view }: { label: string; view: WorkspaceView }) {
  return (
    <nav className="flex shrink-0 gap-1 bg-surface px-4 pt-3" aria-label="Workspace views">
      <div className="flex flex-1 rounded-[11px] bg-surface-2 p-0.75">
        {[label, "Sides"].map((item, index) => (
          <button
            key={item}
            type="button"
            className="relative h-9 flex-1 rounded-base border-0 bg-transparent text-[13px] font-medium text-muted after:absolute after:inset-x-0 after:-inset-y-1 aria-[current=page]:bg-surface aria-[current=page]:font-[650] aria-[current=page]:text-text aria-[current=page]:shadow-[0_0_0_1px_var(--border)]"
            aria-current={(index === 0) === view.asideShown ? "page" : undefined}
            onClick={() => view.send({ type: index === 0 ? "aside.show" : "work.show" })}
          >
            {item}
          </button>
        ))}
      </div>
    </nav>
  );
}
