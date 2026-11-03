import { describe, expect, it } from "vitest";
import * as z from "zod/mini";

import { checkVersions, pickShown, SlugSchema, type CatalogVersion } from "./versions";

function makeVersion(options: Partial<CatalogVersion> = {}): CatalogVersion {
  return {
    id: options.id ?? "00000000-0000-4000-8000-000000000001",
    slug: options.slug ?? "transactions",
    status: options.status ?? "published",
  };
}

const published = makeVersion();
const draft = makeVersion({ id: "00000000-0000-4000-8000-000000000002", status: "draft" });
const deleted = makeVersion({ id: "00000000-0000-4000-8000-000000000003", status: "deleted" });
const other = makeVersion({ id: "00000000-0000-4000-8000-000000000004", slug: "relations" });

describe("checkVersions", () => {
  it("should accept one published and one draft version per slug, with any number deleted", () => {
    const olderDeleted = makeVersion({ id: "00000000-0000-4000-8000-000000000005", status: "deleted" });

    expect(() => checkVersions("example", [published, draft, deleted, olderDeleted, other])).not.toThrow();
  });

  it("should refuse two versions with one id, deleted ones included", () => {
    expect(() => checkVersions("example", [published, { ...deleted, id: published.id }])).toThrow(
      'Expected each example version to have its own id, but "00000000-0000-4000-8000-000000000001" is used twice.',
    );
  });

  it("should refuse two published or two draft versions of one slug", () => {
    const secondPublished = makeVersion({ id: "00000000-0000-4000-8000-000000000006" });
    const secondDraft = { ...draft, id: "00000000-0000-4000-8000-000000000007" };

    expect(() => checkVersions("guide", [published, secondPublished])).toThrow(
      'Expected one published version of the guide "transactions", but there are more.',
    );
    expect(() => checkVersions("guide", [draft, secondDraft])).toThrow(/one draft version/);
  });
});

describe("pickShown", () => {
  it("should show the published version of each slug, in input order", () => {
    expect(pickShown([other, deleted, draft, published], false)).toEqual([other, published]);
  });

  it("should show the draft in place of the published version when drafts show", () => {
    expect(pickShown([published, draft, other], true)).toEqual([draft, other]);
  });

  it("should show a slug with only a draft in development only, and a deleted one never", () => {
    expect(pickShown([draft], false)).toEqual([]);
    expect(pickShown([draft], true)).toEqual([draft]);
    expect(pickShown([deleted], true)).toEqual([]);
  });
});

describe("SlugSchema", () => {
  it("should take the characters a URL path segment keeps as they are", () => {
    expect(z.safeParse(SlugSchema, "quick-start_v2.1~beta").success).toBe(true);
  });

  it.each(["", ".", "..", "two words", "a/b", "café"])("should refuse %j", (slug) => {
    expect(z.safeParse(SlugSchema, slug).success).toBe(false);
  });
});
