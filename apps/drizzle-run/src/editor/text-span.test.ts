import { describe, expect, it } from "vitest";

import { findChangedSpan } from "./text-span";

/** `current` with `span` applied, as the editor applies it. */
function applySpan(current: string, next: string): string {
  const span = findChangedSpan(current, next);

  return span === null ? current : `${current.slice(0, span.start)}${span.text}${current.slice(span.end)}`;
}

describe("findChangedSpan", () => {
  it("should return null for equal texts", () => {
    expect(findChangedSpan("same", "same")).toBeNull();
  });

  it("should replace only a typed character", () => {
    expect(findChangedSpan("const a = 1;", "const ab = 1;")).toEqual({ start: 7, end: 7, text: "b" });
  });

  it("should replace only a deleted range", () => {
    expect(findChangedSpan("one two three", "one three")).toEqual({ start: 5, end: 9, text: "" });
  });

  it("should keep a repeated character's edit inside the shorter text", () => {
    expect(applySpan("aaa", "aaaa")).toBe("aaaa");
    expect(applySpan("aaaa", "aa")).toBe("aa");
  });

  it("should not split a surrogate pair", () => {
    const span = findChangedSpan("x 😀 y", "x 😁 y");

    expect(span).toEqual({ start: 2, end: 4, text: "😁" });
  });

  it("should not split a CRLF line break", () => {
    const span = findChangedSpan("a\r\nb", "a\nb");

    expect(span).toEqual({ start: 1, end: 3, text: "\n" });
  });

  it("should give the new text for any pair of texts", () => {
    const texts = ["", "a", "ab", "ba", "a\r\n", "a\n", "😀", "😀😁", "x😁", "\r\n\r\n"];

    for (const current of texts) {
      for (const next of texts) {
        expect(applySpan(current, next)).toBe(next);
      }
    }
  });
});
