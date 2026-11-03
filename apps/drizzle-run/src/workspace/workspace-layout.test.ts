import { describe, expect, it } from "vitest";

import type { ElementSizePx } from "../ui/use-element-size";
import {
  getHeaderPlacement,
  getWorkAreaLayout,
  resolveWorkspaceLayoutMode,
  SIDE_BY_SIDE_PANE_MIN_PX,
  STACKED_PANE_MIN_PX,
  type WorkAreaLayoutOptions,
} from "./workspace-layout";

function makeSize({ widthPx = 1_000, heightPx = 800 }: Partial<ElementSizePx> = {}): ElementSizePx {
  return { widthPx, heightPx };
}

function makeWorkArea({
  mode = "desktop",
  railAndDockOpen = false,
  workAreaSizePx = makeSize(),
}: Partial<WorkAreaLayoutOptions> = {}) {
  return getWorkAreaLayout({ mode, railAndDockOpen, workAreaSizePx });
}

function makeEmbedWorkArea(widthPx: number | null) {
  return makeWorkArea({ mode: "compact", workAreaSizePx: widthPx === null ? null : makeSize({ widthPx }) });
}

describe("resolveWorkspaceLayoutMode", () => {
  it("should keep the embed compact at a phone's width", () => {
    expect(resolveWorkspaceLayoutMode({ phone: true, compact: true })).toBe("compact");
  });

  it("should tell a phone from a desktop outside the embed", () => {
    expect(resolveWorkspaceLayoutMode({ phone: true, compact: false })).toBe("phone");
    expect(resolveWorkspaceLayoutMode({ phone: false, compact: false })).toBe("desktop");
  });
});

describe("getWorkAreaLayout", () => {
  it("should put the editor beside the output on a wide desktop", () => {
    expect(makeWorkArea()).toEqual({
      orientation: "horizontal",
      stacked: false,
      paneMinPx: SIDE_BY_SIDE_PANE_MIN_PX,
      panesResizable: true,
    });
  });

  it("should stack the editor over the output under 720 px", () => {
    expect(makeWorkArea({ workAreaSizePx: makeSize({ widthPx: 719 }) })).toMatchObject({
      orientation: "vertical",
      stacked: true,
      paneMinPx: STACKED_PANE_MIN_PX,
    });
    expect(makeWorkArea({ workAreaSizePx: makeSize({ widthPx: 720 }) }).stacked).toBe(false);
  });

  it("should stack a wide work area while a rail and the chat dock are both open", () => {
    expect(makeWorkArea({ railAndDockOpen: true, workAreaSizePx: makeSize({ widthPx: 2_000 }) }).stacked).toBe(true);
  });

  it("should never stack the output tabs on a phone or in the embed", () => {
    const narrow = makeSize({ widthPx: 300 });

    expect(makeWorkArea({ mode: "phone", railAndDockOpen: true, workAreaSizePx: narrow }).stacked).toBe(false);
    expect(makeWorkArea({ mode: "compact", railAndDockOpen: true, workAreaSizePx: narrow }).stacked).toBe(false);
  });

  it("should put the embed's editor over its output, and beside it from 900 px", () => {
    expect(makeEmbedWorkArea(null).orientation).toBe("vertical");
    expect(makeEmbedWorkArea(899).orientation).toBe("vertical");
    expect(makeEmbedWorkArea(900)).toMatchObject({ orientation: "horizontal", stacked: false });
  });

  it("should keep the handle movable before the work area is measured", () => {
    expect(makeWorkArea({ workAreaSizePx: null })).toEqual({
      orientation: "horizontal",
      stacked: false,
      paneMinPx: SIDE_BY_SIDE_PANE_MIN_PX,
      panesResizable: true,
    });
  });

  it("should fix the handle once both panes sit at their minimum", () => {
    expect(makeWorkArea({ mode: "phone", workAreaSizePx: makeSize({ widthPx: 692 }) }).panesResizable).toBe(false);
    expect(makeWorkArea({ mode: "phone", workAreaSizePx: makeSize({ widthPx: 693 }) }).panesResizable).toBe(true);

    const stackedAt = (heightPx: number) =>
      makeWorkArea({ railAndDockOpen: true, workAreaSizePx: makeSize({ heightPx }) }).panesResizable;

    expect(stackedAt(412)).toBe(false);
    expect(stackedAt(413)).toBe(true);
  });
});

describe("getHeaderPlacement", () => {
  it("should put a desktop's file tabs and Run in the editor bar", () => {
    expect(getHeaderPlacement({ mode: "desktop", blocked: false, phoneRun: true })).toEqual({
      tabsInHeader: false,
      runInActions: false,
      editorBar: true,
    });
  });

  it("should end the embed's header with Run, after its file tabs", () => {
    expect(getHeaderPlacement({ mode: "compact", blocked: false, phoneRun: false })).toEqual({
      tabsInHeader: true,
      runInActions: true,
      editorBar: false,
    });
  });

  it("should move the tabs out of a phone's header and end it with Run unless a side panel has its own", () => {
    expect(getHeaderPlacement({ mode: "phone", blocked: false, phoneRun: true })).toEqual({
      tabsInHeader: false,
      runInActions: true,
      editorBar: false,
    });
    expect(getHeaderPlacement({ mode: "phone", blocked: false, phoneRun: false }).runInActions).toBe(false);
  });

  it("should drop the editor bar and move Run to the header's end while a message replaces the work area", () => {
    expect(getHeaderPlacement({ mode: "desktop", blocked: true, phoneRun: true })).toEqual({
      tabsInHeader: false,
      runInActions: true,
      editorBar: false,
    });
  });
});
