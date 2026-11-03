import { describe, expect, it } from "vitest";

import { getRunTooltip, isRunShortcut } from "./run-shortcut";

const editor = { id: "editor" };
const dialogInput = { id: "dialog-input" };
const workspace = { contains: (node: unknown) => node === editor };

describe("isRunShortcut", () => {
  it("should run on Cmd+Enter or Ctrl+Enter inside the workspace", () => {
    expect(isRunShortcut({ key: "Enter", metaKey: true, ctrlKey: false, target: editor }, workspace)).toBe(true);
    expect(isRunShortcut({ key: "Enter", metaKey: false, ctrlKey: true, target: editor }, workspace)).toBe(true);
  });

  it("should ignore plain Enter", () => {
    expect(isRunShortcut({ key: "Enter", metaKey: false, ctrlKey: false, target: editor }, workspace)).toBe(false);
  });

  it("should ignore the shortcut from a dialog or menu rendered outside the workspace", () => {
    expect(isRunShortcut({ key: "Enter", metaKey: true, ctrlKey: false, target: dialogInput }, workspace)).toBe(false);
  });
});

describe("getRunTooltip", () => {
  it("should name the project's own run and seed files", () => {
    expect(getRunTooltip({ run: "main.ts", seed: "fixtures.ts" }, "Ctrl Enter")).toBe(
      "Run fixtures.ts, then main.ts · Ctrl Enter",
    );
  });

  it("should leave the seed out when seed execution is off", () => {
    expect(getRunTooltip({ run: "query.ts" }, "⌘ Return")).toBe("Run query.ts · ⌘ Return");
  });

  it("should say why nothing runs without a run file", () => {
    expect(getRunTooltip({}, "⌘ Return")).toBe("No file is set to run");
  });
});
