import { describe, expect, it } from "vitest";

import { listSupportedTuples } from "../catalog/index.ts";
import { findRetiredPair, followInPlaceRelease, moveManifestToPair } from "./index.ts";

const postgres = { dialect: "postgresql" } as const;

function getPostgresTuple(releaseLine: "legacy" | "next") {
  const tuple = listSupportedTuples(postgres).find((candidate) => candidate.releaseLine === releaseLine);

  if (tuple === undefined) {
    throw new Error(`The catalog has no ${releaseLine} PostgreSQL pair.`);
  }

  return tuple;
}

function makeRetiredManifest() {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: postgres,
    dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" },
    files: { "schema.ts": "export const schema = {};", "query.ts": "export {};" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
  };
}

function makeRetiredNextManifest() {
  return {
    ...makeRetiredManifest(),
    dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" },
  };
}

function makeSupportedManifest() {
  const legacyTuple = getPostgresTuple("legacy");

  return {
    ...makeRetiredManifest(),
    dependencies: { "drizzle-orm": legacyTuple.ormVersion, "drizzle-kit": legacyTuple.kitVersion },
  };
}

describe("manifests on a removed ORM/Kit pair", () => {
  it("should recognize a manifest whose only problem is its pair", () => {
    expect(findRetiredPair(makeRetiredManifest())).toEqual({
      target: postgres,
      releaseLine: "legacy",
      ormVersion: "0.44.0",
      kitVersion: "0.30.0",
    });
    expect(findRetiredPair(makeRetiredNextManifest())).toEqual({
      target: postgres,
      releaseLine: "next",
      ormVersion: "1.0.0-rc.3",
      kitVersion: "1.0.0-rc.3",
    });
  });

  it("should leave supported, broken and non-manifest values alone", () => {
    const supportedManifest = makeSupportedManifest();
    const brokenManifest = { ...makeRetiredManifest(), entrypoints: { schema: "missing.ts" } };
    const taggedManifest = {
      ...makeRetiredManifest(),
      dependencies: { "drizzle-orm": "latest", "drizzle-kit": "latest" },
    };

    expect(findRetiredPair(supportedManifest)).toBeUndefined();
    expect(findRetiredPair(brokenManifest)).toBeUndefined();
    expect(findRetiredPair("manifest")).toBeUndefined();
    expect(findRetiredPair({ ...makeRetiredManifest(), target: { dialect: "mysql" } })).toBeUndefined();
    expect(findRetiredPair(taggedManifest)).toBeUndefined();
  });

  it("should move the pair to the chosen pair, keeping files", () => {
    const legacyTuple = getPostgresTuple("legacy");
    const movedManifest = moveManifestToPair(makeRetiredManifest(), legacyTuple);

    expect(movedManifest.dependencies).toEqual({
      "drizzle-orm": legacyTuple.ormVersion,
      "drizzle-kit": legacyTuple.kitVersion,
    });
    expect(movedManifest.files).toEqual(makeRetiredManifest().files);
  });

  it("should move across lines and keep the effect flavor only where the chosen pair ships it", () => {
    const nextTuple = getPostgresTuple("next");
    const legacyTuple = getPostgresTuple("legacy");
    const effectManifest = moveManifestToPair(makeRetiredNextManifest(), nextTuple, "effect");

    expect(effectManifest).toMatchObject({
      dependencies: { "drizzle-orm": nextTuple.ormVersion, "drizzle-kit": nextTuple.kitVersion },
      guestFlavor: "effect",
    });
    expect(moveManifestToPair(effectManifest, legacyTuple)).not.toHaveProperty("guestFlavor");
    expect(() => moveManifestToPair(makeRetiredManifest(), legacyTuple, "effect")).toThrow(
      "Drizzle ORM 0.45.4 has no effect guest",
    );
  });
});

describe("Legacy fix releases", () => {
  it("should move a manifest on an older Legacy version to the Legacy pair", () => {
    const legacyTuple = getPostgresTuple("legacy");
    const followedManifest = followInPlaceRelease(makeRetiredManifest());

    expect(followedManifest).toEqual({
      ...makeRetiredManifest(),
      dependencies: { "drizzle-orm": legacyTuple.ormVersion, "drizzle-kit": legacyTuple.kitVersion },
    });
  });

  it("should leave removed Next pairs, supported manifests and other values as they are", () => {
    const retiredNextManifest = makeRetiredNextManifest();
    const supportedManifest = makeSupportedManifest();

    expect(followInPlaceRelease(retiredNextManifest)).toBe(retiredNextManifest);
    expect(followInPlaceRelease(supportedManifest)).toBe(supportedManifest);
    expect(followInPlaceRelease("manifest")).toBe("manifest");
  });
});
