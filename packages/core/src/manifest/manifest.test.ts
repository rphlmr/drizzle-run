import { describe, expect, it } from "vitest";

import { listCompanionLibraries, resolveGuestFlavor, resolveSupportedTuple } from "../catalog/index.ts";
import { assertApprovedSpecifier } from "../registry/index.ts";
import {
  defineRunManifest,
  MAX_RUN_ENV_BYTES,
  MAX_RUN_FILES,
  MAX_RUN_SOURCE_BYTES,
  moveManifestToPair,
  parseRunManifest,
  RunManifestValidationError,
  safeParseRunManifest,
  type RunManifestDefinition,
} from "./index.ts";

function makeStableManifest() {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    files: {
      "src/schema.ts": "export const schema = {};",
      "src/run.ts": "export default undefined;",
    },
    entrypoints: { schema: "src/schema.ts", run: "src/run.ts" },
  } satisfies RunManifestDefinition;
}

function makeNextSqliteManifest() {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: { "schema.ts": "export const schema = {};" },
    entrypoints: { schema: "schema.ts" },
  } satisfies RunManifestDefinition;
}

describe("RunManifest", () => {
  it("should accept catalog-admitted ORM and Kit pairs", () => {
    expect(parseRunManifest(makeStableManifest()).dependencies["drizzle-orm"]).toBe("0.45.4");
    expect(parseRunManifest(makeNextSqliteManifest()).target).toEqual({ dialect: "sqlite" });
  });

  it("should resolve companion versions from the pair of a manifest that pins none", () => {
    const manifest = parseRunManifest(makeStableManifest());
    const tuple = resolveSupportedTuple({
      target: { dialect: "postgresql" },
      ormVersion: manifest.dependencies["drizzle-orm"],
      kitVersion: manifest.dependencies["drizzle-kit"],
    });
    const guest = { tuple, guestFlavor: resolveGuestFlavor(manifest) };

    expect(listCompanionLibraries(guest)).toContainEqual({ packageName: "zod", version: "4.4.3" });
    expect(listCompanionLibraries(guest)).toContainEqual({ packageName: "drizzle-seed", version: "0.3.1" });
    expect(assertApprovedSpecifier(guest, "zod")).toMatchObject({ packageName: "zod", version: "4.4.3" });
  });

  it("should name a companion pin as a field the manifest does not take", () => {
    const result = safeParseRunManifest({
      ...makeStableManifest(),
      dependencies: { ...makeStableManifest().dependencies, zod: "4.4.3" },
    });

    expect(result).toEqual({
      success: false,
      issues: [
        {
          path: ["dependencies", "zod"],
          code: "UNKNOWN_FIELD",
          message: "Only drizzle-orm and drizzle-kit are pinned; zod comes with the Drizzle release.",
        },
      ],
    });
  });

  it("should accept the effect flavor on a pair with an effect guest and name it on a pair without one", () => {
    const effectManifest = parseRunManifest({ ...makeNextSqliteManifest(), guestFlavor: "effect" });
    const legacyResult = safeParseRunManifest({ ...makeStableManifest(), guestFlavor: "effect" });

    expect(effectManifest.guestFlavor).toBe("effect");
    expect(legacyResult).toMatchObject({
      success: false,
      issues: [expect.objectContaining({ path: ["guestFlavor"], code: "INVALID_VALUE" })],
    });
    expect(safeParseRunManifest({ ...makeStableManifest(), guestFlavor: "full" })).toMatchObject({
      success: false,
      issues: [{ path: ["guestFlavor"], message: "guestFlavor must be one of slim, effect." }],
    });
  });

  it("should leave out the slim flavor, so every slim manifest has one form", () => {
    expect(parseRunManifest({ ...makeStableManifest(), guestFlavor: "slim" })).toEqual(
      parseRunManifest(makeStableManifest()),
    );
    expect(parseRunManifest(makeStableManifest())).not.toHaveProperty("guestFlavor");
  });

  it("should set the flavor when moving to the effect guest and drop it when moving to slim or Legacy", () => {
    const sqlite = { dialect: "sqlite" } as const;
    const nextPair = resolveSupportedTuple({ target: sqlite, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" });
    const legacyPair = resolveSupportedTuple({ target: sqlite, ormVersion: "0.45.4", kitVersion: "0.31.11" });
    const effectManifest = moveManifestToPair(makeNextSqliteManifest(), nextPair, "effect");

    expect(effectManifest.guestFlavor).toBe("effect");
    expect(effectManifest.dependencies).toEqual({ "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" });
    expect(moveManifestToPair(effectManifest, nextPair).guestFlavor).toBe("effect");
    expect(moveManifestToPair(effectManifest, nextPair, "slim")).not.toHaveProperty("guestFlavor");
    expect(moveManifestToPair(effectManifest, legacyPair)).not.toHaveProperty("guestFlavor");
    expect(() => moveManifestToPair(effectManifest, legacyPair, "effect")).toThrow(
      "Drizzle ORM 0.45.4 has no effect guest",
    );
  });

  it("should report unknown fields and unsupported dependency pins by field path", () => {
    const input = {
      ...makeStableManifest(),
      extra: true,
      dependencies: {
        ...makeStableManifest().dependencies,
        "drizzle-kit": "0.31.9",
        random: "latest",
      },
    };
    const result = safeParseRunManifest(input);

    expect(result).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["extra"], code: "UNKNOWN_FIELD" }),
        expect.objectContaining({ path: ["dependencies"], code: "UNSUPPORTED_COMBINATION" }),
      ]),
    });
  });

  it("should reject non-canonical paths and missing entrypoint files", () => {
    const result = safeParseRunManifest({
      ...makeStableManifest(),
      files: { "src/../schema.ts": "export {};" },
      entrypoints: { schema: "missing.ts" },
    });

    expect(result).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["files", "src/../schema.ts"], code: "NON_CANONICAL_PATH" }),
        expect.objectContaining({ path: ["entrypoints", "schema"], code: "MISSING_FILE" }),
      ]),
    });
  });

  it("should accept ESM TypeScript with JSON and SQL support files but reject CommonJS paths", () => {
    const manifest = parseRunManifest({
      ...makeStableManifest(),
      files: {
        "src/schema.mts": "export const schema = {};",
        "migrations/0001_init.sql": "CREATE TABLE users (id integer);",
        "meta/_journal.json": "{}",
      },
      entrypoints: { schema: "src/schema.mts" },
    });

    expect(manifest.entrypoints.schema).toBe("src/schema.mts");

    for (const extension of ["cjs", "cts"]) {
      const path = `src/schema.${extension}`;
      const result = safeParseRunManifest({
        ...makeStableManifest(),
        files: { [path]: "export const schema = {};" },
        entrypoints: { schema: path },
      });

      expect(result).toMatchObject({
        success: false,
        issues: expect.arrayContaining([expect.objectContaining({ path: ["files", path], code: "INVALID_VALUE" })]),
      });
    }
  });

  it("should reject JSON and SQL files as executable entrypoints", () => {
    for (const extension of ["json", "sql"]) {
      const path = `src/schema.${extension}`;
      const result = safeParseRunManifest({
        ...makeStableManifest(),
        files: { [path]: "{}" },
        entrypoints: { schema: path },
      });
      expect(result).toMatchObject({
        success: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["entrypoints", "schema"], code: "INVALID_VALUE" }),
        ]),
      });
    }
  });

  it("should reject a file that sits inside another file", () => {
    const result = safeParseRunManifest({
      ...makeStableManifest(),
      files: { "schema.ts": "", "schema.ts/inner.ts": "" },
      entrypoints: { schema: "schema.ts" },
    });

    expect(result).toMatchObject({
      success: false,
      issues: [{ path: ["files", "schema.ts/inner.ts"], code: "INVALID_VALUE" }],
    });
  });

  it("should enforce file-count, UTF-8 source, environment, and seed limits", () => {
    const tooManyFiles = Object.fromEntries(
      Array.from({ length: MAX_RUN_FILES + 1 }, (_, index) => [`file-${index}.ts`, ""]),
    );
    const tooManyFilesResult = safeParseRunManifest({
      ...makeStableManifest(),
      files: tooManyFiles,
      entrypoints: { schema: "file-0.ts" },
    });
    const tooLargeSourceResult = safeParseRunManifest({
      ...makeStableManifest(),
      files: { "schema.ts": "é".repeat(MAX_RUN_SOURCE_BYTES / 2 + 1) },
      entrypoints: { schema: "schema.ts" },
    });
    const tooLargeEnvResult = safeParseRunManifest({
      ...makeStableManifest(),
      env: { LARGE: "é".repeat(MAX_RUN_ENV_BYTES / 2 + 1) },
    });
    const tooLargeEnvKeyResult = safeParseRunManifest({
      ...makeStableManifest(),
      env: { ["K".repeat(MAX_RUN_ENV_BYTES + 1)]: "" },
    });
    const maxSeedManifest = parseRunManifest({ ...makeStableManifest(), randomSeed: 0xffff_ffff });

    expect(tooManyFilesResult).toMatchObject({ success: false, issues: [{ path: ["files"], code: "LIMIT_EXCEEDED" }] });
    expect(tooLargeSourceResult).toMatchObject({
      success: false,
      issues: [{ path: ["files"], code: "LIMIT_EXCEEDED" }],
    });
    expect(tooLargeEnvResult).toMatchObject({ success: false, issues: [{ path: ["env"], code: "LIMIT_EXCEEDED" }] });
    expect(tooLargeEnvKeyResult).toMatchObject({
      success: false,
      issues: [{ path: ["env"], code: "LIMIT_EXCEEDED" }],
    });
    expect(maxSeedManifest.randomSeed).toBe(0xffff_ffff);
    expect(safeParseRunManifest({ ...makeStableManifest(), randomSeed: -1 })).toMatchObject({
      success: false,
      issues: [{ path: ["randomSeed"], code: "INVALID_VALUE" }],
    });
  });

  it("should keep a drizzle-seed generator version every guest accepts and reject others", () => {
    const pinned = parseRunManifest({ ...makeStableManifest(), seedGeneratorVersion: "2" });

    expect(pinned.seedGeneratorVersion).toBe("2");
    expect(parseRunManifest(makeStableManifest())).not.toHaveProperty("seedGeneratorVersion");
    expect(safeParseRunManifest({ ...makeStableManifest(), seedGeneratorVersion: "4" })).toMatchObject({
      success: false,
      issues: [{ path: ["seedGeneratorVersion"] }],
    });
  });

  it("should count UTF-8 source bytes and return a detached manifest", () => {
    const input = makeStableManifest();
    input.files["src/schema.ts"] = "é".repeat(MAX_RUN_SOURCE_BYTES / 2);
    input.files["src/run.ts"] = "";

    const parsed = parseRunManifest(input);
    Object.assign(input.files, { "src/schema.ts": "changed" });
    Object.assign(input.dependencies, { "drizzle-kit": "changed" });

    expect(parsed.files["src/schema.ts"]).toBe("é".repeat(MAX_RUN_SOURCE_BYTES / 2));
    expect(parsed.dependencies["drizzle-kit"]).toBe("0.31.11");
  });

  it("should throw structured issues from parseRunManifest", () => {
    expect(() => parseRunManifest({})).toThrow(RunManifestValidationError);
    expect(() => parseRunManifest({})).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ path: ["manifestVersion"] })]),
      }),
    );
  });
});

