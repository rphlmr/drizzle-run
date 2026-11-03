import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DATABASE_TARGETS,
  KIT_VERSIONS,
  RELEASE_PAIRS,
  getGuestPackageVersion,
  type DatabaseTargetId,
  type KitVersion,
  type OrmVersion,
  type ReleaseLine,
  type ReleasePairId,
  type RuntimeOrmVersion,
  type SeedVersion,
} from "./catalog.ts";
import { DIALECT_IDS, DIALECTS, DialectSchema } from "./dialects.ts";

// The guest packages are the source of these pins; the literals here make a version change visible in review.
const expectedReleasePairs = {
  "orm-0.45.4__kit-0.31.11": {
    releaseLine: "legacy",
    ormVersion: "0.45.4",
    kitVersion: "0.31.11",
    recommended: false,
    guestFlavors: ["slim"],
  },
  "orm-1.0.0-rc.5__kit-1.0.0-rc.5": {
    releaseLine: "next",
    ormVersion: "1.0.0-rc.5",
    kitVersion: "1.0.0-rc.5",
    recommended: true,
    guestFlavors: ["slim", "effect"],
  },
} as const;

describe("runtime package catalog", () => {
  it("should retain only the admitted database targets and release pairs", () => {
    expectTypeOf<DatabaseTargetId>().toEqualTypeOf<"postgresql-pglite" | "sqlite-wasm">();
    expectTypeOf<OrmVersion>().toEqualTypeOf<"0.45.4" | "1.0.0-rc.5">();
    expectTypeOf<RuntimeOrmVersion>().toEqualTypeOf<"0.45.4" | "1.0.0-rc.5">();
    expectTypeOf<KitVersion>().toEqualTypeOf<"0.31.11" | "1.0.0-rc.5">();
    expectTypeOf<SeedVersion>().toEqualTypeOf<"0.3.1" | "1.0.0-rc.5">();
    expectTypeOf<ReleasePairId>().toEqualTypeOf<"orm-0.45.4__kit-0.31.11" | "orm-1.0.0-rc.5__kit-1.0.0-rc.5">();
    expectTypeOf<ReleaseLine>().toEqualTypeOf<"legacy" | "next">();
    expectTypeOf(RELEASE_PAIRS).toEqualTypeOf(expectedReleasePairs);

    expect(DATABASE_TARGETS).toEqual({
      "postgresql-pglite": { dialect: "postgresql" },
      "sqlite-wasm": { dialect: "sqlite" },
    });
    expect(RELEASE_PAIRS).toEqual(expectedReleasePairs);
    expect(KIT_VERSIONS).toEqual(["0.31.11", "1.0.0-rc.5"]);
  });

  it("should look up a guest image's pin, or null when it has none", () => {
    const effectImageId = "orm-1.0.0-rc.5__kit-1.0.0-rc.5+effect";

    expect(getGuestPackageVersion({ imageId: effectImageId, packageName: "effect" })).toBe("4.0.5");
    expect(getGuestPackageVersion({ imageId: effectImageId, packageName: "@effect/sql-pg" })).toBe("4.0.5");
    expect(getGuestPackageVersion({ imageId: "orm-0.45.4__kit-0.31.11", packageName: "zod" })).toBe("4.4.3");
    expect(getGuestPackageVersion({ imageId: "orm-0.45.4__kit-0.31.11", packageName: "effect" })).toBeNull();
    expect(getGuestPackageVersion({ imageId: "orm-0.0.0__kit-0.0.0", packageName: "zod" })).toBeNull();
  });

  it("should look up pins in injected guest images", () => {
    const guestImages = {
      "orm-2.0.0__kit-2.0.0+effect": { packages: { effect: "4.0.5" } },
      "orm-2.1.0__kit-2.1.0+effect": { packages: { effect: "4.1.0" } },
    };

    expect(getGuestPackageVersion({ imageId: "orm-2.0.0__kit-2.0.0+effect", packageName: "effect", guestImages })).toBe(
      "4.0.5",
    );
    expect(getGuestPackageVersion({ imageId: "orm-2.1.0__kit-2.1.0+effect", packageName: "effect", guestImages })).toBe(
      "4.1.0",
    );
  });
});

describe("dialects", () => {
  it("should list every dialect and point each at a database target of that dialect", () => {
    expect(DIALECT_IDS).toEqual(["postgresql", "sqlite"]);

    for (const dialect of DIALECT_IDS) {
      expect(DATABASE_TARGETS[DIALECTS[dialect].targetId]).toEqual({ dialect });
    }
  });

  it("should accept only a supported dialect id", () => {
    expect(DialectSchema.safeParse("sqlite").success).toBe(true);
    expect(DialectSchema.safeParse("mysql").error?.issues[0]?.message).toBe('Expected "postgresql" or "sqlite".');
  });
});
