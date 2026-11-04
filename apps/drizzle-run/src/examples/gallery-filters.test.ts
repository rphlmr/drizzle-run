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
  it("should combine topics, layout, kind, database and search", () => {
    expect(
      search("topic=JSON&layout=side_by_side&kind=guided&db=postgresql&q=typed+helpers").map(({ slug }) => slug),
    ).toEqual(["helper-apis-postgresql"]);
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

  it("should derive layout from the comparison project", () => {
    expect(search("layout=side_by_side").map(({ slug }) => slug)).toContain("postgresql-vs-sqlite");
    expect(search("layout=single").map(({ slug }) => slug)).not.toContain("helper-apis-postgresql");
    expect(search("layout=side_by_side&db=sqlite").map(({ slug }) => slug)).toContain("postgresql-vs-sqlite");
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
