/**
 * The Drizzle Run color tokens the loader paints with, by their name in
 * apps/drizzle-run/src/design/tokens.css. The loader ships without the app's CSS, so it
 * repeats the values; the app's color-literals.test.ts keeps both equal.
 */
export const palette = {
  light: {
    bg: "#f4f4f5",
    surface: "#ffffff",
    "surface-2": "#f4f4f5",
    border: "#e4e4e7",
    text: "#09090b",
    "text-muted": "#66666e",
    "accent-text": "#4a7a0c",
    lime: "#c5f74f",
    "on-lime": "#09090b",
    "run-border": "#c5f74f",
    "action-edge": "#0000001a",
    "card-border": "#d4d4d8",
    ink: "#09090b",
  },
  dark: {
    bg: "#09090b",
    surface: "#121214",
    "surface-2": "#27272a",
    border: "#27272a",
    text: "#fafafa",
    "text-muted": "#a1a1aa",
    "accent-text": "#c5f74f",
    lime: "#c5f74f",
    "on-lime": "#09090b",
    "run-border": "#c5f74f",
    "action-edge": "#00000000",
    "card-border": "#3f3f46",
    ink: "#09090b",
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
