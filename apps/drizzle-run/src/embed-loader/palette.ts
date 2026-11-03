/**
 * The Drizzle Run color tokens the loader paints with, by their name in
 * apps/drizzle-run/src/design/tokens.css. The loader ships without the app's CSS, so it
 * repeats the values; the app's color-literals.test.ts keeps both equal.
 */
export const palette = {
  light: {
    bg: "#eef0f3",
    surface: "#ffffff",
    "surface-2": "#f0f2f5",
    border: "#dce0e6",
    text: "#191b23",
    "text-muted": "#555d6e",
    "accent-text": "#4a7a0c",
    lime: "#c5f74f",
    "on-lime": "#0a0a0a",
    "run-border": "#0a0a0a",
    "action-edge": "#0a0a0a",
    "card-border": "#c7cdd6",
    ink: "#0a0a0a",
  },
  dark: {
    bg: "#111318",
    surface: "#1c1f26",
    "surface-2": "#272b34",
    border: "#373d49",
    text: "#f1f2f5",
    "text-muted": "#b2b7c4",
    "accent-text": "#c5f74f",
    lime: "#c5f74f",
    "on-lime": "#0a0a0a",
    "run-border": "#e5e5e5",
    "action-edge": "#e5e5e5",
    "card-border": "#4c5360",
    ink: "#0a0a0a",
  },
} as const;

/** A color token name, shared by both themes. */
export type PaletteToken = keyof typeof palette.light;

/**
 * Write custom property declarations for one theme
 *
 * Returns `--name:value;` pairs for every token, in the light palette's key order.
 *
 * @param pick - Returns the CSS value for a token, such as a light value or a `light-dark()` pair
 */
export function paletteProperties(pick: (token: PaletteToken) => string): string {
  let properties = "";
  // Both themes share the light palette's keys; `for...in` types each one as a token.
  let token: PaletteToken;

  for (token in palette.light) {
    properties += `--${token}:${pick(token)};`;
  }

  return properties;
}
