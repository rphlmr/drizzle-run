import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const BASE_FOLDERS = ["lib", "components", "design", "ui"];

const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"'?]+)[^"']*["']/g;

function listModules(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    if (statSync(path).isDirectory()) {
      return listModules(path);
    }

    return /\.tsx?$/.test(name) && !/\.(?:d|test)\.ts$/.test(name) ? [path] : [];
  });
}

describe("base folders", () => {
  it("should import nothing outside lib, components, design and ui", () => {
    const outsideImports = BASE_FOLDERS.flatMap((folder) => listModules(join(sourceRoot, folder))).flatMap((module) =>
      [...readFileSync(module, "utf8").matchAll(RELATIVE_IMPORT)]
        .map(([, specifier = ""]) => relative(sourceRoot, resolve(module, "..", specifier)))
        .filter((target) => !target.startsWith("..") && !BASE_FOLDERS.includes(target.split("/")[0] ?? ""))
        .map((target) => `${relative(sourceRoot, module)} -> ${target}`),
    );

    expect(outsideImports).toEqual([]);
  });
});
