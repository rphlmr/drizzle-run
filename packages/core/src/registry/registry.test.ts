import { describe, expect, expectTypeOf, it } from "vitest";

import {
  APPROVED_MODULES,
  assertApprovedSpecifier,
  listCompanionLibraries,
  resolveApprovedModule,
} from "./approved-modules.ts";
import { listGuestImages, resolveGuestFlavor, toGuestImageId, type GuestSelection } from "./guest-images.ts";
import {
  assertSupportedTuple,
  compareVersions,
  getRecommendedTuple,
  isSupportedTuple,
  listSupportedTuples,
  resolveSupportedTuple,
  selectFromPairs,
} from "./selectors.ts";
import type { RuntimeTupleId, RuntimeTupleQuery, RuntimeTupleSelection, SupportedRuntimeTuple } from "./types.ts";
import { validateRuntimeTypeSymmetry } from "./validation.ts";

const postgres = { dialect: "postgresql" } as const;

const sqlite = { dialect: "sqlite" } as const;

/** A guest's companion libraries as `name@version`, so a list reads in one line each. */
function toLibrarySpecifiers(guest: GuestSelection): string[] {
  return listCompanionLibraries(guest).map(({ packageName, version }) => `${packageName}@${version}`);
}

describe("target-qualified runtime tuples", () => {
  it("should admit two independently identified tuples per target", () => {
    expect(listSupportedTuples(postgres)).toHaveLength(2);
    expect(listSupportedTuples(sqlite)).toHaveLength(2);
    expect(new Set(listSupportedTuples().map((tuple) => tuple.id)).size).toBe(4);
    expect(new Set(listSupportedTuples().map((tuple) => tuple.id))).toEqual(
      new Set([
        "postgresql-pglite__orm-0.45.4__kit-0.31.11",
        "postgresql-pglite__orm-1.0.0-rc.5__kit-1.0.0-rc.5",
        "sqlite-wasm__orm-0.45.4__kit-0.31.11",
        "sqlite-wasm__orm-1.0.0-rc.5__kit-1.0.0-rc.5",
      ]),
    );
  });

  it.each([
    ["0.45.1", "0.31.11"],
    ["0.45.4", "0.31.9"],
    ["1.0.0-rc.5", "1.0.0-rc.3"],
    ["1.0.0-rc.6", "1.0.0-rc.6"],
    ["0.45.4", "1.0.0-rc.5"],
  ])("should reject unsupported pair %s / %s without fallback", (ormVersion, kitVersion) => {
    for (const target of [postgres, sqlite]) {
      expect(isSupportedTuple({ target, ormVersion, kitVersion })).toBe(false);
    }
  });

  it("should throw on an ORM and Kit from different pairs, which the version types alone allow", () => {
    for (const [target, engine] of [
      [postgres, "postgresql-pglite"],
      [sqlite, "sqlite-wasm"],
    ] as const) {
      expect(() => resolveSupportedTuple({ target, ormVersion: "0.45.4", kitVersion: "1.0.0-rc.5" })).toThrow(
        `Unsupported runtime tuple: ${engine}, drizzle-orm@0.45.4, drizzle-kit@1.0.0-rc.5`,
      );
    }
  });

  it("should resolve compatibility only within a target", () => {
    expect(getRecommendedTuple(sqlite)).toMatchObject({
      ormVersion: "1.0.0-rc.5",
      kitVersion: "1.0.0-rc.5",
    });
    expect(isSupportedTuple({ target: sqlite, ormVersion: "0.45.4", kitVersion: "1.0.0-rc.5" })).toBe(false);
  });

  it("should reject a version the catalog does not ship before it runs", () => {
    expect(() =>
      // @ts-expect-error A selection names shipped versions only, so a removed release fails to compile.
      resolveSupportedTuple({ target: sqlite, ormVersion: "1.0.0-rc.4", kitVersion: "1.0.0-rc.4" }),
    ).toThrow("Unsupported runtime tuple: sqlite-wasm, drizzle-orm@1.0.0-rc.4, drizzle-kit@1.0.0-rc.4");
  });

  it("should narrow unchecked versions to a selection once they are supported", () => {
    const query: RuntimeTupleQuery = { target: sqlite, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" };

    if (!isSupportedTuple(query)) {
      throw new Error("Expected rc.5 to be a supported SQLite pair");
    }

    expectTypeOf(query.ormVersion).toEqualTypeOf<RuntimeTupleSelection["ormVersion"]>();
    expect(resolveSupportedTuple(query).id).toBe("sqlite-wasm__orm-1.0.0-rc.5__kit-1.0.0-rc.5");
  });

  it("should throw from assertSupportedTuple with the message resolveSupportedTuple gives", () => {
    const supported: RuntimeTupleQuery = { target: postgres, ormVersion: "0.45.4", kitVersion: "0.31.11" };
    const removed: RuntimeTupleQuery = { target: postgres, ormVersion: "1.0.0-rc.4", kitVersion: "1.0.0-rc.4" };

    expect(() => assertSupportedTuple(supported)).not.toThrow();
    expect(() => assertSupportedTuple(removed)).toThrow(
      "Unsupported runtime tuple: postgresql-pglite, drizzle-orm@1.0.0-rc.4, drizzle-kit@1.0.0-rc.4",
    );
  });
});

function makePair(
  releaseLine: SupportedRuntimeTuple["releaseLine"],
  ormVersion: string,
  kitVersion: string,
): SupportedRuntimeTuple {
  return {
    id: `postgresql-pglite__orm-${ormVersion}__kit-${kitVersion}` as RuntimeTupleId,
    target: postgres,
    releaseLine,
    ormVersion: ormVersion as SupportedRuntimeTuple["ormVersion"],
    kitVersion: kitVersion as SupportedRuntimeTuple["kitVersion"],
    recommended: releaseLine === "legacy",
  };
}

describe("release lines", () => {
  it("should name release lines legacy and next only", () => {
    expect(new Set(listSupportedTuples().map((tuple) => tuple.releaseLine))).toEqual(new Set(["legacy", "next"]));
  });

  it("should keep one Legacy pair per database, updated in place by fix releases", () => {
    for (const target of [postgres, sqlite]) {
      expect(listSupportedTuples(target).filter((tuple) => tuple.releaseLine === "legacy")).toHaveLength(1);
    }
  });

  it("should list the newest pair of each line, next first", () => {
    const shipped = selectFromPairs(listSupportedTuples(), postgres);

    expect(shipped.newest.map((tuple) => [tuple.releaseLine, tuple.ormVersion])).toEqual([
      ["next", "1.0.0-rc.5"],
      ["legacy", "0.45.4"],
    ]);
    expect(shipped.others).toEqual([]);
  });

  it("should move an older pair of a line to the other pairs", () => {
    const pairs = [
      makePair("legacy", "0.45.4", "0.31.11"),
      makePair("next", "1.0.0-rc.5", "1.0.0-rc.5"),
      makePair("next", "1.0.0-rc.6", "1.0.0-rc.6"),
      makePair("legacy", "0.44.0", "0.31.0"),
    ];
    const selection = selectFromPairs(pairs, postgres);

    expect(selection.newest.map((tuple) => tuple.ormVersion)).toEqual(["1.0.0-rc.6", "0.45.4"]);
    expect(selection.others.map((tuple) => tuple.ormVersion)).toEqual(["1.0.0-rc.5", "0.44.0"]);
  });

  it("should order pre-releases by semver", () => {
    const pairs = [
      makePair("next", "1.0.0-rc.10", "1.0.0-rc.10"),
      makePair("next", "1.0.0-rc.9", "1.0.0-rc.9"),
      makePair("next", "1.0.0", "1.0.0"),
    ];

    expect(selectFromPairs(pairs, postgres).newest.map((tuple) => tuple.ormVersion)).toEqual(["1.0.0"]);
    expect(selectFromPairs(pairs, postgres).others.map((tuple) => tuple.ormVersion)).toEqual([
      "1.0.0-rc.10",
      "1.0.0-rc.9",
    ]);
  });

  it("should keep hyphens inside a pre-release and ignore build metadata", () => {
    expect(compareVersions("1.0.0-beta-2", "1.0.0-beta-10")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta-2", "1.0.0-beta")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1+build.5", "1.0.0-rc.1")).toBe(0);
  });
});

