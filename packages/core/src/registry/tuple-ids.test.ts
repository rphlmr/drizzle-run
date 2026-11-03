import { describe, expect, it } from "vitest";

import { selectTupleIds, type SelectableTuple } from "./tuple-ids.ts";

function makeTuple({
  kitVersion = "1.0.0-rc.5",
  dialect = "postgresql",
}: {
  kitVersion?: string;
  dialect?: "postgresql" | "sqlite";
}): SelectableTuple<string> {
  const targetId = dialect === "postgresql" ? "postgresql-pglite" : "sqlite-wasm";

  return { id: `${targetId}__orm-${kitVersion}__kit-${kitVersion}`, kitVersion, target: { dialect } };
}

describe("selectTupleIds", () => {
  const tuples = [
    makeTuple({ kitVersion: "1.0.0-rc.5" }),
    makeTuple({ kitVersion: "1.0.0" }),
    makeTuple({ kitVersion: "1.0.0", dialect: "sqlite" }),
  ];

  it("should select a Kit version exactly, never a version it is a prefix of", () => {
    expect(selectTupleIds(tuples, { kitVersion: "1.0.0" })).toEqual([
      "postgresql-pglite__orm-1.0.0__kit-1.0.0",
      "sqlite-wasm__orm-1.0.0__kit-1.0.0",
    ]);
    expect(selectTupleIds(tuples, { kitVersion: "1.0.0-rc.5" })).toEqual([
      "postgresql-pglite__orm-1.0.0-rc.5__kit-1.0.0-rc.5",
    ]);
  });

  it("should select a database target by its id", () => {
    expect(selectTupleIds(tuples, { targetId: "sqlite-wasm" })).toEqual(["sqlite-wasm__orm-1.0.0__kit-1.0.0"]);
    expect(selectTupleIds(tuples, { kitVersion: "1.0.0", targetId: "postgresql-pglite" })).toEqual([
      "postgresql-pglite__orm-1.0.0__kit-1.0.0",
    ]);
  });

  it("should select every tuple without a filter", () => {
    expect(selectTupleIds(tuples, {})).toHaveLength(3);
  });
});
