import type { PairManifest } from "@drizzle-run/core/pair";
import { describe, expect, it } from "vitest";

import { EMBED_PREVIEW_LIMITS } from "../embed-loader/protocol";
import { createProject } from "../project/projects";
import { buildEmbedPreview } from "./embed-preview";

const pairManifest: PairManifest = {
  kind: "drizzle-run-pair",
  manifestVersion: 1,
  entrypoints: { schema: "schema.ts", run: "query.ts" },
  files: { "schema.ts": "export {};\n" },
  sides: [
    {
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "query.ts": "const rows = await db.query.users.findMany();\n" },
    },
    {
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      files: { "query.ts": "const rows = await db.query.users.findMany({ where: { id: 1 } });\n" },
    },
  ],
};

describe("buildEmbedPreview", () => {
  it("should show the project's name, the description its author wrote, what it runs on, and the author", () => {
    const project = createProject("Users by name", { dialect: "sqlite" });

    expect(buildEmbedPreview({ ...project, description: "  Filter users by name.  ", author: "octocat" })).toEqual({
      title: "Users by name",
      description: "Filter users by name.",
      runtime: [{ drizzleOrm: project.manifest.dependencies["drizzle-orm"], database: "SQLite" }],
      author: "octocat",
    });
  });

  it("should leave out a blank description and a missing author", () => {
    const project = createProject("Users by name", { dialect: "sqlite" });

    expect(buildEmbedPreview({ ...project, description: " " })).toEqual({
      title: "Users by name",
      runtime: [{ drizzleOrm: project.manifest.dependencies["drizzle-orm"], database: "SQLite" }],
    });
  });

  it("should leave out what it runs on when the manifest is unknown", () => {
    expect(buildEmbedPreview({ name: "Retired pair" })).toEqual({ title: "Retired pair" });
  });

  it("should give each side of a side-by-side project its release and database", () => {
    expect(buildEmbedPreview({ name: "Relational queries", manifest: pairManifest }).runtime).toEqual([
      { drizzleOrm: "0.45.4", database: "PostgreSQL" },
      { drizzleOrm: "1.0.0-rc.5", database: "PostgreSQL" },
    ]);

    const crossDatabase: PairManifest = {
      ...pairManifest,
      sides: [pairManifest.sides[0], { ...pairManifest.sides[1], target: { dialect: "sqlite" } }],
    };

    expect(buildEmbedPreview({ name: "Two databases", manifest: crossDatabase }).runtime).toEqual([
      { drizzleOrm: "0.45.4", database: "PostgreSQL" },
      { drizzleOrm: "1.0.0-rc.5", database: "SQLite" },
    ]);
  });

  it("should cut a long name and description to the loader's limits", () => {
    const project = createProject("Users", { dialect: "sqlite" });
    const preview = buildEmbedPreview({
      ...project,
      name: `  ${"n".repeat(EMBED_PREVIEW_LIMITS.titleLength + 30)}  `,
      description: "d".repeat(EMBED_PREVIEW_LIMITS.descriptionLength + 30),
    });

    expect(preview.title).toHaveLength(EMBED_PREVIEW_LIMITS.titleLength);
    expect(preview.title.endsWith("n…")).toBe(true);
    expect(preview.description).toHaveLength(EMBED_PREVIEW_LIMITS.descriptionLength);
    expect(preview.description?.endsWith("d…")).toBe(true);
  });
});
