import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { listSupportedTuples } from "../catalog/index.ts";
import type { RunManifest } from "../manifest/types.ts";
import { parseRunManifest } from "../manifest/validation.ts";
import { createPairManifest } from "../pair/index.ts";
import {
  canonicalPlaygroundSnapshot,
  digestPlaygroundSnapshot,
  digestRetiredPairSnapshot,
  findRetiredPairSnapshot,
  MAX_PLAYGROUND_SNAPSHOT_BYTES,
  parsePlaygroundSnapshot,
  parsePublishedPlaygroundSnapshot,
  PlaygroundSnapshotValidationError,
  safeParsePlaygroundSnapshot,
} from "./playground-snapshot.ts";

function makeManifest() {
  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: { "schema.ts": "export {};" },
    entrypoints: { schema: "schema.ts" },
  };
}

function makePublishedSnapshot(): unknown {
  const snapshot = {
    snapshotVersion: 1,
    name: "Old pair",
    manifest: { ...makeManifest(), dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
  };

  return JSON.parse(JSON.stringify(snapshot));
}

describe("PlaygroundSnapshot", () => {
  it("should parse and detach versioned snapshot envelopes", () => {
    const source = "export const schema = {};";
    const input = {
      snapshotVersion: 1,
      name: "Starter",
      manifest: { ...makeManifest(), files: { "schema.ts": source } },
    };

    const parsed = parsePlaygroundSnapshot(input);
    input.name = "Changed";
    input.manifest.files["schema.ts"] = "changed";

    expect(parsed.name).toBe("Starter");
    expect(parsed.manifest.files["schema.ts"]).toBe(source);
  });

  it("should reject unknown envelope fields, unsupported versions, and empty names", () => {
    const result = safeParsePlaygroundSnapshot({
      snapshotVersion: 2,
      name: "  ",
      manifest: makeManifest(),
      lesson: {},
    });

    expect(result).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["snapshotVersion"], code: "INVALID_VALUE" }),
        expect.objectContaining({ path: ["name"], code: "INVALID_VALUE" }),
        expect.objectContaining({ path: ["lesson"], code: "UNKNOWN_FIELD" }),
      ]),
    });
  });

  it("should wrap manifest issues with the snapshot field path", () => {
    const result = safeParsePlaygroundSnapshot({
      snapshotVersion: 1,
      name: "Starter",
      manifest: { ...makeManifest(), unexpected: true },
    });

    expect(result).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["manifest", "unexpected"], code: "UNKNOWN_FIELD" }),
      ]),
    });

    expect(() => parsePlaygroundSnapshot({})).toThrow(PlaygroundSnapshotValidationError);
  });

  it("should use stable canonical JSON and hash the exact canonical UTF-8 bytes", () => {
    const snapshot = parsePlaygroundSnapshot({
      snapshotVersion: 1,
      name: "Canonical",
      manifest: {
        ...makeManifest(),
        env: { SECOND: "2", FIRST: "1" },
        files: { "z.ts": "z", "schema.ts": "export {};" },
        entrypoints: { schema: "schema.ts", run: "z.ts" },
      },
    });
    const json = canonicalPlaygroundSnapshot(snapshot);

    expect(json).toBe(canonicalPlaygroundSnapshot(JSON.parse(json)));
    expect(digestPlaygroundSnapshot(snapshot)).toBe(createHash("sha256").update(json, "utf8").digest("hex"));
    expect(digestPlaygroundSnapshot(snapshot)).toHaveLength(64);
  });

  it("should parse a snapshot to publish once, with its canonical JSON and that JSON's digest", () => {
    const input = {
      snapshotVersion: 1,
      name: "Published",
      manifest: { ...makeManifest(), env: { SECOND: "2", FIRST: "1" } },
    };

    const published = parsePublishedPlaygroundSnapshot(input);

    expect(published.snapshot).toEqual(parsePlaygroundSnapshot(input));
    expect(published.canonicalJson).toBe(canonicalPlaygroundSnapshot(published.snapshot));
    expect(published.digest).toBe(createHash("sha256").update(published.canonicalJson, "utf8").digest("hex"));
  });

  it("should refuse an invalid snapshot to publish with every issue", () => {
    expect(() => parsePublishedPlaygroundSnapshot({ snapshotVersion: 1, name: " ", manifest: makeManifest() })).toThrow(
      PlaygroundSnapshotValidationError,
    );
  });

  it("should limit the complete serialized snapshot JSON to 1 MiB", () => {
    const result = safeParsePlaygroundSnapshot({
      snapshotVersion: 1,
      name: "Large source",
      manifest: {
        ...makeManifest(),
        files: { "schema.ts": "x".repeat(MAX_PLAYGROUND_SNAPSHOT_BYTES) },
      },
    });

    expect(result).toMatchObject({
      success: false,
      issues: [{ path: [], code: "SNAPSHOT_TOO_LARGE" }],
    });
  });
});

