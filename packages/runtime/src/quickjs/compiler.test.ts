import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { compileManifest, stopCompiler } from "./compiler.ts";
import { CatalogSchema } from "./worker-contract.ts";

// Both execution hosts use this browser build of esbuild-wasm inside their disposable container.
vi.mock("esbuild-wasm", () => vi.importActual("esbuild-wasm/lib/browser.js"));

const catalog = CatalogSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../../dist/quickjs/orm-0.45.4__kit-0.31.11/postgresql/catalog.json", import.meta.url),
      "utf8",
    ),
  ),
);
const compilerModule = await WebAssembly.compile(
  await readFile(createRequire(import.meta.url).resolve("esbuild-wasm/esbuild.wasm")),
);
vi.stubGlobal("self", globalThis);

afterAll(async () => {
  await stopCompiler();
  vi.unstubAllGlobals();
});

describe("QuickJS manifest compiler", () => {
  it("should bundle a shared schema graph and pinned imports without evaluating project code", async () => {
    const manifest = makeExecutionManifest();
    manifest.seedGeneratorVersion = "2";
    manifest.files["models/index.mts"] = 'export { users } from "./tables";';
    manifest.files["tasks/query.ts"] =
      'import { users } from "../models"; throw new Error("not evaluated"); export default users;';

    const result = await compileManifest({ manifest, catalog, compilerModule });

    expect(result.code).toContain("evaluateSchema");
    expect(result.code).toContain("initializeContext");
    expect(result.code).toContain('version: options?.version ?? "2"');
    expect(result.code).toContain("not evaluated");
    expect(result.sourceMap).toContain("models/tables.ts");
    expect(result.warnings).toEqual([]);
  });

  it("should accept a schema-only project and extensionless JavaScript imports", async () => {
    const manifest = makeExecutionManifest();
    manifest.entrypoints = { schema: "models/tables.ts" };
    manifest.files["models/value.mjs"] = "export const name = 'users';";
    manifest.files["models/tables.ts"] =
      'import { pgTable, integer } from "drizzle-orm/pg-core"; import { name } from "./value"; export const users = pgTable(name, { id: integer() });';

    const result = await compileManifest({ manifest, catalog, compilerModule });

    expect(result.code).toContain("async () => void 0");
    expect(result.sourceMap).toContain("models/value.mjs");
  });

  it.each([
    { source: "export const broken: = ;", message: "Unexpected" },
    { source: 'import "node:fs";', message: "Unapproved" },
    { source: 'import "../../../outside.ts";', message: "escapes" },
    { source: 'import "./absent";', message: "Cannot resolve" },
    { source: 'const value = require("drizzle-orm"); export default value;', message: "CommonJS" },
    { source: 'import { absent } from "drizzle-orm/pg-core"; export default absent;', message: "No matching export" },
  ])("should attribute $message failures to the project source", async ({ source, message }) => {
    const manifest = makeExecutionManifest();
    manifest.files["tasks/query.ts"] = source;

    await expect(compileManifest({ manifest, catalog, compilerModule })).rejects.toMatchObject({
      code: "compile_error",
      diagnostics: [
        expect.objectContaining({ message: expect.stringContaining(message), source: "tasks/query.ts", line: 1 }),
      ],
    });
  });

  it("should report compiler warnings with project coordinates", async () => {
    const manifest = makeExecutionManifest();
    manifest.files["tasks/query.ts"] = "export default { id: 1, id: 2 };";

    const result = await compileManifest({ manifest, catalog, compilerModule });

    expect(result.warnings).toEqual([
      expect.objectContaining({ severity: "warning", source: "tasks/query.ts", line: 1 }),
    ]);
  });

  it("should reject missing compiler assets before starting compilation", async () => {
    await expect(compileManifest({ manifest: makeExecutionManifest(), catalog })).rejects.toThrow(
      "Missing esbuild compiler",
    );
  });
});
