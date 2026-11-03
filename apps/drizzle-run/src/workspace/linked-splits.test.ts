import type { GroupImperativeHandle, Layout } from "react-resizable-panels";
import { describe, expect, it } from "vitest";

import { createLinkedSplits, getSplitPanelId } from "./linked-splits";

/** A split handle that records the layouts it was given and answers with the last one. */
function makeHandle({ layout = {} }: { layout?: Layout } = {}) {
  const setLayouts: Layout[] = [];
  let current = layout;
  const handle: GroupImperativeHandle = {
    getLayout: () => current,
    setLayout: (next) => {
      setLayouts.push(next);
      current = next;

      return next;
    },
  };

  return { handle, setLayouts };
}

describe("createLinkedSplits", () => {
  it("should name each side's panels apart", () => {
    const [first, second] = createLinkedSplits();

    expect([first.codeId, first.outputId, second.codeId, second.outputId]).toEqual([
      "side-0-code",
      "side-0-output",
      "side-1-code",
      "side-1-output",
    ]);
  });

  it("should move the other side's split to the same code share", () => {
    const [first, second] = createLinkedSplits();
    const other = makeHandle({ layout: { [getSplitPanelId(1, "code")]: 50, [getSplitPanelId(1, "output")]: 50 } });

    second.groupRef(other.handle);
    first.onLayoutChange({ [getSplitPanelId(0, "code")]: 70, [getSplitPanelId(0, "output")]: 30 });

    expect(other.setLayouts).toEqual([{ "side-1-code": 70, "side-1-output": 30 }]);
  });

  it("should end the echo once the other side already sits at that share", () => {
    const [first, second] = createLinkedSplits();
    const other = makeHandle({ layout: { "side-1-code": 70.05, "side-1-output": 29.95 } });

    second.groupRef(other.handle);
    first.onLayoutChange({ "side-0-code": 70, "side-0-output": 30 });

    expect(other.setLayouts).toEqual([]);
  });

  it("should move nothing while the other side's split is not mounted", () => {
    const [first, second] = createLinkedSplits();
    const other = makeHandle();

    second.groupRef(other.handle);
    second.groupRef(null);
    first.onLayoutChange({ "side-0-code": 70, "side-0-output": 30 });

    expect(other.setLayouts).toEqual([]);
  });
});
