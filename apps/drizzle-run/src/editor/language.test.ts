import { describe, expect, it } from "vitest";

import { getEditorLanguage } from "./language";

describe("getEditorLanguage", () => {
  it("should select JSON mode for project metadata and data files", () => {
    expect(getEditorLanguage("meta/_journal.json")).toBe("json");
  });

  it("should select SQL mode for project-owned migration files", () => {
    expect(getEditorLanguage("migrations/0001_init.sql")).toBe("sql");
  });

  it("should select JavaScript mode for JavaScript entrypoint extensions", () => {
    expect(getEditorLanguage("query.js")).toBe("javascript");
    expect(getEditorLanguage("seed.mjs")).toBe("javascript");
    expect(getEditorLanguage("component.jsx")).toBe("javascript");
  });

  it("should keep TypeScript mode for TypeScript and unknown extensions", () => {
    expect(getEditorLanguage("schema.ts")).toBe("typescript");
    expect(getEditorLanguage("component.tsx")).toBe("typescript");
    expect(getEditorLanguage("migration.mts")).toBe("typescript");
    expect(getEditorLanguage("source")).toBe("typescript");
  });
});
