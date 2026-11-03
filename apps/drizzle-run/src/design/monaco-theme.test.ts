import type * as Monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import { applyMonacoTheme, buildMonacoTheme } from "./monaco-theme";

const tokens = {
  bg: "#ffffff",
  text: "#0a0a0a",
  textMuted: "#4b5563",
  codeBg: "#ffffff",
  key: "#7c3aed",
  str: "#0f6b4a",
  fn: "#1d4ed8",
  com: "#4b5563",
  border: "#e5e7eb",
  markBg: "#eef6d9",
};

describe("Monaco theme", () => {
  it("should paint the editor from tokens", () => {
    const theme = buildMonacoTheme(tokens, "vs");

    expect(theme.base).toBe("vs");
    expect(theme.colors["editor.background"]).toBe("#ffffff");
    expect(theme.rules).toContainEqual({ token: "keyword", foreground: "7c3aed" });
    expect(theme.rules).toContainEqual({ token: "string", foreground: "0f6b4a" });
  });

  it("should expand short hex values that the CSS minifier produces", () => {
    const theme = buildMonacoTheme({ ...tokens, codeBg: "#fff", key: "#7c3", border: "#000a" }, "vs");

    expect(theme.colors["editor.background"]).toBe("#ffffff");
    expect(theme.colors["editorWidget.border"]).toBe("#000000aa");
    expect(theme.rules).toContainEqual({ token: "keyword", foreground: "77cc33" });
  });
});

describe("applyMonacoTheme", () => {
  it("should set the theme for data-theme once, and again after it changes", () => {
    const root = { dataset: { theme: "light" } as Record<string, string | undefined> };
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#ffffff" }));
    const editor = { defineTheme: vi.fn(), setTheme: vi.fn() };
    const monaco = { editor } as unknown as typeof Monaco;

    applyMonacoTheme(monaco);
    applyMonacoTheme(monaco);
    root.dataset.theme = "dark";
    applyMonacoTheme(monaco);

    expect(editor.setTheme.mock.calls).toEqual([["drizzle-light"], ["drizzle-dark"]]);
    expect(editor.defineTheme.mock.calls.map(([name, theme]) => [name, theme.base])).toEqual([
      ["drizzle-light", "vs"],
      ["drizzle-dark", "vs-dark"],
    ]);

    vi.unstubAllGlobals();
  });
});
