import { describe, expect, it } from "vitest";

import { findExample, listExampleVersions, type OfficialExample } from "../examples/catalog";
import { findGuide, listGuideVersions } from "../guides/catalog";
import { resolveProjectDocs, type DocsCatalog } from "./project-docs";

const OLDER_ID = "00000000-0000-4000-8000-0000000000a1";

function getExample(slug: string): OfficialExample {
  const example = findExample(slug);

  if (!example) {
    throw new Error(`Missing example ${slug}`);
  }

  return example;
}

function getGuideId(slug: string): string {
  const guide = findGuide(slug);

  if (!guide) {
    throw new Error(`Missing guide ${slug}`);
  }

  return guide.id;
}

/**
 * The catalog with an older, deleted version of the plain filters-and-joins example
 *
 * @param shown - Whether a version of the slug still shows, or the slug was removed.
 */
function makeCatalogWithOlderVersion({ shown }: { shown: boolean }): DocsCatalog {
  const current = getExample("filters-and-joins");
  const older: OfficialExample = {
    ...current,
    id: OLDER_ID,
    folder: "filters-and-joins-1",
    status: "deleted",
    links: [{ kind: "docs", label: "Select", url: "https://orm.drizzle.team/docs/select" }],
  };
  const others = listExampleVersions().filter((example) => shown || example.slug !== current.slug);

  return { examples: [...others, older], guides: listGuideVersions(), drafts: false };
}

describe("resolveProjectDocs", () => {
  it("should list a guided example's links, then each step's, each link once", () => {
    const docs = resolveProjectDocs({ kind: "guide", id: getGuideId("drizzle-in-five-minutes") });
    const hrefs = docs?.groups.flatMap((group) => group.links.map((link) => link.href)) ?? [];

    expect(docs).toMatchObject({
      from: "guide",
      title: "Drizzle in five minutes",
      page: { status: "same", href: "/examples/drizzle-in-five-minutes" },
    });
    expect(docs?.groups[0]).toEqual({
      title: "Example",
      links: [
        { kind: "docs", label: "Schema declaration", href: "https://orm.drizzle.team/docs/sql-schema-declaration" },
      ],
    });
    expect(docs?.groups.map(({ title }) => title)).toEqual([
      "Example",
      "1 · Tables",
      "2 · Insert",
      "3 · Select",
      "4 · Relations",
      "5 · Update",
      "6 · Transaction",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("should tag a step's link to another example, kept in Drizzle Run", () => {
    const docs = resolveProjectDocs({ kind: "guide", id: getGuideId("drizzle-in-five-minutes") });
    const transaction = docs?.groups.find(({ title }) => title === "6 · Transaction");

    expect(transaction?.links).toContainEqual({
      kind: "example",
      label: "Transactions and savepoints",
      href: "/examples/transactions",
    });
  });

  it("should drop the steps whose links the example already lists", () => {
    const docs = resolveProjectDocs({ kind: "guide", id: getGuideId("transactions") });

    expect(docs?.groups.map(({ title }) => title)).toEqual(["Example"]);
    expect(docs?.groups.flatMap(({ links }) => links)).toHaveLength(1);
  });

  it("should keep a first run's step links, with no page to open again", () => {
    const docs = resolveProjectDocs({ kind: "guide", id: getGuideId("first-run") });

    expect(docs?.groups.map(({ title }) => title)).toEqual(["1 · Files", "2 · Run", "3 · Filter"]);
    expect(docs?.page).toEqual({ status: "none" });
  });

  it("should read a plain example's links and open it again", () => {
    const docs = resolveProjectDocs({ kind: "example", id: getExample("filters-and-joins").id });

    expect(docs).toMatchObject({
      from: "example",
      title: getExample("filters-and-joins").title,
      page: { status: "same", href: "/examples/filters-and-joins" },
    });
    expect(docs?.groups.map((group) => group.links.map((link) => link.label))).toEqual([["Filters", "Joins"]]);
  });

  it("should keep a replaced version's links and open the newer version at the same slug", () => {
    const docs = resolveProjectDocs({ kind: "example", id: OLDER_ID }, makeCatalogWithOlderVersion({ shown: true }));

    expect(docs?.groups).toEqual([
      { title: "Example", links: [{ kind: "docs", label: "Select", href: "https://orm.drizzle.team/docs/select" }] },
    ]);
    expect(docs?.page).toEqual({ status: "newer", href: "/examples/filters-and-joins" });
  });

  it("should keep the links once no version of the slug shows", () => {
    const docs = resolveProjectDocs({ kind: "example", id: OLDER_ID }, makeCatalogWithOlderVersion({ shown: false }));

    expect(docs?.groups).toHaveLength(1);
    expect(docs?.page).toEqual({ status: "removed" });
  });

  it("should have no docs without a source, for an unknown version, or for an id of the other kind", () => {
    expect(resolveProjectDocs(undefined)).toBeNull();
    expect(resolveProjectDocs({ kind: "example", id: OLDER_ID })).toBeNull();
    expect(resolveProjectDocs({ kind: "guide", id: getExample("transactions").id })).toBeNull();
  });
});
