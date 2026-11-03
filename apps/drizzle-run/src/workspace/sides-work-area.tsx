import { PAIR_SIDES, type PairSideIndex } from "@drizzle-run/core/pair";
import { Fragment, useState, type ReactNode } from "react";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { cn } from "../lib/utils";
import { createLinkedSplits, type LinkedSplit } from "./linked-splits";
import type { WorkspaceView } from "./use-workspace-view";
import { SIDE_MIN_PX } from "./workspace-layout";

/** What the layout hands each side. */
export interface WorkspaceSideSlots {
  /** The side's code and output split, linked to the other side's. */
  split: LinkedSplit;
  /** The phone's file tabs, above the side's code; undefined outside phones. */
  fileTabs: ReactNode;
}

/**
 * Two sides, each with its own code and output split. The sides sit flush in the row, the rail on its edge; a phone
 * shows one side at a time, with its own Code and Output switch.
 */
export interface WorkspaceSidesWork {
  shape: "sides";
  /** The phone's side tabs and the shown side's Code and Output switch. */
  phoneControls: ReactNode;
  /** Above both sides, such as the pending AI edit banners and the seed switch. */
  top: ReactNode;
  renderSide: (side: PairSideIndex, slots: WorkspaceSideSlots) => ReactNode;
}

export interface SidesWorkAreaProps {
  phone: boolean;
  view: WorkspaceView;
  work: WorkspaceSidesWork;
  fileTabs: ReactNode;
  /** The desktop's "Files for both sides" bar, with the file tabs and Run both, above both sides. */
  editorBar: ReactNode;
}

/**
 * Sides work area
 *
 * Both sides of a side-by-side project in one resizable row, each side's code and output split linked to the other's.
 * A phone shows the side its side tabs pick, with no handle between the sides.
 */
export function SidesWorkArea({ phone, view, work, fileTabs, editorBar }: SidesWorkAreaProps) {
  const [linkedSplits] = useState(createLinkedSplits);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col p-3 max-phone:p-0" hidden={phone && view.asideShown}>
      {phone && work.phoneControls}
      {editorBar && <div className="mb-3 flex flex-col">{editorBar}</div>}
      {work.top}
      {/* Always a panel group, so each side's editor host keeps its place in the tree. A phone's panels are disabled:
          the library hit-tests the hidden handle at the page's top left, over the header. */}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {PAIR_SIDES.map((side) => (
          <Fragment key={side}>
            {side === 1 && <ResizableHandle aria-label="Resize the two sides" className={cn(phone && "hidden")} />}
            <ResizablePanel
              id={`side-${side}`}
              defaultSize="50%"
              minSize={SIDE_MIN_PX}
              hidden={phone && side !== view.side}
              disabled={phone}
              className="flex min-w-0 flex-col"
            >
              {work.renderSide(side, { split: linkedSplits[side], fileTabs: phone ? fileTabs : undefined })}
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    </main>
  );
}
