import { describe, expect, it } from "vitest";

import { diffLines, getAddedRanges, getChangedLines } from "./line-diff";

describe("diffLines", () => {
  it("should mark replaced and added lines", () => {
    expect(diffLines("a\n// todo\nc", "a\nb1\nb2\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "// todo" },
      { kind: "added", text: "b1" },
      { kind: "added", text: "b2" },
      { kind: "same", text: "c" },
    ]);
  });
});

describe("getAddedRanges", () => {
  it("should give 1-based ranges in the new file", () => {
    expect(getAddedRanges(diffLines("a\nc\ne", "a\nb\nc\nd1\nd2\ne"))).toEqual([
      { startLine: 2, endLine: 2 },
      { startLine: 4, endLine: 5 },
    ]);
  });
});

describe("getChangedLines", () => {
  it("should number removed lines in the old file and added lines in the new one", () => {
    expect(getChangedLines(diffLines("a\nthrow\nc", "a\nc\nd"))).toEqual([
      { kind: "removed", line: 2, text: "throw" },
      { kind: "added", line: 3, text: "d" },
    ]);
  });
});
