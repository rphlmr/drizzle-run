import { describe, expect, it } from "vitest";

import { createProject } from "../project/projects";
import type { RetiredPairPlayground } from "../share/playgrounds-contract";
import { resolveEmbedLoad } from "./embed-load";

/** A playground published on `dependencies`, a pair Drizzle Run may no longer ship. */
function makePublishedOn(dependencies: Record<string, string>): RetiredPairPlayground {
  const project = createProject("Published", { dialect: "postgresql" });

  return {
    snapshot: { snapshotVersion: 1, name: project.name, manifest: { ...project.manifest, dependencies } },
    retiredPair: {
      target: { dialect: "postgresql" },
      releaseLine: "next",
      ormVersion: dependencies["drizzle-orm"] ?? "",
      kitVersion: dependencies["drizzle-kit"] ?? "",
    },
    digest: "a".repeat(64),
    updatedAt: "2026-10-11T00:00:00.000Z",
    description: null,
    community: null,
  };
}

describe("resolveEmbedLoad", () => {
  it("should open a loaded project", () => {
    const project = createProject("Embedded", { dialect: "sqlite" });

    expect(resolveEmbedLoad({ project })).toEqual({ kind: "project", project });
  });

  it("should ask for a release when the playground is on a removed pair", () => {
    const playground = makePublishedOn({ "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" });

    const state = resolveEmbedLoad({ retired: playground });

    expect(state.kind).toBe("retired");
    expect(state.kind === "retired" && state.retired.releases).toHaveLength(1);
  });

  it("should report a playground this version cannot open as unopenable, which the loader does not retry", () => {
    const unopenable = {
      kind: "failed",
      failure: { code: "unopenable", message: "This shared playground cannot be opened in an embed." },
    };

    expect(
      resolveEmbedLoad({ retired: makePublishedOn({ "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" }) }),
    ).toEqual(unopenable);
    expect(resolveEmbedLoad(null)).toEqual({
      kind: "failed",
      failure: { code: "unopenable", message: "This shared playground cannot be opened in an embed." },
    });
  });
});
