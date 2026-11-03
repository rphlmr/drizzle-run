import { describe, expect, it } from "vitest";

import { findUnresolvedSpecifiers, isSpecifierExported, resolveExportPattern } from "./package-exports.ts";

/** An exports map shaped like effect 4.0 stable's: subpaths through a pattern, with some excluded. */
const effectStable = {
  name: "effect",
  version: "4.0.5",
  exports: { "./package.json": "./package.json", ".": "./dist/index.js", "./*": "./dist/*.js", "./internal/*": null },
};

describe("resolveExportPattern", () => {
  it("should replace the wildcard with the matched part", () => {
    expect(resolveExportPattern(effectStable.exports, "./sql/SqlClient")).toBe("./dist/sql/SqlClient.js");
  });

  it("should prefer the most specific pattern and honor its exclusion", () => {
    expect(resolveExportPattern(effectStable.exports, "./internal/core")).toBeUndefined();
  });
});

describe("isSpecifierExported", () => {
  it("should accept exact keys and patterns, and refuse a missing or excluded subpath", () => {
    const typebox = { name: "typebox", version: "1.2.19", exports: { ".": "./build/index.mjs", "./value": "./v.mjs" } };

    expect(isSpecifierExported(typebox, "typebox/value")).toBe(true);
    expect(isSpecifierExported(typebox, "typebox/compiler")).toBe(false);
    expect(isSpecifierExported(effectStable, "effect/sql/SqlClient")).toBe(true);
    expect(isSpecifierExported(effectStable, "effect/internal/core")).toBe(false);
  });

  it("should expose only the package itself through a non-subpath exports value", () => {
    const valibot = { name: "valibot", version: "1.4.2", exports: { import: "./dist/index.js" } };

    expect(isSpecifierExported(valibot, "valibot")).toBe(true);
    expect(isSpecifierExported(valibot, "valibot/schemas")).toBe(false);
  });

  it("should leave a package without exports to its declaration lookup", () => {
    expect(isSpecifierExported({ name: "legacy", version: "1.0.0" }, "legacy/anything")).toBe(true);
  });
});

describe("findUnresolvedSpecifiers", () => {
  it("should report each specifier a pinned version does not export or declare", () => {
    const problems = findUnresolvedSpecifiers({
      packageMetadata: effectStable,
      specifiers: ["effect", "effect/unstable/reactivity/Reactivity", "effect/internal/core"],
      resolveDeclaration: (specifier) => {
        if (specifier.startsWith("effect/unstable/")) {
          throw new Error(`No declaration file for ${specifier}`);
        }

        return "index.d.ts";
      },
    });

    expect(problems).toEqual([
      {
        specifier: "effect/unstable/reactivity/Reactivity",
        reason: "effect@4.0.5 has no declaration file for it",
      },
      { specifier: "effect/internal/core", reason: "effect@4.0.5 does not export it" },
    ]);
  });
});
