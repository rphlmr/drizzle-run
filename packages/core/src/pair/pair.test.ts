import { describe, expect, it } from "vitest";

import type { RunManifest } from "../manifest/types.ts";
import { RunManifestValidationError } from "../manifest/validation.ts";
import { resolveSupportedTuple } from "../registry/selectors.ts";
import {
  addPairFile,
  canSharePairFile,
  changePairSide,
  checkPairSeed,
  getPairSeedProblem,
  createPairManifest,
  definePairManifest,
  editPairFile,
  findRetiredPairSides,
  followPairInPlaceRelease,
  isCrossDatabasePair,
  isCrossLinePair,
  listManifestDialects,
  listManifestTargets,
  moveRetiredPairSides,
  pairSide,
  pairSideLabel,
  pairSideLabels,
  pairSideName,
  pairSideTuple,
  PairManifestValidationError,
  parsePairManifest,
  renamePairSide,
  safeParsePairManifest,
  sharePairFile,
  splitPairFile,
  swapPairSides,
  type PairManifest,
  type PairSideIndex,
} from "./index.ts";
import { throwWithSideLabel } from "./side-label.ts";

const legacy = resolveSupportedTuple({
  target: { dialect: "postgresql" },
  ormVersion: "0.45.4",
  kitVersion: "0.31.11",
});

const next = resolveSupportedTuple({
  target: { dialect: "postgresql" },
  ormVersion: "1.0.0-rc.5",
  kitVersion: "1.0.0-rc.5",
});

const SEED_SOURCE = [
  'import { seed } from "drizzle-seed";',
  'import { db, schema } from "@drizzle-run/runtime/context";',
  "await seed(db, schema);",
].join("\n");

function makeBaseManifest(): RunManifest {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    files: {
      "schema.ts": "export const users = 1;",
      "seed.ts": SEED_SOURCE,
      "query.ts": "console.log(1);",
    },
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    randomSeed: 7,
  };
}

function makeSeparatePair(): PairManifest {
  return createPairManifest(makeBaseManifest(), [legacy, next], "separate");
}

function makeSharedPair(): PairManifest {
  return createPairManifest(makeBaseManifest(), [next, next], "shared");
}

function makeSeedOffBase(): RunManifest {
  const base = makeBaseManifest();
  const { seed: _seed, ...entrypoints } = base.entrypoints;

  return { ...base, files: { "schema.ts": base.files["schema.ts"] ?? "", "query.ts": "" }, entrypoints };
}

describe("the seed of a side-by-side project", () => {
  it("should share seed.ts added to a pair across release lines, so the seed can turn on", () => {
    const pair = addPairFile(createPairManifest(makeSeedOffBase(), [legacy, next], "separate"), "seed.ts", SEED_SOURCE);

    expect(pair.files["seed.ts"]).toBe(SEED_SOURCE);
    expect(parsePairManifest({ ...pair, entrypoints: { ...pair.entrypoints, seed: "seed.ts" } }).entrypoints.seed).toBe(
      "seed.ts",
    );
  });

  it("should refuse a seed with another name instead of moving it, since its relative imports would change", () => {
    const base = makeBaseManifest();
    const renamed: RunManifest = {
      ...base,
      files: {
        "schema.ts": "export const users = 1;",
        "db/data.ts": "export const rows = [];",
        "db/seed.ts": 'import { rows } from "./data";',
        "query.ts": "",
      },
      entrypoints: { ...base.entrypoints, seed: "db/seed.ts" },
    };
    const renameFirst = "A side-by-side project seeds from seed.ts: rename db/seed.ts to seed.ts first.";

    expect(() => createPairManifest(renamed, [legacy, next], "separate")).toThrow(renameFirst);
    expect(() => createPairManifest([makeBaseManifest(), renamed], [legacy, next], "shared")).toThrow(renameFirst);
    expect(() =>
      parsePairManifest({
        ...makeSeparatePair(),
        entrypoints: { ...makeSeparatePair().entrypoints, seed: "db/seed.ts" },
      }),
    ).toThrow(renameFirst);
  });

  it("should refuse a seed.ts only the second project has where separate files would drop it", () => {
    expect(() => createPairManifest([makeSeedOffBase(), makeBaseManifest()], [legacy, next], "separate")).toThrow(
      "seed.ts would be dropped",
    );
  });

  it("should start shared files from the first project, whatever seed the second one has", () => {
    const pair = createPairManifest([makeSeedOffBase(), makeBaseManifest()], [next, next], "shared");

    expect(Object.hasOwn(pair.files, "seed.ts")).toBe(false);
    expect(pair.entrypoints.seed).toBeUndefined();
  });

  it("should keep seed.ts shared while the seed is off, never a copy per side", () => {
    const seedOff = createPairManifest(makeSeedOffBase(), [next, next], "separate");
    const perSide = {
      ...seedOff,
      sides: seedOff.sides.map((side, index) => ({ ...side, files: { ...side.files, "seed.ts": `${index}` } })),
    };
    const result = safeParsePairManifest(perSide);

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues.map((issue) => issue.path)).toEqual([
      ["sides", 0, "files", "seed.ts"],
      ["sides", 1, "files", "seed.ts"],
    ]);
  });
});

