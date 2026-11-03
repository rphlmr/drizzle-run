import type { PairSideIndex } from "@drizzle-run/core/pair";
import type { GroupImperativeHandle, Layout } from "react-resizable-panels";

/** A side's code and output split, linked to the other side's so dragging either handle moves both. */
export interface LinkedSplit {
  /** The code panel's id, unique on the page. */
  codeId: string;
  /** The output panel's id, unique on the page. */
  outputId: string;
  groupRef: (handle: GroupImperativeHandle | null) => void;
  onLayoutChange: (layout: Layout) => void;
}

/** The split handle the linked splits read and move: the panel library's group handle. */
type SplitHandle = Pick<GroupImperativeHandle, "getLayout" | "setLayout">;

/** A side's code or output panel id, unique on the page so both sides' splits can be matched. */
export function getSplitPanelId(side: PairSideIndex, pane: "code" | "output"): string {
  return `side-${side}-${pane}`;
}

/**
 * Create linked splits
 *
 * One split per side of a side-by-side project. A side's layout change moves the other side's split to the same
 * code share; the other split answers with its own change, which the 0.1 % tolerance ends. A side whose split is not
 * mounted, or a layout without the code panel, moves nothing.
 */
export function createLinkedSplits(): readonly [LinkedSplit, LinkedSplit] {
  const handles: [SplitHandle | null, SplitHandle | null] = [null, null];

  const follow = (from: PairSideIndex, layout: Layout) => {
    const to: PairSideIndex = from === 0 ? 1 : 0;
    const other = handles[to];
    const codePercent = layout[getSplitPanelId(from, "code")];

    if (other === null || codePercent === undefined) {
      return;
    }

    const otherCodePercent = other.getLayout()[getSplitPanelId(to, "code")];

    if (otherCodePercent !== undefined && Math.abs(otherCodePercent - codePercent) < 0.1) {
      return;
    }

    other.setLayout({
      [getSplitPanelId(to, "code")]: codePercent,
      [getSplitPanelId(to, "output")]: 100 - codePercent,
    });
  };

  const createSplit = (side: PairSideIndex): LinkedSplit => ({
    codeId: getSplitPanelId(side, "code"),
    outputId: getSplitPanelId(side, "output"),
    groupRef: (handle) => {
      handles[side] = handle;
    },
    onLayoutChange: (layout) => follow(side, layout),
  });

  return [createSplit(0), createSplit(1)];
}
