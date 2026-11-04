import { describe, expect, it } from "vitest";

import { findExample, listExamples } from "./catalog";
import { filterExamples, hasGalleryFilters, readGalleryFilters } from "./gallery-filters";

function search(query: string) {
  return filterExamples({
    examples: listExamples(),
    filters: readGalleryFilters(new URLSearchParams(query)),
    progress: {},
    views: {},
  });
}

describe("gallery filters", () => {
  it("should combine comparisons, kind, database and search", () => {
    expect(search("topic=Comparisons&kind=guided&db=postgresql&q=typed+helpers").map(({ slug }) => slug)).toEqual([
      "helper-apis-postgresql",
    ]);
  });

  it("should find the same entry through each of its topics", () => {
    for (const topic of ["Queries", "Helpers", "JSON", "RQB"]) {
      expect(search(`topic=${topic}`).map(({ slug }) => slug)).toContain("helper-apis-sqlite");
    }
  });

  it("should match case-insensitive words across titles, descriptions and topics", () => {
    expect(search("q=+JSON++RQB+").map(({ slug }) => slug)).toContain("helper-apis-postgresql");
    expect(search("q=composite+shifting").map(({ slug }) => slug)).toContain("pagination-apis-postgresql");
    expect(search("q=missingwordthatdoesnotexist")).toEqual([]);
    expect(search("q=all")).toEqual(
      listExamples().filter((example) =>
        [example.title, example.description, ...example.topics].join(" ").toLowerCase().includes("all"),
      ),
    );
  });

  it("should ignore unknown URL filters and blank searches", () => {
    const filters = readGalleryFilters(
      new URLSearchParams("q=++&topic=wrong&db=wrong&kind=wrong&layout=wrong&progress=wrong"),
    );

    expect(hasGalleryFilters(filters)).toBe(false);
    expect(search("topic=wrong&db=wrong&layout=wrong")).toEqual(listExamples());
  });

  it("should derive Comparisons from two-sided examples and guides", () => {
    const comparisons = search("topic=Comparisons").map(({ slug }) => slug);

    expect(comparisons).toContain("postgresql-vs-sqlite");
    expect(comparisons).toContain("helper-apis-postgresql");
    expect(comparisons).toContain("relational-queries");
    expect(comparisons).not.toContain("quick-start-postgresql");
    expect(search("topic=Comparisons&db=sqlite").map(({ slug }) => slug)).toContain("postgresql-vs-sqlite");
  });

  it("should match any selected topic while retaining other filters", () => {
    const matches = search("topic=Helpers&topic=Validation&db=postgresql").map(({ slug }) => slug);

    expect(matches).toContain("reusable-helpers");
    expect(matches).toContain("insert-validators");
    expect(matches).not.toContain("reusable-helpers-sqlite");
  });

  it("should derive progress without turning a revisit into an unfinished guide", () => {
    const example = findExample("helper-apis-postgresql")!;
    const progress = {
      [example.slug]: { guideId: example.guide!.id, stepId: "01-profiles", completed: [], finished: true },
    };
    const views = { [example.slug]: "2026-11-04T10:00:00Z" };
    const filter = (state: string) =>
      filterExamples({
        examples: [example],
        progress,
        views,
        filters: readGalleryFilters(new URLSearchParams(`progress=${state}`)),
      });

    expect(filter("completed")).toEqual([example]);
    expect(filter("viewed")).toEqual([]);
    expect(filter("not_viewed")).toEqual([]);
  });
});