describe("errors that name a side", () => {
  it("should name the side whose new release has no guest in the flavor", () => {
    expect(() => createPairManifest(makeBaseManifest(), [next, legacy], "separate", ["slim", "effect"])).toThrow(
      /^0\.45 \+ Effect: Drizzle ORM 0\.45\.4 has no effect guest/,
    );
    expect(() => changePairSide(makeSharedPair(), 1, legacy, "keep", "effect")).toThrow(
      /^0\.45 \+ Effect: Drizzle ORM 0\.45\.4 has no effect guest/,
    );
    expect(() => createPairManifest(makeBaseManifest(), [legacy, legacy], "separate", ["slim", "effect"])).toThrow(
      /^0\.45 \+ Effect: /,
    );
    expect(() =>
      createPairManifest([makeBaseManifest(), makeBaseManifest()], [legacy, legacy], "separate", ["effect", "effect"]),
    ).toThrow(/^0\.45 \+ Effect \(1\): /);
  });

  it("should keep a validation error as it is, so its issues can still be listed", () => {
    const invalid = new RunManifestValidationError([{ path: ["files"], code: "INVALID_VALUE", message: "Bad." }]);

    expect(() => throwWithSideLabel("rc.5 (2)", invalid)).toThrow(invalid);
    expect(() => throwWithSideLabel("rc.5 (2)", new Error("Broken."))).toThrow("rc.5 (2): Broken.");
  });
});

