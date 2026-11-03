import { mapValues } from "es-toolkit";
import type * as Monaco from "monaco-editor";

/** The design tokens the editor theme reads, by role, as CSS color values. */
export type MonacoThemeTokens = Record<
  "bg" | "text" | "textMuted" | "codeBg" | "key" | "str" | "fn" | "com" | "border" | "lineHighlight",
  string
>;

const TOKEN_PROPERTIES: Record<keyof MonacoThemeTokens, string> = {
  bg: "--surface",
  text: "--text",
  textMuted: "--text-muted",
  codeBg: "--code-bg",
  key: "--c-key",
  str: "--c-str",
  fn: "--c-fn",
  com: "--c-com",
  border: "--border",
  lineHighlight: "--code-line",
};

// The production CSS minifier shortens six-digit hex to three digits; Monaco accepts only
// the long forms.
function toLongHex(color: string) {
  return /^#[0-9a-f]{3,4}$/i.test(color)
    ? `#${color
        .slice(1)
        .split("")
        .map((digit) => digit + digit)
        .join("")}`
    : color;
}

function stripHash(color: string) {
  return toLongHex(color).replace(/^#/, "");
}

/** Builds the Monaco theme from the design tokens, expanding the short hex colors Monaco rejects. */
export function buildMonacoTheme(
  rawTokens: MonacoThemeTokens,
  base: "vs" | "vs-dark",
): Monaco.editor.IStandaloneThemeData {
  const tokens = mapValues(rawTokens, (value) => toLongHex(value));

  return {
    base,
    inherit: true,
    rules: [
      { token: "keyword", foreground: stripHash(tokens.key) },
      { token: "string", foreground: stripHash(tokens.str) },
      { token: "identifier.function", foreground: stripHash(tokens.fn) },
      { token: "comment", foreground: stripHash(tokens.com), fontStyle: "italic" },
    ],
    colors: {
      "editor.background": tokens.codeBg,
      "editor.foreground": tokens.text,
      "editorLineNumber.foreground": tokens.textMuted,
      "editorLineNumber.activeForeground": tokens.text,
      "editor.lineHighlightBackground": tokens.lineHighlight,
      "editor.lineHighlightBorder": tokens.lineHighlight,
      "editorWidget.background": tokens.bg,
      "editorWidget.border": tokens.border,
      "editorGutter.background": tokens.codeBg,
    },
  };
}

/** Reads the current token values from computed custom properties. */
export function readTokens(element: Element): MonacoThemeTokens {
  const style = getComputedStyle(element);

  return mapValues(TOKEN_PROPERTIES, (property) => style.getPropertyValue(property).trim());
}

/** The Monaco theme name for a `data-theme` value; anything but "dark" is light. */
export function getMonacoThemeName(theme: string | undefined) {
  return theme === "dark" ? "drizzle-dark" : "drizzle-light";
}

let appliedThemeName: string | undefined;

/**
 * Defines and sets the theme for the current `data-theme`, unless it is already set. Colored HTML names its colors
 * by index into the theme set when it was made, so code is colored only after this runs.
 */
export function applyMonacoTheme(monaco: typeof Monaco) {
  const root = document.documentElement;
  const name = getMonacoThemeName(root.dataset.theme);

  if (name === appliedThemeName) {
    return;
  }

  monaco.editor.defineTheme(name, buildMonacoTheme(readTokens(root), root.dataset.theme === "dark" ? "vs-dark" : "vs"));
  monaco.editor.setTheme(name);
  appliedThemeName = name;
}

/** Defines the theme for the current `data-theme` and re-applies it on every change. */
export function watchMonacoTheme(monaco: typeof Monaco): Monaco.IDisposable {
  const root = document.documentElement;
  const apply = () => applyMonacoTheme(monaco);
  const observer = new MutationObserver(apply);

  apply();
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  return { dispose: () => observer.disconnect() };
}
