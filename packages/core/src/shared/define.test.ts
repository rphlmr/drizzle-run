import { describe, expect, it } from "vitest";

import { assertParsedAsWritten } from "./define.ts";

describe("assertParsedAsWritten", () => {
  it("should blame an older Legacy pin only for a change to a dependency pin", () => {
    const written = { project: { dependencies: { "drizzle-orm": "0.45.1" } } };
    const parsed = { project: { dependencies: { "drizzle-orm": "0.45.4" } } };

    expect(() => assertParsedAsWritten(written, parsed, "guide")).toThrow(
      "at project.dependencies.drizzle-orm, most likely because it pins an older Legacy fix release",
    );
  });

  it("should not blame a Legacy pin for a change under meta, even in a field named dependencies", () => {
    const written = { meta: { dependencies: { lesson: "a" } } };
    const parsed = { meta: { dependencies: { lesson: "b" } } };

    expect(() => assertParsedAsWritten(written, parsed, "guide")).toThrow(
      "at meta.dependencies.lesson, so it runs differently from what is written",
    );
  });
});
