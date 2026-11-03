import { describe, expect, it } from "vitest";

import { getQueryHint } from "./query-hints";

describe("getQueryHint", () => {
  it("should point a missing table at schema.ts in both engines' words", () => {
    const postgres = getQueryHint('relation "accounts" does not exist', "postgresql");
    const sqlite = getQueryHint("SQLITE_ERROR: no such table: accounts", "sqlite");

    expect(postgres).toEqual({
      lead: "The table wasn't created for this run. Check that",
      file: "schema",
      tail: "exports it.",
    });
    expect(sqlite).toBe(postgres);
  });

  it("should read each engine's own messages only", () => {
    expect(getQueryHint('column "nope" does not exist', "postgresql")?.file).toBe("schema");
    expect(getQueryHint("UNIQUE constraint failed: users.email", "sqlite")?.file).toBeUndefined();
    expect(getQueryHint("no such table: accounts", "postgresql")).toBeUndefined();
  });

  it("should leave an unknown error or an unknown dialect without a hint", () => {
    expect(getQueryHint("canceling statement due to user request", "postgresql")).toBeUndefined();
    expect(getQueryHint('relation "accounts" does not exist', undefined)).toBeUndefined();
  });
});
