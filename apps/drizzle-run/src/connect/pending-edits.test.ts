import type { PendingEdit } from "@drizzle-run/runtime/machines";
import { describe, expect, it } from "vitest";

import { mergePendingEdits } from "./pending-edits";

function makePendingEdit({ id = "edit-1" }: { id?: string } = {}): PendingEdit {
  return {
    id,
    toolCallId: `call-${id}`,
    createdAt: 1,
    projectId: "project-1",
    projectName: "Project",
    files: [{ path: "query.ts", before: "a", after: "b", added: 1, removed: 1 }],
  };
}

describe("mergePendingEdits", () => {
  it("should keep the other tabs' edits and add this tab's new ones", () => {
    const otherTab = makePendingEdit({ id: "other" });
    const mine = makePendingEdit({ id: "mine" });

    expect(mergePendingEdits([otherTab], [mine], [])).toEqual([otherTab, mine]);
  });

  it("should drop the edits this tab knew and settled since", () => {
    const settled = makePendingEdit({ id: "settled" });

    expect(mergePendingEdits([settled], [], ["settled"])).toEqual([]);
  });

  it("should keep a known edit this tab still waits on while the store holds it", () => {
    const waiting = makePendingEdit({ id: "waiting" });

    expect(mergePendingEdits([waiting], [waiting], ["waiting"])).toEqual([waiting]);
  });

  it("should not write back a known edit another tab settled since this tab read it", () => {
    const settledElsewhere = makePendingEdit({ id: "settled-elsewhere" });
    const mine = makePendingEdit({ id: "mine" });

    expect(mergePendingEdits([], [settledElsewhere, mine], ["settled-elsewhere"])).toEqual([mine]);
  });
});
