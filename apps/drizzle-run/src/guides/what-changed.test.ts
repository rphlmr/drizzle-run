import { serializeValue } from "@drizzle-run/core/contracts";
import { diffRunResults } from "@drizzle-run/core/guide";
import { describe, expect, it } from "vitest";

import { findGuide } from "./catalog";
import { describeChanges, describeComparedRun, formatValueText, listFieldChanges } from "./what-changed";

function makeRun(displays: Record<string, unknown>) {
  return {
    displays: Object.entries(displays).map(([label, rows]) => ({ label, values: [serializeValue(rows)] })),
  };
}

const step1 = makeRun({
  Balances: [
    { id: 1, name: "Ada", balance: 70 },
    { id: 2, name: "Grace", balance: 80 },
  ],
});
const step2 = makeRun({
  Balances: [
    { id: 1, name: "Ada", balance: 70 },
    { id: 2, name: "Grace", balance: 0 },
  ],
  Log: ["sent"],
});

describe("what changed", () => {
  it("should describe each display against the run it compares with", () => {
    expect(describeChanges(diffRunResults(step1, step2), "step 1")).toBe(
      "Balances: 1 row changed, 1 unchanged. Log is new.",
    );
    expect(describeChanges(diffRunResults(step2, step1), "step 2")).toBe(
      "Balances: 1 row changed, 1 unchanged. Log: removed since step 2.",
    );
  });

  it("should say when nothing changed", () => {
    expect(describeChanges(diffRunResults(step1, step1), "the last run")).toBe("No changes since the last run.");
  });

  it("should list each changed cell of rows matched by id", () => {
    expect(listFieldChanges(diffRunResults(step1, step2))).toEqual([
      { label: "Balances", row: "2", field: "balance", before: "80", after: "0" },
    ]);
  });

  it("should write cell values as short text", () => {
    expect([null, 3, "Ada", [1, 2], { a: 1 }].map((value) => formatValueText(serializeValue(value)))).toEqual([
      "null",
      "3",
      "Ada",
      "[2]",
      "{…}",
    ]);
    expect(formatValueText(undefined)).toBe("undefined");
  });
});

describe("describeComparedRun", () => {
  const guide = findGuide("drizzle-in-five-minutes");

  if (!guide) {
    throw new Error("Missing guide drizzle-in-five-minutes");
  }

  it("should name the last run when it ran at the same step", () => {
    expect(describeComparedRun(guide, { step: 2 }, 2)).toBe("the last run");
  });

  it("should name the step the compared run ran at, and the side a merge kept", () => {
    expect(describeComparedRun(guide, { step: 1 }, 2)).toBe("step 2");
    expect(describeComparedRun(guide, { step: 3, side: 0 }, 4)).toBe("step 4 (SQL-like)");
  });
});