describe("snapshots on a removed ORM/Kit pair", () => {
  it("should keep the snapshot as published and name its pair", () => {
    const found = findRetiredPairSnapshot(makePublishedSnapshot());

    expect(found?.retiredPair).toEqual({
      target: { dialect: "sqlite" },
      releaseLine: "next",
      ormVersion: "1.0.0-rc.3",
      kitVersion: "1.0.0-rc.3",
    });
    expect(found?.snapshot).toEqual(makePublishedSnapshot());
  });

  it("should digest the published canonical bytes, so integrity checks still hold", () => {
    const found = findRetiredPairSnapshot(makePublishedSnapshot());
    const canonical = [
      '{"manifest":{"dependencies":{"drizzle-kit":"1.0.0-rc.3","drizzle-orm":"1.0.0-rc.3"},',
      '"entrypoints":{"schema":"schema.ts"},"files":{"schema.ts":"export {};"},"kind":"drizzle-run",',
      '"manifestVersion":1,"target":{"dialect":"sqlite"}},"name":"Old pair","snapshotVersion":1}',
    ].join("");
    const expectedDigest = createHash("sha256").update(canonical).digest("hex");

    expect(found && digestRetiredPairSnapshot(found.snapshot)).toBe(expectedDigest);
  });

  it("should name the older Legacy side or the removed Next side of a side by side", () => {
    const [legacy] = listSupportedTuples({ dialect: "sqlite" }).filter((tuple) => tuple.releaseLine === "legacy");
    const [next] = listSupportedTuples({ dialect: "sqlite" }).filter((tuple) => tuple.releaseLine === "next");

    if (legacy === undefined || next === undefined) {
      throw new Error("The catalog has no Legacy or Next SQLite pair.");
    }

    const base = parseRunManifest({
      ...makeManifest(),
      dependencies: { "drizzle-orm": legacy.ormVersion, "drizzle-kit": legacy.kitVersion },
      files: { "schema.ts": "export {};", "query.ts": "export {};" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
    });
    const current = createPairManifest(base, [legacy, next], "separate");
    const withSide = (index: 0 | 1, dependencies: Record<string, string>) =>
      JSON.parse(
        JSON.stringify({
          snapshotVersion: 1,
          name: "Old side",
          manifest: {
            ...current,
            sides: current.sides.map((side, sideIndex) => (sideIndex === index ? { ...side, dependencies } : side)),
          },
        }),
      ) as unknown;
    const olderLegacy = withSide(0, { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" });

    expect(safeParsePlaygroundSnapshot(olderLegacy).success).toBe(false);
    expect(findRetiredPairSnapshot(olderLegacy)).toEqual({
      snapshot: olderLegacy,
      retiredPair: { target: { dialect: "sqlite" }, releaseLine: "legacy", ormVersion: "0.44.0", kitVersion: "0.30.0" },
    });
    expect(
      findRetiredPairSnapshot(withSide(1, { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" }))?.retiredPair,
    ).toEqual({
      target: { dialect: "sqlite" },
      releaseLine: "next",
      ormVersion: "1.0.0-rc.3",
      kitVersion: "1.0.0-rc.3",
    });
  });

  it("should ignore supported snapshots and envelopes with other problems", () => {
    const supported = { snapshotVersion: 1, name: "Current", manifest: makeManifest() };

    expect(findRetiredPairSnapshot(supported)).toBeUndefined();
    expect(findRetiredPairSnapshot({ ...(makePublishedSnapshot() as object), extra: true })).toBeUndefined();
    expect(findRetiredPairSnapshot({ ...(makePublishedSnapshot() as object), name: " " })).toBeUndefined();
    expect(findRetiredPairSnapshot({ ...(makePublishedSnapshot() as object), snapshotVersion: 2 })).toBeUndefined();
  });

  it("should share a side-by-side project with both sides and keep its digest stable", () => {
    const [first, second] = listSupportedTuples({ dialect: "sqlite" });

    if (!first || !second) {
      throw new Error("Expected two SQLite pairs.");
    }

    const base: RunManifest = {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "schema.ts": "export {};" },
      entrypoints: { schema: "schema.ts" },
    };
    const pair = createPairManifest(base, [first, second], "separate");
    const snapshot = parsePlaygroundSnapshot({ snapshotVersion: 1, name: "Both", manifest: pair });

    expect(snapshot.manifest).toEqual(pair);
    const roundTripped = parsePlaygroundSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(digestPlaygroundSnapshot(snapshot)).toBe(digestPlaygroundSnapshot(roundTripped));

    const broken = safeParsePlaygroundSnapshot({
      snapshotVersion: 1,
      name: "Both",
      manifest: { ...pair, sides: [pair.sides[0]] },
    });

    expect(broken).toMatchObject({ success: false, issues: [{ path: ["manifest", "sides"] }] });
  });
});
