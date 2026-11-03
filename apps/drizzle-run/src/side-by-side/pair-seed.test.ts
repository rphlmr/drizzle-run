import { describe, expect, it } from "vitest";

import { resolveRenamedSeedRefusal } from "./pair-seed";

describe("resolveRenamedSeedRefusal", () => {
  it("should allow a project that seeds from seed.ts", () => {
    expect(resolveRenamedSeedRefusal({ schema: "schema.ts", run: "run.ts", seed: "seed.ts" })).toBeNull();
  });

  it("should allow a project without a seed", () => {
    expect(resolveRenamedSeedRefusal({ schema: "schema.ts", run: "run.ts" })).toBeNull();
  });

  it("should refuse a renamed seed in core's wording", () => {
    expect(resolveRenamedSeedRefusal({ schema: "schema.ts", run: "run.ts", seed: "db/seed.ts" })).toBe(
      "A side-by-side project seeds from seed.ts: rename db/seed.ts to seed.ts first.",
    );
  });
});
