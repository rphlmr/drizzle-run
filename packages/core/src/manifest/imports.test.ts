import { describe, expect, it } from "vitest";

import { listSupportedTuples } from "../catalog/index.ts";
import { changePairSide, createPairManifest } from "../pair/index.ts";
import {
  describeUnavailableImports,
  findUnavailableImports,
  listProjectImports,
  moveManifestToPair,
  parseRunManifest,
} from "./index.ts";

const postgres = { dialect: "postgresql" } as const;
const [legacy, next] = listSupportedTuples(postgres);

if (legacy?.releaseLine !== "legacy" || next?.releaseLine !== "next") {
  throw new Error("Expected the catalog to list a Legacy, then a Next PostgreSQL pair");
}

const ZOD_QUERY = `import { createInsertSchema } from "drizzle-zod";\nimport { users } from "./schema";\n`;
const EFFECT_QUERY = `import { Effect } from "effect";\n`;

/** A Legacy PostgreSQL manifest whose query file is `query`. */
function makeManifest({ query = "export {};", tuple = legacy } = {}) {
  return parseRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: postgres,
    dependencies: { "drizzle-orm": tuple.ormVersion, "drizzle-kit": tuple.kitVersion },
    files: { "schema.ts": "export const users = {};", "query.ts": query },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
  });
}

describe("listProjectImports", () => {
  it("should read static, type-only, re-export and dynamic package imports once, sorted", () => {
    const imports = listProjectImports({
      "query.ts": [
        'import { sql } from "drizzle-orm";',
        'import type { Infer } from "zod";',
        "import {",
        "  createInsertSchema,",
        '} from "drizzle-zod";',
        'export * from "valibot";',
        'import "drizzle-seed";',
        'const lazy = await import("arktype");',
        'import { users } from "./schema";',
        'import { sql as again } from "drizzle-orm";',
      ].join("\n"),
    });

    expect(imports).toEqual(["arktype", "drizzle-orm", "drizzle-seed", "drizzle-zod", "valibot", "zod"]);
  });

  it("should skip comments, strings that only look like imports, URLs and non-code files", () => {
    const imports = listProjectImports({
      "query.ts": [
        '// import { createInsertSchema } from "drizzle-zod";',
        '/* import { Effect } from "effect"; */',
        'const text = "import x from \\"zod\\"";',
        'import data from "https://example.com/data.js";',
        'import { sql } from "drizzle-orm"; // https://orm.drizzle.team',
      ].join("\n"),
      "seed.sql": 'import { Effect } from "effect";',
    });

    expect(imports).toEqual(["drizzle-orm"]);
  });
});

describe("findUnavailableImports", () => {
  it("should name what another guest ships and this one does not, leaving unknown packages to the compiler", () => {
    const specifiers = ["drizzle-orm", "drizzle-zod", "effect", "left-pad"];

    expect(findUnavailableImports(specifiers, { tuple: legacy, guestFlavor: "slim" })).toEqual(["effect"]);
    expect(findUnavailableImports(specifiers, { tuple: next, guestFlavor: "slim" })).toEqual(["drizzle-zod", "effect"]);
    expect(findUnavailableImports(specifiers, { tuple: next, guestFlavor: "effect" })).toEqual(["drizzle-zod"]);
  });

  it("should describe them with the pair to pick instead", () => {
    expect(describeUnavailableImports(["drizzle-zod"], { tuple: next, guestFlavor: "slim" })).toBe(
      `drizzle-zod is not available with orm ${next.ormVersion} · kit ${next.kitVersion}. Pick another release.`,
    );
    expect(describeUnavailableImports(["drizzle-zod", "zod", "valibot"], { tuple: next, guestFlavor: "effect" })).toBe(
      `drizzle-zod, zod and valibot are not available with orm ${next.ormVersion} · kit ${next.kitVersion} with Effect. Pick another release.`,
    );
  });
});

describe("moving a manifest whose files import a package", () => {
  it("should refuse a pair whose guest does not ship it, and allow one that does", () => {
    expect(() => moveManifestToPair(makeManifest({ query: ZOD_QUERY }), next)).toThrow(
      `drizzle-zod is not available with orm ${next.ormVersion} · kit ${next.kitVersion}. Pick another release.`,
    );
    expect(moveManifestToPair(makeManifest({ query: ZOD_QUERY }), legacy).files["query.ts"]).toBe(ZOD_QUERY);
  });

  it("should refuse the slim guest for Effect code and allow the effect one", () => {
    const effectManifest = makeManifest({ query: EFFECT_QUERY, tuple: next });

    expect(() => moveManifestToPair(effectManifest, next, "slim")).toThrow(/^effect is not available/);
    expect(moveManifestToPair(effectManifest, next, "effect").guestFlavor).toBe("effect");
  });

  it("should check a side against the files it runs after a copy", () => {
    const pair = createPairManifest(makeManifest(), [legacy, next], "separate");
    const zodPair = {
      ...pair,
      sides: [{ ...pair.sides[0], files: { ...pair.sides[0].files, "query.ts": ZOD_QUERY } }, pair.sides[1]],
    } as const;

    expect(() => changePairSide(zodPair, 1, next, "copy", "effect")).toThrow(
      /^rc\.5 \+ Effect: drizzle-zod is not available/,
    );
    expect(changePairSide(zodPair, 1, next, "keep", "effect").sides[1].guestFlavor).toBe("effect");
  });

  it("should refuse a new side by side whose sides cannot import the files' packages", () => {
    expect(() => createPairManifest(makeManifest({ query: EFFECT_QUERY }), [legacy, next], "separate")).toThrow(
      /^0\.45: effect is not available/,
    );
  });

  it("should check only the files each side finally runs, not the ones its base had", () => {
    const effectBase = makeManifest({ query: EFFECT_QUERY, tuple: next });

    expect(
      createPairManifest([makeManifest({ tuple: next }), effectBase], [next, next], "shared").files["query.ts"],
    ).not.toBe(EFFECT_QUERY);

    const nextSqlite = listSupportedTuples({ dialect: "sqlite" }).find((tuple) => tuple.releaseLine === "next");

    if (nextSqlite === undefined) {
      throw new Error("Expected the catalog to list a Next SQLite pair");
    }

    const effectSchemaBase = parseRunManifest({
      ...makeManifest({ tuple: next }),
      files: { "schema.ts": EFFECT_QUERY, "query.ts": "export {};" },
    });
    const crossDatabase = createPairManifest(
      [effectSchemaBase, makeManifest({ tuple: next })],
      [next, nextSqlite],
      "separate",
      ["effect", "slim"],
    );
    const copied = changePairSide(crossDatabase, 1, nextSqlite, "copy");

    expect(copied.sides[1].files["schema.ts"]).toBe("export const users = {};");
  });
});
