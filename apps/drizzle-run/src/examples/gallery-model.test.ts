import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { describe, expect, it } from "vitest";

import { findExample } from "./catalog";
import { findExampleFamily, listExampleFamilies } from "./families";
import { getExampleCallToAction, getResumeStep, listPickUp, searchGallery } from "./gallery-model";

const guided = findExample("drizzle-in-five-minutes")!;
const guide = guided.guide!;

function progressAt(step: number, completed: number, finished = false): GuideProgress {
  return {
    guideId: guide.id,
    stepId: guide.steps[step].id,
    completed: guide.steps.slice(0, completed).map(({ id }) => id),
    finished,
  };
}

describe("resume step and call to action", () => {
  it("should resume a guide at its saved step, else the first one", () => {
    expect(getResumeStep(guided, undefined)).toBe(1);
    expect(getResumeStep(guided, progressAt(3, 3))).toBe(4);
    expect(getResumeStep(findExample("insert-validators")!, undefined)).toBeUndefined();
  });

  it("should say what opening the example does", () => {
    expect(getExampleCallToAction(findExample("insert-validators")!, undefined)).toBe("Open example");
    expect(getExampleCallToAction(guided, undefined)).toBe("Start guide");
    expect(getExampleCallToAction(guided, progressAt(2, 2))).toBe("Continue at step 3");
    expect(getExampleCallToAction(guided, progressAt(6, 7, true))).toBe("Revisit guide");
  });
});

describe("listPickUp", () => {
  const families = listExampleFamilies();

  it("should list opened examples and unfinished guides, newest visit first", () => {
    const entries = listPickUp(families, {
      progress: {
        [guided.slug]: progressAt(2, 2),
        "joins-explained": { ...progressAt(0, 0), guideId: "done", finished: true },
      },
      views: {
        [guided.slug]: "2026-11-02T10:00:00Z",
        "pagination-sqlite": "2026-11-03T10:00:00Z",
        "joins-explained": "2026-11-04T10:00:00Z",
      },
    });

    expect(entries.map(({ version, status }) => [version.slug, status])).toEqual([
      ["pagination-sqlite", "viewed"],
      [guided.slug, "in_progress"],
    ]);
  });

  it("should keep at most the limit", () => {
    const views = Object.fromEntries(
      families.flatMap((family) => family.versions.map(({ slug }) => [slug, "2026-11-01T10:00:00Z"])),
    );

    expect(listPickUp(families, { progress: {}, views })).toHaveLength(3);
  });
});

describe("searchGallery", () => {
  const families = listExampleFamilies();

  it("should match titles by every word, whatever their order", () => {
    const results = searchGallery(families, "pagination cursor", "postgresql");

    expect(results.families.map(({ key }) => key)).toContain("cursor-pagination");
  });

  it("should find an API in code, on the reader's database", () => {
    const results = searchGallery(families, "leftJoin(", "sqlite");

    expect(results.code.length).toBeGreaterThan(0);

    for (const match of results.code) {
      expect(match.line.toLowerCase()).toContain("leftjoin(");
      expect(match.family.versions).toContain(match.version);
    }
  });

  it("should open a matched guide step by its 1-based number", () => {
    const results = searchGallery([findExampleFamily(guided.slug)!], "both changes or neither", "postgresql");

    expect(results.steps).toEqual([expect.objectContaining({ step: 6, title: "Keep both changes or neither" })]);
  });

  it("should find nothing for an API no example uses, or for a blank query", () => {
    expect(searchGallery(families, "onConflictDoNothing", "postgresql")).toEqual({ families: [], steps: [], code: [] });
    expect(searchGallery(families, "   ", "postgresql")).toEqual({ families: [], steps: [], code: [] });
  });
});