describe("side-by-side manifests", () => {
  it("should start separate files with a copy per side and a shared seed", () => {
    const manifest = makeSeparatePair();

    expect(Object.keys(manifest.files)).toEqual(["seed.ts"]);
    expect(Object.keys(manifest.sides[0].files)).toEqual(["schema.ts", "query.ts"]);
    expect(manifest.sides[1].files).toEqual(manifest.sides[0].files);
    expect(manifest.randomSeed).toBe(7);
  });

  it("should pin each side to its own pair, with no companion pins", () => {
    const manifest = makeSeparatePair();

    expect(manifest.sides[0].dependencies).toEqual({ "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" });
    expect(manifest.sides[1].dependencies).toEqual({ "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" });
    expect(pairSideTuple(manifest, 1)).toBe(next);
  });

  it("should start shared files with one set for both sides", () => {
    const manifest = makeSharedPair();

    expect(Object.keys(manifest.files)).toEqual(["schema.ts", "seed.ts", "query.ts"]);
    expect(manifest.sides.map((side) => side.files)).toEqual([{}, {}]);
  });

  it("should run each side as a run manifest of the shared files plus its own", () => {
    const manifest = editPairFile(makeSeparatePair(), 1, "query.ts", "console.log(2);");
    const secondSide = pairSide(manifest, 1);

    expect(secondSide.dependencies["drizzle-orm"]).toBe("1.0.0-rc.5");
    expect(secondSide.files).toEqual({
      "seed.ts": manifest.files["seed.ts"],
      "schema.ts": "export const users = 1;",
      "query.ts": "console.log(2);",
    });
    expect(pairSide(manifest, 0).files["query.ts"]).toBe("console.log(1);");
  });

  it("should show an edit to a shared file on both sides and a per-side edit on one", () => {
    const shared = editPairFile(makeSharedPair(), 1, "query.ts", "edited");

    expect(pairSide(shared, 0).files["query.ts"]).toBe("edited");
    expect(pairSide(shared, 1).files["query.ts"]).toBe("edited");

    const own = editPairFile(makeSeparatePair(), 0, "query.ts", "edited");

    expect(pairSide(own, 0).files["query.ts"]).toBe("edited");
    expect(pairSide(own, 1).files["query.ts"]).toBe("console.log(1);");
    expect(() => editPairFile(own, 0, "missing.ts", "")).toThrow("missing.ts is not in this project");
  });

  it("should split a shared file into a copy per side and share it back from one side", () => {
    const split = splitPairFile(makeSharedPair(), "query.ts");

    expect(Object.hasOwn(split.files, "query.ts")).toBe(false);
    expect(split.sides[0].files["query.ts"]).toBe("console.log(1);");
    expect(safeParsePairManifest(split).success).toBe(true);

    const shared = sharePairFile(editPairFile(split, 1, "query.ts", "right"), "query.ts", 1);

    expect(shared.files["query.ts"]).toBe("right");
    expect(shared.sides.map((side) => side.files)).toEqual([{}, {}]);
    expect(() => splitPairFile(shared, "seed.ts")).toThrow("is the seed file both sides share");
  });

  it("should change one side's pair keeping, copying or sharing its files", () => {
    const edited = editPairFile(makeSeparatePair(), 1, "query.ts", "next only");
    const kept = changePairSide(edited, 0, legacy, "keep");

    expect(kept.sides[0].dependencies["drizzle-orm"]).toBe("0.45.4");
    expect(kept.sides[0].files["query.ts"]).toBe("console.log(1);");

    const copied = changePairSide(edited, 0, legacy, "copy");

    expect(copied.sides[0].files["query.ts"]).toBe("next only");

    const shared = changePairSide(edited, 0, next, "share");

    expect(shared.files["query.ts"]).toBe("next only");
    expect(shared.sides.map((side) => side.files)).toEqual([{}, {}]);
  });

  it("should share only the seed between a Legacy side and a Next side", () => {
    const separate = makeSeparatePair();

    expect(isCrossLinePair(separate)).toBe(true);
    expect(isCrossLinePair(makeSharedPair())).toBe(false);
    expect(() => createPairManifest(makeBaseManifest(), [legacy, next], "shared")).toThrow(
      "schema.ts is shared, but a Legacy side and a Next side share only the seed",
    );
    expect(() => sharePairFile(separate, "query.ts", 1)).toThrow("query.ts is shared");
    expect(() => changePairSide(separate, 0, legacy, "share")).toThrow("share only the seed");
  });

  it("should keep an off seed shared across release lines, so it can turn back on", () => {
    const separate = makeSeparatePair();
    const { seed: _seed, ...withoutSeed } = separate.entrypoints;

    expect(safeParsePairManifest({ ...separate, entrypoints: withoutSeed }).success).toBe(true);
  });

  it("should keep the seed file shared when a project with the seed off opens side by side", () => {
    const base = makeBaseManifest();
    const { seed: _seed, ...withoutSeed } = base.entrypoints;

    const pair = createPairManifest({ ...base, entrypoints: withoutSeed }, [legacy, next], "separate");

    expect(Object.keys(pair.files)).toEqual(["seed.ts"]);
    expect(() => splitPairFile(pair, "seed.ts")).toThrow("seed.ts");
  });

  it("should add a file shared, or with a copy per side across release lines", () => {
    expect(addPairFile(makeSharedPair(), "helpers.ts", "export {};").files["helpers.ts"]).toBe("export {};");

    const crossLine = addPairFile(makeSeparatePair(), "helpers.ts", "export {};");

    expect(Object.hasOwn(crossLine.files, "helpers.ts")).toBe(false);
    expect(crossLine.sides.map((side) => side.files["helpers.ts"])).toEqual(["export {};", "export {};"]);
    expect(() => addPairFile(crossLine, "helpers.ts", "")).toThrow("helpers.ts is already in this project");
  });

  it("should give each side its own copy of the shared files when a side moves to the other release line", () => {
    const shared = editPairFile(makeSharedPair(), 1, "query.ts", "both");
    const moved = changePairSide(shared, 0, legacy, "keep");

    expect(Object.keys(moved.files)).toEqual(["seed.ts"]);
    expect(moved.sides[0].files).toEqual({ "schema.ts": "export const users = 1;", "query.ts": "both" });
    expect(moved.sides[1].files).toEqual(moved.sides[0].files);
    expect(moved.sides[0].dependencies["drizzle-orm"]).toBe("0.45.4");
  });

  it("should run both sides on one release, each with its own files", () => {
    const pair = createPairManifest(makeBaseManifest(), [next, next], "separate");
    const edited = editPairFile(pair, 1, "query.ts", "db.query.users.findMany();");

    expect(pairSide(edited, 0).dependencies).toEqual(pairSide(edited, 1).dependencies);
    expect(pairSide(edited, 0).files["query.ts"]).toBe("console.log(1);");
    expect(pairSide(edited, 1).files["query.ts"]).toBe("db.query.users.findMany();");
    expect(changePairSide(makeSeparatePair(), 0, next, "keep").sides[0].dependencies["drizzle-orm"]).toBe("1.0.0-rc.5");
  });

  it("should pin drizzle-seed to generator version 2 on both sides when one side is Legacy", () => {
    const pair = makeSeparatePair();

    expect(pairSide(pair, 0).seedGeneratorVersion).toBe("2");
    expect(pairSide(pair, 1).seedGeneratorVersion).toBe("2");
    expect(pairSide(swapPairSides(pair), 0).seedGeneratorVersion).toBe("2");
  });

  it("should leave drizzle-seed on its default version when both sides are on one release line", () => {
    const nextPair = createPairManifest(makeBaseManifest(), [next, next], "separate");
    const legacyPair = createPairManifest(makeBaseManifest(), [legacy, legacy], "separate");

    expect(pairSide(nextPair, 0)).not.toHaveProperty("seedGeneratorVersion");
    expect(pairSide(nextPair, 1)).not.toHaveProperty("seedGeneratorVersion");
    expect(pairSide(legacyPair, 0)).not.toHaveProperty("seedGeneratorVersion");
  });

  it("should name a side, trim and clean the name, and clear it when empty", () => {
    const named = renamePairSide(makeSeparatePair(), 0, "  Classic\n  select ");

    expect(named.sides[0].name).toBe("Classic select");
    expect(named.sides[1]).not.toHaveProperty("name");
    expect(renamePairSide(named, 0, "   ").sides[0]).not.toHaveProperty("name");
    expect(() => renamePairSide(named, 1, "x".repeat(41))).toThrow("1 to 40 characters");
  });

  it("should keep a side's name through a swap, a pair change and JSON", () => {
    const named = renamePairSide(renamePairSide(makeSeparatePair(), 0, "Callback"), 1, "Object");

    expect(swapPairSides(named).sides.map((side) => side.name)).toEqual(["Object", "Callback"]);
    expect(changePairSide(named, 0, next, "share").sides.map((side) => side.name)).toEqual(["Callback", "Object"]);
    expect(changePairSide(named, 1, legacy, "copy").sides[1].name).toBe("Object");
    expect(parsePairManifest(JSON.parse(JSON.stringify(named)))).toEqual(named);
  });

  it("should reject a side name that is empty, too long, untrimmed or on several lines", () => {
    const manifest = makeSeparatePair();

    for (const name of ["", "x".repeat(41), " Classic", "Classic\nRQB", 7]) {
      const result = safeParsePairManifest({ ...manifest, sides: [{ ...manifest.sides[0], name }, manifest.sides[1]] });

      expect(result.success).toBe(false);
      expect(result.success ? [] : result.issues.map((issue) => issue.path)).toContainEqual(["sides", 0, "name"]);
    }
  });

  it("should label a side by its name, or its release with (1) and (2) when both read the same", () => {
    const sameRelease = createPairManifest(makeBaseManifest(), [next, next], "separate");

    expect(pairSideLabels(makeSeparatePair())).toEqual(["0.45", "rc.5"]);
    expect(pairSideLabels(sameRelease)).toEqual(["rc.5 (1)", "rc.5 (2)"]);
    expect(pairSideLabels(renamePairSide(sameRelease, 0, "Classic"))).toEqual(["Classic", "rc.5"]);
    expect(pairSideLabels(renamePairSide(sameRelease, 1, "rc.5"))).toEqual(["rc.5 (1)", "rc.5 (2)"]);
    expect(pairSideLabels(createPairManifest(makeBaseManifest(), [next, next], "shared", ["slim", "effect"]))).toEqual([
      "rc.5",
      "rc.5 + Effect",
    ]);
  });

  it("should run rc.5 on one side and rc.5 with Effect on the other, each with its own flavor", () => {
    for (const files of ["separate", "shared"] as const) {
      const pair = createPairManifest(makeBaseManifest(), [next, next], files, ["slim", "effect"]);

      expect(pair.sides[0]).not.toHaveProperty("guestFlavor");
      expect(pair.sides[1].guestFlavor).toBe("effect");
      expect(pairSide(pair, 1).guestFlavor).toBe("effect");
    }

    const shared = changePairSide(makeSeparatePair(), 0, next, "share", "effect");

    expect(shared.sides[0].guestFlavor).toBe("effect");
    expect(shared.sides[1]).not.toHaveProperty("guestFlavor");
    expect(changePairSide(shared, 1, next, "keep", "effect").sides.map((side) => side.guestFlavor)).toEqual([
      "effect",
      "effect",
    ]);
  });

  it("should name a side by its release line and flavor", () => {
    expect(pairSideName({ ormVersion: "1.0.0-rc.5", guestFlavor: "effect" })).toBe("rc.5 + Effect");
    expect(pairSideName({ ormVersion: "1.0.0-rc.5", guestFlavor: "slim" })).toBe("rc.5");
    expect(pairSideName({ ormVersion: "0.45.4", guestFlavor: "slim" })).toBe("0.45");
  });

  it("should swap sides", () => {
    const swapped = swapPairSides(makeSeparatePair());

    expect(swapped.sides[0].dependencies["drizzle-orm"]).toBe("1.0.0-rc.5");
    expect(swapped.sides[1].dependencies["drizzle-orm"]).toBe("0.45.4");
  });

  it("should round-trip through JSON and reject files that are both shared and per side", () => {
    const manifest = makeSeparatePair();

    expect(parsePairManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);

    const both = { ...manifest, files: { ...manifest.files, "query.ts": "x" } };
    const result = safeParsePairManifest(both);

    expect(result.success).toBe(false);
    expect(!result.success && result.issues.map((issue) => issue.path)).toContainEqual([
      "sides",
      0,
      "files",
      "query.ts",
    ]);
  });

  it("should reject uneven per-side files, a per-side seed and a third side", () => {
    const manifest = makeSeparatePair();
    const uneven = { ...manifest, sides: [manifest.sides[0], { ...manifest.sides[1], files: {} }] };
    const seed = {
      ...manifest,
      files: {},
      sides: manifest.sides.map((side) => ({ ...side, files: { ...side.files, "seed.ts": "" } })),
    };

    expect(safeParsePairManifest(uneven).success).toBe(false);
    expect(!safeParsePairManifest(seed).success && safeParsePairManifest(seed)).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ["sides", 0, "files", "seed.ts"] })]),
    });
    expect(safeParsePairManifest({ ...manifest, sides: [...manifest.sides, manifest.sides[0]] }).success).toBe(false);
    expect(safeParsePairManifest({ ...manifest, manifestVersion: 2 })).toMatchObject({
      success: false,
      issues: [{ code: "UNSUPPORTED_VERSION" }],
    });
  });

  it("should report a side file that is not text at that file, without asking for a copy on the other side", () => {
    const manifest = makeSeparatePair();
    const nonText = {
      ...manifest,
      sides: [{ ...manifest.sides[0], files: { ...manifest.sides[0].files, "query.ts": 42 } }, manifest.sides[1]],
    };
    const result = safeParsePairManifest(nonText);
    const issues = result.success ? [] : result.issues;

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_TYPE", path: ["sides", 0, "files", "query.ts"] }),
    );
    expect(issues.some((issue) => issue.message.includes("both sides need one"))).toBe(false);
  });

  it("should report a side file that is not text and that the other side lacks, both at once", () => {
    const manifest = makeSeparatePair();
    const nonTextOnOneSide = {
      ...manifest,
      sides: [{ ...manifest.sides[0], files: { ...manifest.sides[0].files, "extra.ts": 42 } }, manifest.sides[1]],
    };
    const result = safeParsePairManifest(nonTextOnOneSide);
    const issues = result.success ? [] : result.issues;

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_TYPE", path: ["sides", 0, "files", "extra.ts"] }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "MISSING_FILE",
        path: ["sides", 1, "files"],
        message: "extra.ts has a copy per side, so both sides need one.",
      }),
    );
  });

  it("should define a side by side as written, and refuse a side on an older Legacy fix release", () => {
    const current = makeSeparatePair();
    const olderLegacySide = { ...current.sides[0], dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } };

    expect(definePairManifest(current)).toBe(current);
    const slimSide = { ...current.sides[0], guestFlavor: "slim" as const };
    const spelledOut = { ...current, sides: [slimSide, current.sides[1]] as const };

    expect(definePairManifest(spelledOut)).toBe(spelledOut);
    // @ts-expect-error an older Legacy fix release is not a supported pair.
    expect(() => definePairManifest({ ...current, sides: [olderLegacySide, current.sides[1]] })).toThrow(
      PairManifestValidationError,
    );
  });

  it("should place a side's run manifest issue under that side", () => {
    const manifest = makeSeparatePair();
    const secondSide = {
      ...manifest.sides[1],
      dependencies: { ...manifest.sides[1].dependencies, zod: "4.4.3" },
    };
    const unknownPackage = { ...manifest, sides: [manifest.sides[0], secondSide] };
    const result = safeParsePairManifest(unknownPackage);

    expect(result.success).toBe(false);
    expect(!result.success && result.issues.every((issue) => issue.path[0] === "sides" && issue.path[1] === 1)).toBe(
      true,
    );
  });

  it("should name sides by release", () => {
    expect(pairSideLabel("0.45.4")).toBe("0.45");
    expect(pairSideLabel("1.0.0-rc.5")).toBe("rc.5");
    expect(pairSideLabel("1.0.0")).toBe("1.0");
  });

  it("should let the seed import only drizzle-seed, the runtime context and project files", () => {
    const mixedSeedSource = [
      'import { sql } from "drizzle-orm";',
      'import "./schema";',
      'export * from "zod";',
      'await import("drizzle-orm/pg-core");',
    ].join("\n");

    expect(checkPairSeed(makeBaseManifest().files["seed.ts"] ?? "")).toEqual([]);
    expect(checkPairSeed(mixedSeedSource)).toEqual(["drizzle-orm", "zod", "drizzle-orm/pg-core"]);
    expect(getPairSeedProblem({ entrypoints: { seed: "seed.ts" }, files: { "seed.ts": mixedSeedSource } })).toBe(
      "seed.ts seeds both sides, so it may only use drizzle-seed or db. Remove the import of drizzle-orm, zod, drizzle-orm/pg-core.",
    );
    expect(getPairSeedProblem(makeBaseManifest())).toBeUndefined();
    expect(getPairSeedProblem({ entrypoints: {}, files: {} })).toBeUndefined();
  });
});

