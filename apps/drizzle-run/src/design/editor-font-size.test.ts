import { describe, expect, it } from "vitest";

import { EDITOR_TEXT, readEditorFontSize, resolveEditorText, writeEditorFontSize } from "./editor-font-size";

/** An in-memory Storage, enough for the code size to round-trip. */
function makeStorage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));

  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe("readEditorFontSize", () => {
  it("should default to each layout's own size when nothing is stored", () => {
    expect(readEditorFontSize(makeStorage())).toBeNull();
    expect(readEditorFontSize(null)).toBeNull();
  });

  it("should default for an unknown value", () => {
    expect(readEditorFontSize(makeStorage({ "editor-font-size": "12" }))).toBeNull();
    expect(readEditorFontSize(makeStorage({ "editor-font-size": "13.5" }))).toBeNull();
    expect(readEditorFontSize(makeStorage({ "editor-font-size": "huge" }))).toBeNull();
  });

  it("should default when storage throws", () => {
    expect(
      readEditorFontSize({
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    ).toBeNull();
  });
});

describe("writeEditorFontSize", () => {
  it("should store a picked size and read it back", () => {
    const storage = makeStorage();

    writeEditorFontSize(storage, 14);

    expect(storage.items.get("editor-font-size")).toBe("14");
    expect(readEditorFontSize(storage)).toBe(14);
  });

  it("should remove the stored size when going back to default", () => {
    const storage = makeStorage({ "editor-font-size": "16" });

    writeEditorFontSize(storage, null);

    expect(storage.items.has("editor-font-size")).toBe(false);
    expect(readEditorFontSize(storage)).toBeNull();
  });

  it("should not throw when storage is full", () => {
    const storage = {
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    };

    expect(() => writeEditorFontSize(storage, 14)).not.toThrow();
  });
});

describe("resolveEditorText", () => {
  it("should keep the layout's text by default", () => {
    expect(resolveEditorText(EDITOR_TEXT.desktop, null)).toEqual({ fontSize: 12.5, lineHeight: 22 });
    expect(resolveEditorText(EDITOR_TEXT.phone, null)).toEqual({ fontSize: 12.5, lineHeight: 20 });
  });

  it("should keep each layout's line height in proportion, in whole pixels", () => {
    expect(resolveEditorText(EDITOR_TEXT.desktop, 14)).toEqual({ fontSize: 14, lineHeight: 25 });
    expect(resolveEditorText(EDITOR_TEXT.desktop, 16)).toEqual({ fontSize: 16, lineHeight: 28 });
    expect(resolveEditorText(EDITOR_TEXT.phone, 14)).toEqual({ fontSize: 14, lineHeight: 22 });
    expect(resolveEditorText({ fontSize: 12.5, lineHeight: 22 }, 14)).toEqual({ fontSize: 14, lineHeight: 25 });
  });
});
