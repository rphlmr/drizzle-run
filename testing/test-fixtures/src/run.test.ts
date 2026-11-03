import { describe, expect, it } from "vitest";

import { fakeRunResult, fixtureTuple, projectManifest } from "./run";

describe("fixtureTuple", () => {
  it("should isolate mutable targets from the catalog and other fixtures", () => {
    const tuple = fixtureTuple({ dialect: "postgresql" }, "legacy");
    const originalDialect = tuple.target.dialect;

    try {
      tuple.target.dialect = "sqlite";

      expect(projectManifest().target.dialect).toBe("postgresql");
      expect(fixtureTuple({ dialect: "postgresql" }, "legacy").target.dialect).toBe("postgresql");
    } finally {
      tuple.target.dialect = originalDialect;
    }
  });
});

describe("projectManifest", () => {
  it("should pin the Legacy pair on PostgreSQL by default", () => {
    const legacy = fixtureTuple({ dialect: "postgresql" }, "legacy");

    expect(projectManifest()).toMatchObject({
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": legacy.ormVersion, "drizzle-kit": legacy.kitVersion },
    });
  });

  it("should pin the Next pair of the dialect when releaseLine picks it", () => {
    const next = fixtureTuple({ dialect: "sqlite" }, "next");

    expect(projectManifest("sqlite", { releaseLine: "next" })).toMatchObject({
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion },
    });
  });
});

describe("projectManifest seed", () => {
  it("should have no seed by default", () => {
    const manifest = projectManifest();

    expect(manifest.entrypoints).toEqual({ schema: "schema.ts", run: "query.ts" });
    expect(manifest.files).not.toHaveProperty("seed.ts");
  });

  it("should add seed.ts and its entrypoint when seed is on", () => {
    const manifest = projectManifest("postgresql", { seed: true });

    expect(manifest.entrypoints).toEqual({ schema: "schema.ts", seed: "seed.ts", run: "query.ts" });
    expect(manifest.files).toHaveProperty("seed.ts");
  });
});

describe("fakeRunResult", () => {
  it("should retain supplied displays as ordered events", () => {
    const displays = [
      { label: "First", values: [] },
      { label: "Second", values: [] },
    ];

    const result = fakeRunResult("succeeded", { displays });

    expect(result.events).toEqual([
      { type: "display", sequence: 1, payload: displays[0] },
      { type: "display", sequence: 2, payload: displays[1] },
    ]);
  });
  it("should describe a succeeded PostgreSQL run on the Legacy pair by default", () => {
    const result = fakeRunResult("succeeded");

    expect(result).toMatchObject({ ok: true, outcome: "succeeded", target: { dialect: "postgresql" }, displays: [] });
    expect(result.tuple.id).toBe(fixtureTuple({ dialect: "postgresql" }, "legacy").id);
  });

  it("should run on the target and release line it is given", () => {
    const target = { dialect: "sqlite" } as const;
    const next = fixtureTuple(target, "next");
    const result = fakeRunResult("succeeded", { target, releaseLine: "next" });

    expect(result.target).toEqual(target);
    expect(result.tuple).toEqual({ id: next.id, target, ormVersion: next.ormVersion, kitVersion: next.kitVersion });
  });

  it("should give a failed run the message and displays it is given", () => {
    const displays = [{ label: "Users", values: [] }];
    const result = fakeRunResult("failed", { displays, message: "boom" });

    expect(result).toMatchObject({ ok: false, outcome: "failed", displays, error: { phase: "run", message: "boom" } });
  });

  it("should give a failed run a default message when none is given", () => {
    expect(fakeRunResult("failed")).toMatchObject({
      error: { name: "Error", phase: "run", message: "The run failed." },
    });
  });

  it("should describe a cancelled run without an error", () => {
    const result = fakeRunResult("cancelled");

    expect(result).toMatchObject({ ok: false, outcome: "cancelled" });
    expect(result).not.toHaveProperty("error");
  });
});
