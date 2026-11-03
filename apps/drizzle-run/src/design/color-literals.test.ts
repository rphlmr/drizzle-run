import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { palette } from "../embed-loader/palette";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const readColorToken = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]+);`))?.[1];

describe("design tokens", () => {
  it("should keep color literals inside tokens.css", () => {
    const offenders = listFiles(sourceRoot)
      .map((path) => relative(sourceRoot, path))
      .filter((path) => /\.(?:ts|tsx|css)$/.test(path))
      .filter(
        (path) =>
          path !== join("design", "tokens.css") && !path.startsWith("embed-loader/") && !path.endsWith(".test.ts"),
      )
      .flatMap((path) =>
        readFileSync(join(sourceRoot, path), "utf8")
          .split("\n")
          .flatMap((line, index) => (COLOR_LITERAL.test(line) ? [`${path}:${index + 1}`] : [])),
      );

    expect(offenders).toEqual([]);
  });

  it("should paint the pre-load theme-color in index.html with the --bg tokens", () => {
    const tokens = readFileSync(join(sourceRoot, "design", "tokens.css"), "utf8");
    const html = readFileSync(join(sourceRoot, "..", "index.html"), "utf8");
    const background = (selector: string) => tokens.split(selector)[1]?.match(/--bg:\s*(#[0-9a-fA-F]+);/)?.[1];
    const [, dark, light] = html.match(/dark \? "(#[0-9a-fA-F]+)" : "(#[0-9a-fA-F]+)"/) ?? [];

    expect({ light, dark }).toEqual({ light: background(":root {"), dark: background(':root[data-theme="dark"] {') });
    expect(light).toBeDefined();
  });

  it("should repeat the tokens of both themes in the embed loader's palette", () => {
    const tokens = readFileSync(join(sourceRoot, "design", "tokens.css"), "utf8");
    const [light = "", dark = ""] = tokens.split(':root[data-theme="dark"] {');
    const names = Object.keys(palette.light);
    const expected = {
      light: Object.fromEntries(names.map((name) => [name, readColorToken(light, name)])),
      dark: Object.fromEntries(names.map((name) => [name, readColorToken(dark, name) ?? readColorToken(light, name)])),
    };

    expect(palette).toEqual(expected);
  });
});
