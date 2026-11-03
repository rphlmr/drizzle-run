import { pairSide } from "@drizzle-run/core/pair";
import { describe, expect, it } from "vitest";

import { pairManifest } from "./pair";
import { fixtureTuple, projectManifest } from "./run";

describe("pairManifest", () => {
  it("should put the Legacy pair on the first side and the Next pair on the second, on PostgreSQL by default", () => {
    const manifest = pairManifest();
    const legacy = fixtureTuple({ dialect: "postgresql" }, "legacy");
    const next = fixtureTuple({ dialect: "postgresql" }, "next");

    expect(pairSide(manifest, 0)).toMatchObject({
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": legacy.ormVersion, "drizzle-kit": legacy.kitVersion },
    });
    expect(pairSide(manifest, 1)).toMatchObject({
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion },
    });
  });

  it("should give each side its own schema and query, with no shared files", () => {
    const manifest = pairManifest();
    const own = projectManifest();

    expect(manifest.files).toEqual({});
    expect(manifest.entrypoints).toEqual(own.entrypoints);

    for (const side of [0, 1] as const) {
      expect(pairSide(manifest, side).files).toEqual(own.files);
    }
  });

  it("should keep seed.ts as the one shared seed file, off both sides, when seed is on", () => {
    const manifest = pairManifest(undefined, { seed: true });
    const own = projectManifest("postgresql", { seed: true });
    const { "seed.ts": seed, ...sideFiles } = own.files;

    expect(manifest.entrypoints).toEqual(own.entrypoints);
    expect(manifest.files).toEqual({ "seed.ts": seed });

    for (const side of manifest.sides) {
      expect(side.files).toEqual(sideFiles);
    }

    expect(pairSide(manifest, 1).files).toEqual(own.files);
  });

  it("should keep the seed shared on a cross-database pair too", () => {
    const manifest = pairManifest([{ dialect: "postgresql" }, { dialect: "sqlite" }], { seed: true });

    expect(Object.keys(manifest.files)).toEqual(["seed.ts"]);
    expect(manifest.entrypoints.seed).toBe("seed.ts");
  });

  it("should put each side on its own target for a cross-database pair", () => {
    const manifest = pairManifest([{ dialect: "postgresql" }, { dialect: "sqlite" }]);
    const next = fixtureTuple({ dialect: "sqlite" }, "next");

    expect(pairSide(manifest, 0).target).toEqual({ dialect: "postgresql" });
    expect(pairSide(manifest, 1)).toMatchObject({
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion },
    });
  });
});