const asSlim = (tuple: SupportedRuntimeTuple): GuestSelection => ({ tuple, guestFlavor: "slim" });

describe("approved module registry", () => {
  const legacyPostgres = resolveSupportedTuple({
    target: postgres,
    ormVersion: "0.45.4",
    kitVersion: "0.31.11",
  });
  const nextSqlite = resolveSupportedTuple({
    target: sqlite,
    ormVersion: "1.0.0-rc.5",
    kitVersion: "1.0.0-rc.5",
  });
  const nextPostgres = resolveSupportedTuple({
    target: postgres,
    ormVersion: "1.0.0-rc.5",
    kitVersion: "1.0.0-rc.5",
  });

  it("should allow the context specifier", () => {
    const contextModule = APPROVED_MODULES.find((entry) => entry.runtimeArtifact.loader === "virtual_context");

    expect(contextModule?.allowedSpecifiers).toEqual(["@drizzle-run/runtime/context"]);
  });

  it.each(["@electric-sql/pglite", "@sqlite.org/sqlite-wasm"])(
    "should direct imports of the host engine %s to the runtime context",
    (specifier) => {
      expect(() => assertApprovedSpecifier(asSlim(nextSqlite), specifier)).toThrow(
        `${specifier} is package-internal; use @drizzle-run/runtime/context`,
      );
    },
  );

  it("should keep runtime and declaration metadata symmetric", () => {
    const userPackages = APPROVED_MODULES.filter(
      (entry) => entry.visibility === "user" && entry.packageName !== "@drizzle-run/runtime",
    );
    const legacyKit = APPROVED_MODULES.find(
      (entry) => entry.packageName === "drizzle-kit" && entry.version === "0.31.11",
    );

    expect(validateRuntimeTypeSymmetry(APPROVED_MODULES)).toEqual([]);
    expect(userPackages.every((entry) => entry.runtimeArtifact.loader === "guest_package")).toBe(true);
    expect(legacyKit?.integrity).toEqual({
      algorithm: "package_manager",
      source: "drizzle-kit@0.31.11",
      required: true,
    });
  });

  it("should expose stable standalone integrations and reject next-only paths", () => {
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-zod")?.version).toBe("0.8.3");
    expect(() => assertApprovedSpecifier(asSlim(legacyPostgres), "drizzle-orm/zod")).toThrow(
      /only for verified Drizzle ORM 1.x/,
    );
  });

  it("should expose next integrations and reject old standalone imports", () => {
    expect(resolveApprovedModule(asSlim(nextSqlite), "drizzle-orm/typebox")?.version).toBe("1.0.0-rc.5");
    expect(resolveApprovedModule(asSlim(nextSqlite), "drizzle-seed")?.version).toBe("1.0.0-rc.5");
    expect(() => assertApprovedSpecifier(asSlim(nextSqlite), "drizzle-zod")).toThrow(/use its drizzle-orm integration/);
  });

  it("should list a guest's companion libraries without Drizzle, the runtime context or internal packages", () => {
    expect(toLibrarySpecifiers(asSlim(legacyPostgres))).toEqual([
      "@sinclair/typebox@0.34.52",
      "arktype@2.2.3",
      "drizzle-arktype@0.1.3",
      "drizzle-seed@0.3.1",
      "drizzle-typebox@0.3.3",
      "drizzle-valibot@0.4.2",
      "drizzle-zod@0.8.3",
      "valibot@1.4.2",
      "zod@4.4.3",
    ]);
    expect(toLibrarySpecifiers(asSlim(nextSqlite))).toEqual([
      "@js-temporal/polyfill@0.5.1",
      "@sinclair/typebox@0.34.52",
      "arktype@2.2.3",
      "drizzle-seed@1.0.0-rc.5",
      "typebox@1.2.19",
      "valibot@1.4.2",
      "zod@4.4.3",
    ]);
    expect(toLibrarySpecifiers({ tuple: nextPostgres, guestFlavor: "effect" })).toEqual([
      "@effect/sql-pg@4.0.5",
      "@js-temporal/polyfill@0.5.1",
      "@sinclair/typebox@0.34.52",
      "arktype@2.2.3",
      "drizzle-seed@1.0.0-rc.5",
      "effect@4.0.5",
      "typebox@1.2.19",
      "valibot@1.4.2",
      "zod@4.4.3",
    ]);
  });

  it("should not expose a target-incompatible database driver", () => {
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/libsql")).toBeUndefined();
    expect(resolveApprovedModule(asSlim(nextSqlite), "drizzle-orm/pglite")).toBeUndefined();
  });

  it("should admit exact common and supported-dialect ORM export families", () => {
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/logger")).toBeDefined();
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/utils")).toBeDefined();
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/pg-core/utils/array")).toBeDefined();
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/node-postgres/migrator")).toBeDefined();
    expect(
      resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/sqlite-core/query-builders/update"),
    ).toBeUndefined();
    expect(resolveApprovedModule(asSlim(legacyPostgres), "drizzle-orm/libsql/web")).toBeUndefined();
    expect(resolveApprovedModule(asSlim(nextSqlite), "drizzle-orm/sqlite-core/query-builders/update")).toBeDefined();
    expect(resolveApprovedModule(asSlim(nextSqlite), "drizzle-orm/libsql/web")).toBeDefined();
    expect(resolveApprovedModule(asSlim(nextPostgres), "drizzle-orm/pg-core/columns/bytea")).toBeDefined();
    expect(resolveApprovedModule(asSlim(nextSqlite), "drizzle-orm/mysql-core")).toBeUndefined();
  });
});

