import { describe, expect, it } from "vitest";

import { shouldWarnOnUnload, type SaveState } from "./save-state";

describe("shouldWarnOnUnload", () => {
  it.each<SaveState>(["temporary", "guided_read_only", "side_by_side_step", "read_only", "saved"])(
    "should not warn for a clean %s copy",
    (saveState) => {
      expect(shouldWarnOnUnload({ saveState, unsavedCopy: false })).toBe(false);
    },
  );

  it("should warn for an edited temporary copy", () => {
    expect(shouldWarnOnUnload({ saveState: "temporary", unsavedCopy: true })).toBe(true);
  });

  it.each<SaveState>(["saving", "save_error", "unsaved"])(
    "should warn while the store has not saved: %s",
    (saveState) => {
      expect(shouldWarnOnUnload({ saveState, unsavedCopy: false })).toBe(true);
    },
  );
});
