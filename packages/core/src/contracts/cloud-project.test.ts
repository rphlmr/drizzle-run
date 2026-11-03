import { describe, expect, it } from "vitest";

import { digestCloudProject } from "./cloud-project.ts";

describe("digestCloudProject", () => {
  it("should give the same digest whatever order the keys come in", () => {
    const manifest = { kind: "drizzle-run", files: { "schema.ts": "a", "query.ts": "b" } };
    const reordered = { files: { "query.ts": "b", "schema.ts": "a" }, kind: "drizzle-run" };

    expect(digestCloudProject({ name: "Shop", manifest: reordered })).toBe(
      digestCloudProject({ name: "Shop", manifest }),
    );
  });

  it("should change with the content", () => {
    const manifest = { kind: "drizzle-run", files: { "schema.ts": "a" } };

    expect(digestCloudProject({ name: "Shop", manifest })).not.toBe(digestCloudProject({ name: "Shop 2", manifest }));
    expect(digestCloudProject({ name: "Shop", manifest })).not.toBe(
      digestCloudProject({ name: "Shop", manifest, trust: "untrusted" }),
    );
  });
});