const sqliteNext = resolveSupportedTuple({
  target: { dialect: "sqlite" },
  ormVersion: "1.0.0-rc.5",
  kitVersion: "1.0.0-rc.5",
});

const POSTGRES_SCHEMA =
  'import { pgTable, integer } from "drizzle-orm/pg-core";\nexport const users = pgTable("users", {});';
const SQLITE_SCHEMA =
  'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\nexport const users = sqliteTable("users", {});';

function makeNextManifest(dialect: "postgresql" | "sqlite"): RunManifest {
  return {
    ...makeBaseManifest(),
    target: { dialect },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: {
      ...makeBaseManifest().files,
      "schema.ts": dialect === "postgresql" ? POSTGRES_SCHEMA : SQLITE_SCHEMA,
    },
  };
}

/** PostgreSQL on the left, SQLite on the right, each with its own schema and query. */
function makeCrossDatabasePair(): PairManifest {
  return createPairManifest(
    [makeNextManifest("postgresql"), makeNextManifest("sqlite")],
    [next, sqliteNext],
    "separate",
  );
}

describe("side-by-side manifests on two databases", () => {
  it("should list each side's database, and the one of a one-version manifest", () => {
    const pair = makeCrossDatabasePair();

    expect(listManifestTargets(pair)).toEqual([{ dialect: "postgresql" }, { dialect: "sqlite" }]);
    expect(listManifestDialects(pair)).toEqual(["postgresql", "sqlite"]);
    expect(listManifestDialects(makeSharedPair())).toEqual(["postgresql"]);
    expect(listManifestTargets(makeBaseManifest())).toEqual([{ dialect: "postgresql" }]);
    expect(isCrossDatabasePair(pair)).toBe(true);
    expect(isCrossDatabasePair(makeSharedPair())).toBe(false);
  });

  it("should run each side on its pair's database, whatever its base's", () => {
    const forked = createPairManifest(makeNextManifest("postgresql"), [next, sqliteNext], "separate");

    expect(forked.sides.map((side) => side.target.dialect)).toEqual(["postgresql", "sqlite"]);
    expect(forked.sides[1].files["schema.ts"]).toBe(POSTGRES_SCHEMA);
    expect(pairSide(forked, 1).target).toEqual({ dialect: "sqlite" });
  });

  it("should share every file but the schema across databases, each side's schema from its own base", () => {
    const shared = createPairManifest(
      [makeNextManifest("postgresql"), makeNextManifest("sqlite")],
      [next, sqliteNext],
      "shared",
    );

    expect(Object.keys(shared.files).toSorted()).toEqual(["query.ts", "seed.ts"]);
    expect(shared.sides.map((side) => side.files)).toEqual([
      { "schema.ts": POSTGRES_SCHEMA },
      { "schema.ts": SQLITE_SCHEMA },
    ]);
  });

  it("should refuse to share the schema across databases, and share any other file", () => {
    const pair = makeCrossDatabasePair();

    expect(["schema.ts", "query.ts", "seed.ts"].map((path) => canSharePairFile(pair, path))).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      canSharePairFile(createPairManifest(makeNextManifest("postgresql"), [next, next], "separate"), "schema.ts"),
    ).toBe(true);
    expect(canSharePairFile(makeSeparatePair(), "query.ts")).toBe(false);

    expect(() => sharePairFile(pair, "schema.ts", 0)).toThrow("sides on different databases need their own schema");
    expect(sharePairFile(pair, "query.ts", 1).files["query.ts"]).toBe("console.log(1);");
  });

  it("should move a side to the other database keeping its files, the schema split and left to rewrite", () => {
    const moved = changePairSide(makeSharedPair(), 1, sqliteNext, "keep");

    expect(moved.sides[1].target).toEqual({ dialect: "sqlite" });
    expect(Object.keys(moved.files).toSorted()).toEqual(["query.ts", "seed.ts"]);
    expect(moved.sides.map((side) => side.files["schema.ts"])).toEqual([
      "export const users = 1;",
      "export const users = 1;",
    ]);
  });

  it("should copy the other side's files but keep this side's schema when it stays on its database", () => {
    const pair = editPairFile(makeCrossDatabasePair(), 1, "query.ts", "sqlite query");
    const copied = changePairSide(pair, 0, next, "copy");

    expect(copied.sides[0].files).toEqual({ "schema.ts": POSTGRES_SCHEMA, "query.ts": "sqlite query" });
  });

  it("should copy the other side's schema when this side moves to its database", () => {
    const copied = changePairSide(makeCrossDatabasePair(), 0, sqliteNext, "copy");

    expect(copied.sides[0].target).toEqual({ dialect: "sqlite" });
    expect(copied.sides[0].files["schema.ts"]).toBe(SQLITE_SCHEMA);
  });

  it("should share the other side's files across databases, each side keeping its own schema", () => {
    const pair = editPairFile(makeCrossDatabasePair(), 1, "query.ts", "sqlite query");
    const shared = changePairSide(pair, 0, next, "share");

    expect(shared.files["query.ts"]).toBe("sqlite query");
    expect(shared.sides.map((side) => side.files)).toEqual([
      { "schema.ts": POSTGRES_SCHEMA },
      { "schema.ts": SQLITE_SCHEMA },
    ]);

    const onOneDatabase = changePairSide(pair, 0, sqliteNext, "share");

    expect(onOneDatabase.files["schema.ts"]).toBe(SQLITE_SCHEMA);
    expect(onOneDatabase.sides.map((side) => side.files)).toEqual([{}, {}]);
  });

  it("should tell two sides on one release apart by their database", () => {
    expect(pairSideLabels(makeCrossDatabasePair())).toEqual(["rc.5 (Postgres)", "rc.5 (SQLite)"]);
    expect(pairSideLabels(createPairManifest(makeNextManifest("postgresql"), [next, next], "separate"))).toEqual([
      "rc.5 (1)",
      "rc.5 (2)",
    ]);
  });

  it("should swap sides with their databases", () => {
    expect(swapPairSides(makeCrossDatabasePair()).sides.map((side) => side.target.dialect)).toEqual([
      "sqlite",
      "postgresql",
    ]);
  });
});

