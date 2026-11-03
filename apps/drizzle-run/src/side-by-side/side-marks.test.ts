import type { GuideManifest } from "@drizzle-run/core/guide";
import { describe, expect, it } from "vitest";

import { findGuide } from "../guides/catalog";
import { getSideMark } from "./side-marks";

function getRelationalQueriesGuide(): GuideManifest {
  const guide = findGuide("relational-queries");

  if (!guide) {
    throw new Error("Missing guide relational-queries");
  }

  return guide;
}

function withFirstStepFocus(guide: GuideManifest, focus: NonNullable<GuideManifest["steps"][number]["focus"]>) {
  return { ...guide, steps: guide.steps.map((step, index) => (index === 0 ? { ...step, focus } : step)) };
}

describe("getSideMark", () => {
  it("should mark the focus lines only on the side whose own copy the focus names", () => {
    const guide = withFirstStepFocus(getRelationalQueriesGuide(), { file: "schema.ts", side: 1, lines: [22, 36] });
    const [step] = guide.steps;

    expect(getSideMark(guide, 0, step, 0)).toEqual({ file: "schema.ts" });
    expect(getSideMark(guide, 0, step, 1)).toEqual({ file: "schema.ts", lines: [22, 36] });
  });

  it("should mark the focus lines on both sides when the focus names a shared file", () => {
    const guide = withFirstStepFocus(getRelationalQueriesGuide(), { file: "seed.ts", side: 1, lines: [1, 3] });
    const [step] = guide.steps;

    expect(getSideMark(guide, 0, step, 0)).toEqual({ file: "seed.ts", lines: [1, 3] });
    expect(getSideMark(guide, 0, step, 1)).toEqual({ file: "seed.ts", lines: [1, 3] });
  });
});
