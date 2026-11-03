import { describe, expect, it } from "vitest";

import { listSupportedTuples } from "./catalog/index.ts";
import { evaluateChecks, sameValues, type CheckedResult } from "./checks/evaluate.ts";
import { SerializedValueSchema } from "./contracts/serialization-schema.ts";
import { serializeValue } from "./contracts/serialization.ts";
import { diffRunResults } from "./guide/diff.ts";
import { applyProjectShape } from "./guide/project.ts";
import { resolveStep } from "./guide/resolve.ts";
import { parseGuideManifest } from "./guide/validation.ts";
import { listProjectImports } from "./manifest/imports.ts";
import { parseRunManifest } from "./manifest/validation.ts";
import { createPairManifest, pairSide } from "./pair/operations.ts";
import { parsePairManifest } from "./pair/validation.ts";
import { applyEdits } from "./shared/models.ts";

describe("core contract regressions", () => {
  it("should preserve and validate own prototype-named serialized fields", () => {
    const original = serializeValue(JSON.parse('{"__proto__":{"x":1},"constructor":2,"ok":3}'));
    const parsed = SerializedValueSchema.parse(original);

    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(
      SerializedValueSchema.safeParse({ type: "object", value: JSON.parse('{"__proto__":{"type":"bad"}}') }).success,
    ).toBe(false);
  });

  it.each([1n, undefined, new Date("2026-01-01T00:00:00.000Z")])(
    "should distinguish tagged %s from user arrays",
    (value) => {
      const tag = serializeValue(value);
      const lookalike =
        tag.type === "undefined"
          ? ["undefined"]
          : tag.type === "bigint" || tag.type === "date"
            ? [tag.type, tag.value]
            : [];
      const actual = [serializeValue({ id: 1, result: value })];
      const expected = [serializeValue({ id: 1, result: lookalike })];
      const result = {
        outcome: "succeeded",
        displays: [{ label: "Rows", values: actual }],
        sql: [],
      } satisfies CheckedResult;

      expect(sameValues(actual, expected, { ordered: true })).toBe(false);
      expect(sameValues(actual, expected)).toBe(false);
      expect(
        evaluateChecks(result, [{ type: "matchesSolution", label: "Rows" }], { expected: { Rows: expected } })[0]
          ?.passed,
      ).toBe(false);
      expect(diffRunResults({ displays: [{ label: "Rows", values: expected }] }, result).changed).toBe(true);
    },
  );

  it("should exclude import syntax inside quoted and template strings", () => {
    expect(
      listProjectImports({
        "query.ts": `export default 'import { Effect } from "effect";';\nconst text = \`export * from "zod";\`;\nimport "drizzle-orm";`,
      }),
    ).toEqual(["drizzle-orm"]);
  });

  it("should detect imports in template expressions while excluding nested literal text", () => {
    const source = [
      'export default `${await import("effect")}`;',
      'const nested = `text import("fake-a") ${({ value: `nested ${await import("zod")} import("fake-b")`, text: \'import("fake-c") }\' }).value}`;',
      'const escaped = `\\${import("fake-d")} ${/* } */ await import("valibot")}`;',
      'const tail = await import("drizzle-orm");',
    ].join("\n");

    expect(listProjectImports({ "query.ts": source })).toEqual(["drizzle-orm", "effect", "valibot", "zod"]);
  });

  it("should select the qualified PostgreSQL schema for table, index and foreign-key checks", () => {
    const table = { name: "users", columns: [], primaryKey: [], foreignKeys: [], indexes: [], checks: [] };
    const result = {
      outcome: "succeeded",
      displays: [],
      sql: [],
      database: {
        dialect: "postgresql",
        schemas: [
          { name: "public", tables: [table], views: [], enums: [], sequences: [] },
          {
            name: "auth",
            tables: [
              {
                ...table,
                columns: [{ name: "email", dataType: "text", nullable: false }],
                indexes: [{ name: "email_idx", columns: ["email"], unique: true }],
                foreignKeys: [{ columns: ["email"], referencedTable: "auth.accounts", referencedColumns: ["email"] }],
              },
            ],
            views: [],
            enums: [],
            sequences: [],
          },
        ],
      },
    } satisfies CheckedResult;

    expect(
      evaluateChecks(result, [
        { type: "table", name: "auth.users", columns: [{ name: "email" }] },
        { type: "index", table: "auth.users", columns: ["email"] },
        {
          type: "foreignKey",
          table: "auth.users",
          columns: ["email"],
          references: { table: "auth.accounts", columns: ["email"] },
        },
      ]).every((check) => check.passed),
    ).toBe(true);
    expect(evaluateChecks(result, [{ type: "table", name: "missing.users" }])[0]?.passed).toBe(false);
  });

  it("should retain a merged cross-line seed pin through a split and pair parsing", () => {
    const tuples = listSupportedTuples({ dialect: "postgresql" });
    const legacy = tuples.find((tuple) => tuple.releaseLine === "legacy");
    const next = tuples.find((tuple) => tuple.releaseLine === "next");
    if (legacy === undefined || next === undefined) {
      throw new Error("Missing supported tuples");
    }
    const project = parseRunManifest({
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion },
      files: { "schema.ts": "export {};", "query.ts": "export {};", "seed.ts": "export {};" },
      entrypoints: { schema: "schema.ts", run: "query.ts", seed: "seed.ts" },
      randomSeed: 42,
    });
    const merged = applyProjectShape(createPairManifest(project, [legacy, next], "separate"), { merge: { keep: 1 } });
    const split = parsePairManifest(
      applyProjectShape(merged, { split: { sides: [{}, {}], files: ["schema.ts", "query.ts"] } }),
    );

    expect(pairSide(split, 0).seedGeneratorVersion).toBe("2");
    expect(pairSide(split, 1).seedGeneratorVersion).toBe("2");
    expect(pairSide(split, 1).randomSeed).toBe(42);

    const guide = parseGuideManifest({
      kind: "drizzle-run-guide",
      manifestVersion: 1,
      id: "seed-pin",
      title: "Seed pin",
      project: createPairManifest(project, [legacy, next], "separate"),
      steps: [
        {
          type: "walkthrough",
          id: "merge",
          label: "Merge",
          run: "none",
          title: "Merge",
          body: "Keep Next.",
          merge: { keep: 1 },
        },
        {
          type: "walkthrough",
          id: "split",
          label: "Split",
          run: "none",
          title: "Split",
          body: "Compare Next.",
          split: { sides: [{}, {}], files: ["schema.ts", "query.ts"] },
        },
      ],
    });
    const resolvedPair = parsePairManifest(resolveStep(guide, 1).project);

    expect(pairSide(resolvedPair, 0).seedGeneratorVersion).toBe("2");
    expect(
      pairSide(createPairManifest({ ...project, seedGeneratorVersion: "2" }, [next, next], "separate"), 1)
        .seedGeneratorVersion,
    ).toBe("2");
    expect(pairSide(createPairManifest(project, [next, next], "separate"), 0).seedGeneratorVersion).toBeUndefined();
  });

  it("should reject overlapping guide replacement anchors", () => {
    expect(() =>
      applyEdits({ "query.ts": "aaaa" }, [{ file: "query.ts", replace: { anchor: "aaa", with: "b" } }]),
    ).toThrow(expect.objectContaining({ reason: "ANCHOR_NOT_UNIQUE" }));
  });

  it.each(["toString", "constructor", "__proto__"])("should fail absent own expected display %s", (label) => {
    expect(
      evaluateChecks(
        { outcome: "succeeded", displays: [{ label, values: [serializeValue(1)] }], sql: [] },
        [{ type: "matchesSolution", label }],
        { expected: {} },
      )[0]?.passed,
    ).toBe(false);
  });
});
