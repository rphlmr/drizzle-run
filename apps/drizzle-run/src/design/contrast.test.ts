import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const [light, dark] = css.split(':root[data-theme="dark"]');

function readColors(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(([, name, hex]) => [name, hex]));
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);

  return (values[0] + 0.05) / (values[1] + 0.05);
}

const lightColors = readColors(light);
const themes = { light: lightColors, dark: { ...lightColors, ...readColors(dark) } };

describe.each(Object.entries(themes))("%s theme contrast", (_name, colors) => {
  it("should keep small interface text readable across neutral surfaces", () => {
    for (const foreground of ["text", "text-soft", "text-muted", "text-faint"]) {
      for (const background of ["bg", "panel", "surface", "surface-2", "code-bg"]) {
        expect(
          contrast(colors[foreground], colors[background]),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("should keep syntax readable on the editor and its active line", () => {
    for (const foreground of ["c-key", "c-str", "c-fn", "c-com"]) {
      for (const background of ["code-bg", "code-line"]) {
        expect(
          contrast(colors[foreground], colors[background]),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("should keep primary action labels readable", () => {
    expect(contrast(colors["on-lime"], colors.lime)).toBeGreaterThanOrEqual(4.5);
  });
});
