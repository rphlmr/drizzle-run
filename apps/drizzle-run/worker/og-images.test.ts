import { describe, expect, it } from "vitest";

import {
  describeShareImage,
  listShareImageVariants,
  resolveShareImageVariant,
  toShareImagePath,
  type OgSide,
} from "./og-images";

/** A side on `dialect`, plain unless `guestFlavor` says otherwise. */
function makeSide(dialect: OgSide["dialect"], ormVersion: string, guestFlavor: OgSide["guestFlavor"] = "slim"): OgSide {
  return { dialect, ormVersion, guestFlavor };
}

describe("resolveShareImageVariant", () => {
  it("should name a share's database and versions, older side first", () => {
    const legacy = makeSide("sqlite", "0.45.4");
    const rc = makeSide("sqlite", "1.0.0-rc.5");
    const variant = resolveShareImageVariant("bug-repros", [rc, legacy]);

    expect(variant).toEqual({ topic: "bug-repros", runtime: { sides: [legacy, rc] } });
    expect(toShareImagePath(variant)).toBe("/og/shares/bug-repros/sqlite/0.45.4-vs-1.0.0-rc.5.png");
    expect(describeShareImage(variant)).toBe("A Drizzle bug repro, SQLite 0.45.4 vs 1.0.0-rc.5");
  });

  it("should tell rc.5 and rc.5 with Effect apart, the plain side first", () => {
    const rc = makeSide("postgresql", "1.0.0-rc.5");
    const rcEffect = makeSide("postgresql", "1.0.0-rc.5", "effect");
    const variant = resolveShareImageVariant("playground", [rcEffect, rc]);

    expect(variant).toEqual({ topic: "playground", runtime: { sides: [rc, rcEffect] } });
    expect(toShareImagePath(variant)).toBe("/og/shares/playground/postgresql/1.0.0-rc.5-vs-1.0.0-rc.5+effect.png");
    expect(describeShareImage(variant)).toBe(
      "A shared Drizzle playground, PostgreSQL 1.0.0-rc.5 vs 1.0.0-rc.5 + Effect",
    );
  });

  it("should name each side's database when the sides run on two, PostgreSQL first", () => {
    const sqlite = makeSide("sqlite", "0.45.4");
    const postgres = makeSide("postgresql", "1.0.0-rc.5");
    const variant = resolveShareImageVariant("playground", [sqlite, postgres]);

    expect(variant).toEqual({ topic: "playground", runtime: { sides: [postgres, sqlite] } });
    expect(toShareImagePath(variant)).toBe("/og/shares/playground/postgresql-vs-sqlite/1.0.0-rc.5-vs-0.45.4.png");
    expect(describeShareImage(variant)).toBe("A shared Drizzle playground, PostgreSQL 1.0.0-rc.5 vs SQLite 0.45.4");
  });

  it("should fall back to the topic's generic image for a version or flavor the catalog does not ship", () => {
    for (const side of [makeSide("postgresql", "0.44.0"), makeSide("postgresql", "0.45.4", "effect")]) {
      const variant = resolveShareImageVariant("playground", [side]);

      expect(variant).toEqual({ topic: "playground", runtime: null });
      expect(toShareImagePath(variant)).toBe("/og/shares/playground.png");
    }
  });
});

describe("listShareImageVariants", () => {
  it("should list every variant a share can resolve to, on one database or both", () => {
    const listed = new Set(listShareImageVariants().map(toShareImagePath));
    const sides = (["postgresql", "sqlite"] as const).flatMap((dialect) => [
      makeSide(dialect, "0.45.4"),
      makeSide(dialect, "1.0.0-rc.5"),
      makeSide(dialect, "1.0.0-rc.5", "effect"),
      makeSide(dialect, "0.44.0"),
    ]);

    for (const topic of ["playground", "bug-repros"] as const) {
      for (const left of sides) {
        expect(listed).toContain(toShareImagePath(resolveShareImageVariant(topic, [left])));

        for (const right of sides) {
          expect(listed).toContain(toShareImagePath(resolveShareImageVariant(topic, [left, right])));
        }
      }
    }
  });
});
