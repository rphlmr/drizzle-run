import { describe, expect, it } from "vitest";

import { EXAMPLE_SECTIONS, findExample, listExamples, type OfficialExample } from "./catalog";
import { EXAMPLE_COLLECTIONS } from "./collections";
import {
  familyRuns,
  findExampleFamily,
  getFamilyTitle,
  groupExampleFamilies,
  listExampleFamilies,
  pickFamilyVersion,
} from "./families";

describe("example families", () => {
  it("should hold every shown example exactly once", () => {
    const slugs = listExampleFamilies().flatMap((family) => family.versions.map(({ slug }) => slug));

    expect(slugs.toSorted()).toEqual(
      listExamples()
        .map(({ slug }) => slug)
        .toSorted(),
    );
  });

  it("should pair the PostgreSQL and SQLite versions of one example, PostgreSQL first", () => {
    const pagination = findExampleFamily("pagination-sqlite")!;

    expect(pagination.key).toBe("pagination");
    expect(pagination.versions.map(({ slug }) => slug)).toEqual(["pagination-postgresql", "pagination-sqlite"]);
    expect(findExampleFamily("reusable-helpers-sqlite")?.versions.map(({ slug }) => slug)).toEqual([
      "reusable-helpers",
      "reusable-helpers-sqlite",
    ]);
    expect(findExampleFamily("postgresql-vs-sqlite")?.versions).toHaveLength(1);
  });

  it("should open the reader's database, else the only version", () => {
    const quickStart = findExampleFamily("quick-start")!;
    const transactions = findExampleFamily("transactions")!;
    const [only] = transactions.versions;

    expect(pickFamilyVersion(quickStart, "sqlite").slug).toBe("quick-start-sqlite");
    expect(pickFamilyVersion(quickStart, "postgresql").slug).toBe("quick-start-postgresql");
    expect(pickFamilyVersion(transactions, "sqlite")).toBe(only);
    expect(familyRuns(findExampleFamily("postgresql-vs-sqlite")!, "sqlite")).toBe(true);
  });

  it("should drop the database from the title of a family with two versions", () => {
    const quickStart = findExampleFamily("quick-start")!;

    expect(quickStart.versions.map((version) => getFamilyTitle(quickStart, version))).toEqual([
      "Quick start",
      "Quick start",
    ]);

    for (const family of listExampleFamilies().filter(({ versions }) => versions.length > 1)) {
      expect(new Set(family.versions.map((version) => getFamilyTitle(family, version))).size, family.key).toBe(1);
      expect(getFamilyTitle(family, family.versions[0]), family.key).not.toMatch(/PostgreSQL|SQLite/);
    }

    const comparison = findExampleFamily("postgresql-vs-sqlite")!;

    expect(getFamilyTitle(comparison, comparison.versions[0])).toBe(comparison.versions[0].title);
  });

  it("should reject two examples of one family that cannot pair", () => {
    const postgresql = findExample("pagination-postgresql")!;
    const twin: OfficialExample = { ...postgresql, slug: "pagination-sqlite" };

    expect(() => groupExampleFamilies([postgresql, twin])).toThrow(/pagination/);
    expect(() =>
      groupExampleFamilies([postgresql, { ...findExample("pagination-sqlite")!, section: "start" }]),
    ).toThrow(/same section/);
  });

  it("should fill every section and name only shown families in collections", () => {
    const families = listExampleFamilies();

    for (const section of EXAMPLE_SECTIONS) {
      expect(
        families.some((family) => family.section === section.id),
        section.id,
      ).toBe(true);
    }

    for (const collection of EXAMPLE_COLLECTIONS) {
      for (const key of collection.families) {
        expect(
          families.some((family) => family.key === key),
          `${collection.id}: ${key}`,
        ).toBe(true);
      }
    }
  });
});