describe("Legacy fix releases on a side by side", () => {
  it("should move a side on an older Legacy version to the Legacy pair and leave the other side", () => {
    const current = makeSeparatePair();
    const older = {
      ...current,
      sides: [
        { ...current.sides[0], dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
        current.sides[1],
      ],
    };

    expect(safeParsePairManifest(older).success).toBe(false);
    expect(parsePairManifest(followPairInPlaceRelease(older))).toEqual(current);
  });

  it("should return a current pair, a removed Next side and other values as they are", () => {
    const current = makeSeparatePair();
    const removedNext = {
      ...current,
      sides: [
        current.sides[0],
        { ...current.sides[1], dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
      ],
    };

    expect(followPairInPlaceRelease(current)).toBe(current);
    expect(followPairInPlaceRelease(removedNext)).toBe(removedNext);
    expect(followPairInPlaceRelease("pair")).toBe("pair");
  });
});

describe("Removed pairs on a side by side", () => {
  const removedNextVersions = { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" };

  function makeRemovedNextPair(sides: readonly PairSideIndex[]) {
    const current = makeSeparatePair();

    return {
      ...current,
      sides: current.sides.map((side, index) =>
        sides.includes(index === 0 ? 0 : 1) ? { ...side, dependencies: removedNextVersions } : side,
      ),
    };
  }

  it("should list each side on a removed Next pair, after an older Legacy side follows in place", () => {
    const current = makeSeparatePair();
    const olderLegacyAndRemovedNext = {
      ...current,
      sides: [
        { ...current.sides[0], dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
        { ...current.sides[1], dependencies: removedNextVersions },
      ],
    };

    expect(findRetiredPairSides(olderLegacyAndRemovedNext)?.map(({ side, ormVersion }) => [side, ormVersion])).toEqual([
      [1, "1.0.0-rc.3"],
    ]);
    expect(findRetiredPairSides(makeRemovedNextPair([0, 1]))?.map(({ side }) => side)).toEqual([0, 1]);
  });

  it("should list nothing for a current pair, an older Legacy side alone, or a pair with another problem", () => {
    const current = makeSeparatePair();
    const withoutEntrypoints = { ...makeRemovedNextPair([1]), entrypoints: undefined };

    expect(findRetiredPairSides(current)).toBeUndefined();
    expect(
      findRetiredPairSides({
        ...current,
        sides: [
          { ...current.sides[0], dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
          current.sides[1],
        ],
      }),
    ).toBeUndefined();
    expect(findRetiredPairSides(withoutEntrypoints)).toBeUndefined();
    expect(findRetiredPairSides("pair")).toBeUndefined();
  });

  it("should move each removed side to its chosen release and keep the files", () => {
    const current = makeSeparatePair();
    const moved = moveRetiredPairSides(makeRemovedNextPair([1]), [{ side: 1, tuple: next }]);

    expect(moved.sides[1].dependencies).toEqual({ "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion });
    expect(moved.files).toEqual(current.files);
    expect(moved.sides.map((side) => side.files)).toEqual(current.sides.map((side) => side.files));
  });

  it("should give each side its own copy of the shared files when the sides move to two release lines", () => {
    const shared = makeSharedPair();
    const removedShared = {
      ...shared,
      sides: [
        { ...shared.sides[0], dependencies: removedNextVersions },
        { ...shared.sides[1], dependencies: removedNextVersions },
      ],
    };

    const moved = moveRetiredPairSides(removedShared, [
      { side: 0, tuple: legacy },
      { side: 1, tuple: next },
    ]);

    expect(Object.keys(moved.files)).toEqual(["seed.ts"]);
    expect(moved.sides.map((side) => Object.keys(side.files).toSorted())).toEqual([
      ["query.ts", "schema.ts"],
      ["query.ts", "schema.ts"],
    ]);
  });

  it("should list a Legacy side sharing files with a removed Next side, and split them when it moves", () => {
    const shared = makeSharedPair();
    const legacyAndRemovedNext = {
      ...shared,
      sides: [
        { ...shared.sides[0], dependencies: { "drizzle-orm": legacy.ormVersion, "drizzle-kit": legacy.kitVersion } },
        { ...shared.sides[1], dependencies: removedNextVersions },
      ],
    };

    const moved = moveRetiredPairSides(legacyAndRemovedNext, [{ side: 1, tuple: next }]);

    expect(findRetiredPairSides(legacyAndRemovedNext)?.map(({ side }) => side)).toEqual([1]);
    expect(Object.keys(moved.files)).toEqual(["seed.ts"]);
    expect(moved.sides[1].files["schema.ts"]).toBe(shared.files["schema.ts"]);
  });

  it("should name the moved side as the side by side does when its release cannot import its files", () => {
    const removed = makeRemovedNextPair([0, 1]);
    const effectOnSecond = {
      ...removed,
      sides: [
        removed.sides[0],
        { ...removed.sides[1], files: { ...removed.sides[1].files, "query.ts": 'import { Effect } from "effect";' } },
      ],
    };

    expect(() =>
      moveRetiredPairSides(effectOnSecond, [
        { side: 0, tuple: next },
        { side: 1, tuple: next },
      ]),
    ).toThrow(/^rc\.5 \(2\): effect is not available/);
  });

  it("should refuse a release that leaves the side by side invalid", () => {
    expect(() => moveRetiredPairSides(makeRemovedNextPair([1]), [])).toThrow(PairManifestValidationError);
  });
});
