import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PHONE_QUERY } from "../ui/use-media-query";

const designRoot = fileURLToPath(new URL(".", import.meta.url));
const srcRoot = fileURLToPath(new URL("..", import.meta.url));

function read(name: string): string {
  return existsSync(join(designRoot, name)) ? readFileSync(join(designRoot, name), "utf8") : "";
}

/** Every stylesheet under src/, comments removed. */
function readStylesheets() {
  return readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".css"))
    .map((path) => ({ path, css: readFileSync(join(srcRoot, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
}

/** Each block's prelude (a selector or an at-rule) with the preludes of the blocks around it. */
function collectRuleSelectors(css: string): { selector: string; wrappers: string[] }[] {
  const open: string[] = [];
  const rules: { selector: string; wrappers: string[] }[] = [];

  for (const [, prelude, brace] of css.matchAll(/([^{};]*)([{}])/g)) {
    if (brace === "}") {
      open.pop();
      continue;
    }

    const selector = prelude.trim();
    rules.push({ selector, wrappers: [...open] });
    open.push(selector);
  }

  return rules;
}

const thumbs = (block: string) =>
  [...block.matchAll(/--scroll-thumb(-hover)?:\s*([^;]+);/g)].map(
    ([, hover, value]) => `${hover ? "hover" : "rest"} ${value}`,
  );

describe("Tailwind theme", () => {
  it("should match PHONE_QUERY with the phone breakpoint", () => {
    const breakpoint = Number(read("theme.css").match(/--breakpoint-phone:\s*(\d+)px/)?.[1]);

    // `max-phone:` compiles to `(width < 780px)`. A `max-width: 779px` query would leave
    // fractional widths in between (browser zoom, Windows scaling) with phone styles on the desktop layout.
    expect({ breakpoint, query: PHONE_QUERY }).toEqual({ breakpoint: 780, query: `(width < ${breakpoint}px)` });
  });

  it("should reference only tokens from theme keys", () => {
    const colors = [...read("theme.css").matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => ({
      name,
      value: value.trim(),
    }));

    expect(colors.length).toBeGreaterThan(0);
    expect(colors.filter(({ value }) => !/^var\(--[a-z0-9-]+\)$/.test(value))).toEqual([]);
  });

  it("should not select a class in any stylesheet", () => {
    const classRules = readStylesheets().flatMap(({ path, css }) =>
      collectRuleSelectors(css)
        .filter(({ selector }) => /(?<!\d)\.[a-zA-Z_-]/.test(selector.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, "")))
        .map(({ selector }) => `${path}: ${selector}`),
    );

    expect(readStylesheets().map(({ path }) => path)).toContain("styles.css");
    expect(classRules).toEqual([]);
  });

  it("should keep only the token blocks outside a cascade layer", () => {
    const unlayered = readStylesheets().flatMap(({ path, css }) =>
      collectRuleSelectors(css)
        .filter(
          ({ selector, wrappers }) =>
            !selector.startsWith("@") &&
            !wrappers.some((wrapper) => /^@(layer|theme|utility|keyframes)\b/.test(wrapper)),
        )
        .map(({ selector }) => `${path}: ${selector}`),
    );

    expect(unlayered).toEqual([
      `${join("design", "tokens.css")}: :root`,
      `${join("design", "tokens.css")}: :root[data-theme="dark"]`,
    ]);
  });

  it("should drop the focus ring only on highlighted menu items", () => {
    const removals = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .flatMap((path) =>
        [...readFileSync(join(srcRoot, path), "utf8").matchAll(/[^\s"'`]*outline-(?:none|hidden|0)(?![\w-])/g)]
          .map(([utility]) => utility)
          .filter((utility) => utility !== "data-highlighted:outline-none")
          .map((utility) => `${path}: ${utility}`),
      );

    expect(removals).toEqual([]);
  });

  it("should read the thumb tokens of both themes for desktop scrollbars", () => {
    const tokens = readFileSync(join(designRoot, "tokens.css"), "utf8");
    const [light = "", dark = ""] = tokens.split(':root[data-theme="dark"]');
    const theme = read("theme.css");

    expect({ light: thumbs(light), dark: thumbs(dark) }).toEqual({
      light: ["rest #9ca3af", "hover #4b5563"],
      dark: ["rest #525252", "hover #a3a3a3"],
    });
    expect(theme).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*var\(--scroll-thumb\)/);
    expect(theme).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--scroll-thumb-hover\)/);
    expect(theme).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\) transparent/);
  });

  it("should declare only allowlisted names in utilities.css", () => {
    const names = [...read("utilities.css").matchAll(/@utility\s+([a-z0-9-]+)/g)].map(([, name]) => name);

    expect(names).toEqual([
      "guide-highlight",
      "guide-highlight-gutter",
      "run-error-line",
      "run-error-line-number",
      "run-error-zone",
      "run-error-pill",
      "run-note-chip",
      "run-note-ok",
      "run-note-err",
      "run-note-plain",
      "run-note-lime",
      "run-note-removed-pill",
      "run-note-eol",
      "run-note-joined",
      "run-note-detail",
      "run-note-zone",
      "run-note-removed",
      "run-note-removed-text",
      "run-note-removed-number",
      "run-note-separator",
      "rich-code",
    ]);
  });
});
