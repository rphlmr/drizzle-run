/**
 * The Drizzle Run color tokens the loader paints with, by their name in
 * apps/drizzle-run/src/design/tokens.css. The loader ships without the app's CSS, so it
 * repeats the values; the app's color-literals.test.ts keeps both equal.
 */
export const palette = {
  light: {
    bg: "#ffffff",
    surface: "#ffffff",
    "surface-2": "#f3f4f6",
    border: "#e5e7eb",
    text: "#0a0a0a",
    "text-muted": "#4b5563",
    "accent-text": "#4a7a0c",
    lime: "#c5f74f",
    "on-lime": "#0a0a0a",
    "run-border": "#0a0a0a",
    "card-border": "#0a0a0a",
    ink: "#0a0a0a",
  },
  dark: {
    bg: "#111111",
    surface: "#1a1a1a",
    "surface-2": "#242424",
    border: "#303030",
    text: "#f3f4f6",
    "text-muted": "#a3a3a3",
    "accent-text": "#c5f74f",
    lime: "#c5f74f",
    "on-lime": "#0a0a0a",
    "run-border": "#e5e5e5",
    "card-border": "#e5e5e5",
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
