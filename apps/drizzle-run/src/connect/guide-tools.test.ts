import { describe, expect, it } from "vitest";

import { findGuide } from "../guides/catalog";
import { describeGuide } from "./guide-tools";

function describeFiveMinutesStep(index: number) {
  const manifest = findGuide("drizzle-in-five-minutes");

  if (!manifest) {
    throw new Error("Missing guide drizzle-in-five-minutes");
  }

  return describeGuide({ manifest, index, stage: "before" }).step.code_changes;
}

function listChangedFiles(changes: ReturnType<typeof describeFiveMinutesStep>) {
  return changes.map((change) => (change.side === undefined ? change.path : `${change.path} on side ${change.side}`));
}

describe("describeGuide", () => {
  it("should list a shared file once and a per-side file on its side, on a step that splits", () => {
    const changes = describeFiveMinutesStep(3);

    expect(listChangedFiles(changes)).toEqual(["schema.ts", "query.ts on side 0", "query.ts on side 1"]);
  });

  it("should compare a step that merges with the side it keeps", () => {
    const changes = describeFiveMinutesStep(4);

    expect(listChangedFiles(changes)).toEqual(["query.ts"]);
    expect(changes[0]?.lines.join("\n")).not.toContain("findMany");
  });
});