function packagesOf(guest: GuestSelection): string[] {
  return listCompanionLibraries(guest).map(({ packageName }) => packageName);
}

describe("guest flavors", () => {
  const nextPostgres = resolveSupportedTuple({ target: postgres, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" });
  const nextSqlite = resolveSupportedTuple({ target: sqlite, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" });

  it("should read the flavor from the manifest's guestFlavor, slim when it has none", () => {
    expect(resolveGuestFlavor({})).toBe("slim");
    expect(resolveGuestFlavor({ guestFlavor: "slim" })).toBe("slim");
    expect(resolveGuestFlavor({ guestFlavor: "effect" })).toBe("effect");
  });

  it("should list the target's Effect SQL client only on the effect flavor", () => {
    expect(packagesOf({ tuple: nextPostgres, guestFlavor: "effect" })).toEqual(
      expect.arrayContaining(["effect", "@effect/sql-pg"]),
    );
    expect(packagesOf({ tuple: nextPostgres, guestFlavor: "effect" })).not.toContain("@effect/sql-libsql");
    expect(packagesOf({ tuple: nextSqlite, guestFlavor: "effect" })).toContain("@effect/sql-libsql");
    expect(packagesOf({ tuple: nextSqlite, guestFlavor: "slim" })).not.toContain("effect");
  });

  it("should keep the slim image id and suffix other flavors", () => {
    expect(toGuestImageId({ ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5", guestFlavor: "slim" })).toBe(
      "orm-1.0.0-rc.5__kit-1.0.0-rc.5",
    );
    expect(toGuestImageId({ ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5", guestFlavor: "effect" })).toBe(
      "orm-1.0.0-rc.5__kit-1.0.0-rc.5+effect",
    );
  });

  it("should ship an effect image only for the Next pair", () => {
    expect(listGuestImages().map((image) => image.id)).toEqual([
      "orm-0.45.4__kit-0.31.11",
      "orm-1.0.0-rc.5__kit-1.0.0-rc.5",
      "orm-1.0.0-rc.5__kit-1.0.0-rc.5+effect",
    ]);
  });

  it("should approve Effect packages and integrations only on the effect flavor", () => {
    const slimPostgres = { tuple: nextPostgres, guestFlavor: "slim" } as const;
    const effectPostgres = { tuple: nextPostgres, guestFlavor: "effect" } as const;
    const effectSqlite = { tuple: nextSqlite, guestFlavor: "effect" } as const;

    for (const specifier of [
      "effect",
      "@effect/sql-pg/PgClient",
      "drizzle-orm/effect-schema",
      "drizzle-orm/effect-postgres",
    ]) {
      expect(resolveApprovedModule(slimPostgres, specifier)).toBeUndefined();
      expect(resolveApprovedModule(effectPostgres, specifier)).toBeDefined();
    }

    expect(resolveApprovedModule(effectSqlite, "@effect/sql-libsql/LibsqlClient")?.version).toBe("4.0.5");
    expect(resolveApprovedModule(effectSqlite, "drizzle-orm/effect-libsql")).toBeDefined();
    expect(resolveApprovedModule(effectSqlite, "@effect/sql-pg/PgClient")).toBeUndefined();
    expect(resolveApprovedModule(effectPostgres, "drizzle-orm/zod")).toBeDefined();
    expect(() => assertApprovedSpecifier(slimPostgres, "drizzle-orm/effect-schema")).toThrow(
      /needs Effect 4\.0\.5: pick the "with Effect" row in the Drizzle version picker/,
    );
  });
});

describe("PostgreSQL driver declarations", () => {
  const ormEntries = APPROVED_MODULES.filter((entry) => entry.packageName === "drizzle-orm");

  it("should give every PostgreSQL drizzle-orm entry its guest's @types/pg and @types/node, and SQLite none", () => {
    const postgresEntries = ormEntries.filter((entry) => entry.targets.includes("postgresql-pglite"));
    const sqliteEntries = ormEntries.filter((entry) => !entry.targets.includes("postgresql-pglite"));

    expect(postgresEntries.map((entry) => entry.types.driverArtifact?.packages)).toEqual(
      postgresEntries.map(() => ({ "@types/pg": "8.23.1", "@types/node": "24.19.2" })),
    );
    expect(sqliteEntries.map((entry) => entry.types.driverArtifact)).toEqual(sqliteEntries.map(() => undefined));
  });

  it("should share one artifact across the ORM versions and flavors that pin the same types", () => {
    const driverArtifactIds = new Set(ormEntries.map((entry) => entry.types.driverArtifact?.id).filter(Boolean));

    expect([...driverArtifactIds]).toEqual(["types:@types/pg@8.23.1+@types/node@24.19.2"]);
    expect(ormEntries.find((entry) => entry.types.driverArtifact !== undefined)?.types.driverArtifact).toMatchObject({
      manifestPath: "./artifacts/declarations/node-postgres__at__types__pg__8.23.1__at__types__node__24.19.2.json",
      root: "file:///__drizzle_run_types__/node-postgres__at__types__pg__8.23.1__at__types__node__24.19.2",
    });
  });
});
