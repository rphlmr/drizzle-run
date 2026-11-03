import type { ProjectCompilerOptions } from "@drizzle-run/runtime/type-environment";
import { describe, expect, it } from "vitest";

import { resolveMonacoLibraries } from "./libraries";

// Monaco's index of the lib files its bundled TypeScript ships has no type declarations, so TypeScript must not
// resolve the specifier.
const monacoLibIndexSpecifier: string = "monaco-editor/languages/features/typescript/lib/lib.index";
const { libFileSet }: { libFileSet: Record<string, true> } = await import(monacoLibIndexSpecifier);

const guestLibraries: ProjectCompilerOptions["lib"] = [
  "ES2022",
  "ES2023.Array",
  "ES2023.Collection",
  "ES2024.ArrayBuffer",
  "ES2024.Collection",
  "ES2024.Object",
  "ES2024.Promise",
  "ES2024.Regexp",
  "ES2024.String",
  "ES2025.Collection",
  "ES2025.Float16",
  "ES2025.Iterator",
  "ES2025.Promise",
  "ES2025.Regexp",
  "DOM",
  "WebWorker",
];

describe("resolveMonacoLibraries", () => {
  it("should name only lib files Monaco's bundled TypeScript ships", () => {
    const { files } = resolveMonacoLibraries(guestLibraries);

    expect(files.filter((file) => !(file in libFileSet))).toEqual([]);
  });

  it("should leave out the libraries the QuickJS guest lacks", () => {
    const { files } = resolveMonacoLibraries(guestLibraries);

    expect(files).not.toContain("lib.es2023.intl.d.ts");
    expect(files).not.toContain("lib.es2024.sharedmemory.d.ts");
    expect(files).not.toContain("lib.esnext.intl.d.ts");
    expect(files).not.toContain("lib.esnext.d.ts");
  });

  it("should declare RegExp.escape, which Monaco has no lib file for", () => {
    const { extraLibs } = resolveMonacoLibraries(guestLibraries);

    expect(extraLibs).toEqual([
      { fileName: "lib.es2025.regexp.d.ts", content: expect.stringContaining("escape(string: string): string;") },
    ]);
  });
});