const typedManifest = defineRunManifest({
  kind: "drizzle-run",
  manifestVersion: 1,
  target: { dialect: "postgresql" },
  dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
  files: { "schema.ts": "export {};", "queries/run.ts": "export {};" },
  entrypoints: { schema: "schema.ts", run: "queries/run.ts" },
});

const preservedEntrypointName: "queries/run.ts" = typedManifest.entrypoints.run;
void preservedEntrypointName;

// Compile-time checks only: this function never runs.
const rejectInvalidManifestsAtCompileTime = () => {
  defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    // @ts-expect-error The selected stable ORM and Kit versions must be an admitted pair.
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "1.0.0-rc.5" },
    files: { "schema.ts": "export {};" },
    entrypoints: { schema: "schema.ts" },
  });

  // @ts-expect-error Entrypoints must refer to files in the manifest.
  defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    files: { "schema.ts": "export {};" },
    entrypoints: { schema: "missing.ts" },
  });

  // @ts-expect-error Only catalogued peer dependencies may be declared.
  defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11", unknown: "1.0.0" },
    files: { "schema.ts": "export {};" },
    entrypoints: { schema: "schema.ts" },
  });

  // @ts-expect-error Unknown top-level fields are rejected by the typed constructor.
  defineRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    files: { "schema.ts": "export {};" },
    entrypoints: { schema: "schema.ts" },
    surprise: true,
  });
};

void rejectInvalidManifestsAtCompileTime;
