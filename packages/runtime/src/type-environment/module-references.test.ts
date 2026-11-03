import { describe, expect, it } from "vitest";

import { listModuleReferences, listRelativeCandidates } from "./module-references.ts";

describe("listModuleReferences", () => {
  it("should list imports, re-exports, requires, type queries and triple-slash references", () => {
    const references = listModuleReferences(
      [
        '/// <reference path="globals.d.ts" />',
        '/// <reference types="node" />',
        'import { z } from "zod";',
        "import type { Table } from 'drizzle-orm';",
        'import "./side-effect.js";',
        'export * from "./schema.js";',
        'import pg = require("pg");',
        'type Client = typeof import("@effect/sql-pg/PgClient");',
      ].join("\n"),
    );

    expect(references).toEqual({
      relative: ["./globals.d.ts", "./side-effect.js", "./schema.js"],
      bare: ["node", "zod", "drizzle-orm", "pg", "@effect/sql-pg/PgClient"],
    });
  });

  it("should skip the imports of doc comment examples", () => {
    const references = listModuleReferences(
      [
        "/**",
        " * @example",
        ' * import { Effect } from "effect";',
        " */",
        '// import { z } from "zod";',
        'export declare const users: import("drizzle-orm").Table;',
      ].join("\n"),
    );

    expect(references).toEqual({ relative: [], bare: ["drizzle-orm"] });
  });

  it("should not read an indexed access type as an import", () => {
    expect(listModuleReferences('type From = T["from"];').bare).toEqual([]);
  });
});

describe("listRelativeCandidates", () => {
  const fromUri = "file:///__drizzle_run_types__/%40effect%2Fsql-pg@4.0.0/dist/index.d.ts";

  it("should resolve a source extension to the declaration beside it", () => {
    expect(listRelativeCandidates(fromUri, "./PgClient.ts")).toContain(
      "file:///__drizzle_run_types__/@effect/sql-pg@4.0.0/dist/PgClient.d.ts",
    );
  });

  it("should resolve an emitted extension and a folder index", () => {
    const candidates = listRelativeCandidates(fromUri, "../core/index.cjs");

    expect(candidates).toContain("file:///__drizzle_run_types__/@effect/sql-pg@4.0.0/core/index.d.cts");
    expect(listRelativeCandidates(fromUri, "./client")).toContain(
      "file:///__drizzle_run_types__/@effect/sql-pg@4.0.0/dist/client/index.d.ts",
    );
  });

  it("should resolve nothing outside the virtual root", () => {
    expect(listRelativeCandidates("file:///a.d.ts", "../../b")).toEqual([]);
  });
});
