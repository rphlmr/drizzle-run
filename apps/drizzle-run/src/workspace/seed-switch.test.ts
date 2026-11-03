import type { RunManifest } from "@drizzle-run/core/manifest";
import { describe, expect, it } from "vitest";

import { getFileRoles, toggleSeedEntrypoint } from "./seed-switch";

function makeEntrypoints({
  seed = "seed.ts",
  run = "query.ts",
}: { seed?: string | null; run?: string } = {}): RunManifest["entrypoints"] {
  return { schema: "schema.ts", run, ...(seed === null ? {} : { seed }) };
}

function makeRoles({
  selected,
  seed,
  files = ["schema.ts", "query.ts", "seed.ts", "helpers.ts"],
}: {
  selected: string;
  seed?: string | null;
  files?: readonly string[];
}) {
  return getFileRoles({
    entrypoints: makeEntrypoints({ seed }),
    seedPath: seed ?? "seed.ts",
    selected,
    hasFile: (path) => files.includes(path),
  });
}

describe("getFileRoles", () => {
  it("should mark the seed file as the seed while seeding is on", () => {
    expect(makeRoles({ selected: "seed.ts" })).toEqual({
      seedOn: true,
      seedFileShown: true,
      seedSelected: true,
      helperSelected: false,
    });
  });

  it("should keep an off seed as the seed file, never a helper", () => {
    const roles = makeRoles({ selected: "seed.ts", seed: null });

    expect(roles.seedOn).toBe(false);
    expect(roles.seedSelected).toBe(true);
    expect(roles.helperSelected).toBe(false);
  });

  it("should mark a file that is neither an entry nor the seed as a helper", () => {
    expect(makeRoles({ selected: "helpers.ts" })).toMatchObject({ seedSelected: false, helperSelected: true });
  });

  it("should not mark an entry file as a helper", () => {
    expect(makeRoles({ selected: "query.ts" })).toMatchObject({ seedSelected: false, helperSelected: false });
  });

  it("should not show the seed when its file is missing", () => {
    const roles = makeRoles({ selected: "query.ts", seed: null, files: ["schema.ts", "query.ts"] });

    expect(roles).toMatchObject({ seedFileShown: false, seedSelected: false });
  });
});

describe("toggleSeedEntrypoint", () => {
  it("should drop the seed entry and keep the others when seeding is on", () => {
    const toggle = toggleSeedEntrypoint({ entrypoints: makeEntrypoints(), seedPath: "seed.ts", canSeed: false });

    expect(toggle).toEqual({ ok: true, entrypoints: { schema: "schema.ts", run: "query.ts" } });
  });

  it("should make the seed path the seed again when the project may seed from it", () => {
    const toggle = toggleSeedEntrypoint({
      entrypoints: makeEntrypoints({ seed: null }),
      seedPath: "fixtures.ts",
      canSeed: true,
    });

    expect(toggle).toEqual({ ok: true, entrypoints: { schema: "schema.ts", run: "query.ts", seed: "fixtures.ts" } });
  });

  it("should ask for the seed file before seeding from a missing or unshared file", () => {
    const toggle = toggleSeedEntrypoint({
      entrypoints: makeEntrypoints({ seed: null }),
      seedPath: "seed.ts",
      canSeed: false,
    });

    expect(toggle).toEqual({ ok: false, error: "Add seed.ts before enabling seed execution." });
  });
});
