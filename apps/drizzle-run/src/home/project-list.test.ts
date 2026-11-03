import { listSupportedTuples } from "@drizzle-run/core/catalog";
import { describe, expect, it } from "vitest";

import { createProject, listProjectDialects, type ProjectRecord } from "../project/projects";
import {
  DEFAULT_LIST_QUERY,
  formatEditedLabel,
  getProjectBytes,
  getProjectReleaseLines,
  toProjectShares,
  listProjects,
  PAGE_SIZE,
  readListQuery,
  writeListQuery,
} from "./project-list";

const baseTimeMs = Date.UTC(2026, 9, 13, 12);

function makeProjects(count: number): ProjectRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const project = createProject(`Project ${index + 1}`, { dialect: index % 3 === 0 ? "sqlite" : "postgresql" });
    const updatedAt = new Date(baseTimeMs - index * 3_600_000).toISOString();

    return { ...project, updatedAt };
  });
}

describe("listProjects", () => {
  const many = makeProjects(200);

  it("should page 200 projects by 20, newest edit first", () => {
    const first = listProjects(many, DEFAULT_LIST_QUERY);

    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.pageCount).toBe(10);
    expect(first.rows[0].name).toBe("Project 1");
    expect([first.from, first.to, first.matched]).toEqual([1, 20, 200]);

    const last = listProjects(many, { ...DEFAULT_LIST_QUERY, page: 10 });

    expect(last.rows.at(-1)?.name).toBe("Project 200");
    expect([last.from, last.to]).toEqual([181, 200]);
  });

  it("should clamp a page past the end", () => {
    const page = listProjects(many, { ...DEFAULT_LIST_QUERY, page: 99 });

    expect(page.page).toBe(10);
  });

  it("should filter by database and search together", () => {
    const sqlite = listProjects(many, { ...DEFAULT_LIST_QUERY, dialect: "sqlite" });

    expect(sqlite.matched).toBe(67);
    expect(sqlite.rows.every((project) => listProjectDialects(project.manifest).includes("sqlite"))).toBe(true);

    const searched = listProjects(many, { ...DEFAULT_LIST_QUERY, dialect: "sqlite", search: "  project 19 " });

    expect(searched.rows.map((project) => project.name)).toEqual([
      "Project 19",
      "Project 190",
      "Project 193",
      "Project 196",
      "Project 199",
    ]);
  });

  it("should sort by name with numbers in order, and by oldest edit", () => {
    expect(
      listProjects(many, { ...DEFAULT_LIST_QUERY, sort: "name-asc" })
        .rows.slice(0, 3)
        .map((project) => project.name),
    ).toEqual(["Project 1", "Project 2", "Project 3"]);
    expect(listProjects(many, { ...DEFAULT_LIST_QUERY, sort: "edited-asc" }).rows[0].name).toBe("Project 200");
  });

  it("should sort by size, largest first, with the size cloud sync counts", () => {
    const small = createProject("Small", { dialect: "sqlite" });
    const large = { ...createProject("Large", { dialect: "sqlite" }), name: "Large".padEnd(180, "e") };
    const sorted = listProjects([small, large], { ...DEFAULT_LIST_QUERY, sort: "size-desc" });

    expect(sorted.rows.map((project) => project.id)).toEqual([large.id, small.id]);
    expect(getProjectBytes(small)).toBe(new TextEncoder().encode(JSON.stringify(small)).byteLength);
    expect(readListQuery(new URLSearchParams("sort=size-asc")).sort).toBe("size-asc");
  });

  it("should report an empty result", () => {
    const empty = listProjects(many, { ...DEFAULT_LIST_QUERY, search: "nothing" });

    expect([empty.matched, empty.from, empty.to, empty.pageCount]).toEqual([0, 0, 0, 1]);
  });
});

describe("list query in the URL", () => {
  it("should round-trip and leave defaults out", () => {
    const query = { search: "blog", dialect: "postgresql" as const, sort: "name-asc" as const, page: 3 };

    expect(readListQuery(writeListQuery(query))).toEqual(query);
    expect(writeListQuery(DEFAULT_LIST_QUERY).toString()).toBe("");
  });

  it("should fall back on unknown values", () => {
    expect(readListQuery(new URLSearchParams("db=mysql&sort=random&page=-2"))).toEqual(DEFAULT_LIST_QUERY);
  });
});

describe("formatEditedLabel", () => {
  const now = new Date(2026, 9, 13, 15, 0);
  const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds).toISOString();

  it.each([
    [ago(20_000), "Just now"],
    [ago(12 * 60_000), "12 min ago"],
    [ago(2 * 3_600_000), "2 h ago"],
    [new Date(2026, 9, 12, 23, 0).toISOString(), "Yesterday"],
    [new Date(2026, 9, 10, 9, 0).toISOString(), "3 days ago"],
    [new Date(2026, 8, 28, 9, 0).toISOString(), "Sep 28"],
    [new Date(2025, 11, 2, 9, 0).toISOString(), "Dec 2, 2025"],
  ])("should label %s as %s", (iso, label) => {
    expect(formatEditedLabel(iso, now)).toBe(label);
  });
});

describe("getProjectReleaseLines", () => {
  it("should give a one-version project one unnamed line with its exact pair", () => {
    const target = { dialect: "sqlite" } as const;
    const legacy = listSupportedTuples(target).find((tuple) => tuple.ormVersion.startsWith("0."));
    const [line, ...rest] = getProjectReleaseLines(createProject("Legacy", target, legacy?.id));

    expect(rest).toEqual([]);
    expect(line).toMatchObject({ name: undefined, dialect: "sqlite", guestFlavor: "slim" });
    expect(line?.ormVersion).toMatch(/^0\.45\.\d+$/);
    expect(line?.kitVersion).toMatch(/^0\.31\.\d+$/);
  });
});

describe("toProjectShares", () => {
  it("should key each link by its project and read a Community bug repro from the listing this browser keeps", () => {
    const publishedAt = "2026-10-28T10:00:00.000Z";

    expect(
      toProjectShares([
        { projectId: "plain", link: { linkId: "link-1", publishedAt } },
        { projectId: "listed", link: { linkId: "link-2", publishedAt, listing: { topic: "bug-repros" } } },
      ]),
    ).toEqual({
      plain: { linkId: "link-1", visibility: "link_only", bugRepro: false },
      listed: { linkId: "link-2", visibility: "community", bugRepro: true },
    });
  });
});
