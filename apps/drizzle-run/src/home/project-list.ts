import { DialectSchema, resolveGuestFlavor, type Dialect } from "@drizzle-run/core/catalog";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { clamp } from "es-toolkit";

import { measureCloudProject } from "../cloud/contract";
import { isSideBySide, listProjectDialects, type ProjectRecord } from "../project/projects";
import type { ProjectShareLink } from "../store/storage";
import type { ReleaseLine } from "../ui/release-lines";

/** The database filter of My projects. */
export type DialectFilter = "all" | Dialect;
/** The sort orders of My projects, as the `sort` search param writes them. */
export type ProjectSort = "edited-desc" | "edited-asc" | "name-asc" | "name-desc" | "size-desc" | "size-asc";

/** Projects per page of My projects. */
export const PAGE_SIZE = 20;

/** What My projects shows, as its search params hold it; `page` is 1-based. */
export interface ProjectListQuery {
  search: string;
  dialect: DialectFilter;
  sort: ProjectSort;
  page: number;
}

/** The query of a bare `/projects` URL. */
export const DEFAULT_LIST_QUERY: ProjectListQuery = { search: "", dialect: "all", sort: "edited-desc", page: 1 };

const SORTS: readonly ProjectSort[] = ["edited-desc", "edited-asc", "name-asc", "name-desc", "size-desc", "size-asc"];

/** Reads `q`, `db`, `sort`, and `page`; anything unknown falls back to the default. */
export function readListQuery(params: URLSearchParams): ProjectListQuery {
  const dialect = DialectSchema.safeParse(params.get("db"));
  const sort = SORTS.find((item) => item === params.get("sort"));
  const page = Number.parseInt(params.get("page") ?? "", 10);

  return {
    search: params.get("q") ?? "",
    dialect: dialect.success ? dialect.data : "all",
    sort: sort ?? DEFAULT_LIST_QUERY.sort,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** Writes a query back to search params, leaving defaults out so the page URL stays `/projects`. */
export function writeListQuery(query: ProjectListQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.search !== "") {
    params.set("q", query.search);
  }

  if (query.dialect !== "all") {
    params.set("db", query.dialect);
  }

  if (query.sort !== DEFAULT_LIST_QUERY.sort) {
    params.set("sort", query.sort);
  }

  if (query.page !== 1) {
    params.set("page", String(query.page));
  }

  return params;
}

/** One page of My projects, with the counts its footer shows. */
export interface ProjectListPage {
  rows: ProjectRecord[];
  /** Projects matching the search and filter, across every page. */
  matched: number;
  page: number;
  pageCount: number;
  /** 1-based position of the first and last row shown, 0 when nothing matches. */
  from: number;
  to: number;
}

// Records never change in place: an edit makes a new one, so a size measured once stays right.
const projectBytes = new WeakMap<ProjectRecord, number>();

/** The project's size as cloud sync counts it: its record as JSON, in bytes. */
export function getProjectBytes(project: ProjectRecord): number {
  const known = projectBytes.get(project);

  if (known !== undefined) {
    return known;
  }

  const bytes = measureCloudProject(project);
  projectBytes.set(project, bytes);

  return bytes;
}

const sortComparators: Record<ProjectSort, (left: ProjectRecord, right: ProjectRecord) => number> = {
  "edited-desc": (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name),
  "edited-asc": (left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.name.localeCompare(right.name),
  "name-asc": (left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }),
  "name-desc": (left, right) => right.name.localeCompare(left.name, undefined, { sensitivity: "base", numeric: true }),
  "size-desc": (left, right) => getProjectBytes(right) - getProjectBytes(left) || left.name.localeCompare(right.name),
  "size-asc": (left, right) => getProjectBytes(left) - getProjectBytes(right) || left.name.localeCompare(right.name),
};

/** Filters, sorts and pages the projects; a page past the end shows the last page. */
export function listProjects(projects: readonly ProjectRecord[], query: ProjectListQuery): ProjectListPage {
  const searchText = query.search.trim().toLocaleLowerCase();
  const matching = projects
    .filter((project) => query.dialect === "all" || listProjectDialects(project.manifest).includes(query.dialect))
    .filter((project) => searchText === "" || project.name.toLocaleLowerCase().includes(searchText))
    .toSorted(sortComparators[query.sort]);
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = clamp(query.page, 1, pageCount);
  const start = (page - 1) * PAGE_SIZE;
  const rows = matching.slice(start, start + PAGE_SIZE);

  return {
    rows,
    matched: matching.length,
    page,
    pageCount,
    from: rows.length === 0 ? 0 : start + 1,
    to: start + rows.length,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Just now", "12 min ago", "2 h ago", "Yesterday", "3 days ago", then a date. */
export function formatEditedLabel(iso: string, now: Date = new Date()): string {
  const edited = new Date(iso);
  const elapsedMs = now.getTime() - edited.getTime();

  if (!Number.isFinite(elapsedMs)) {
    return "";
  }

  if (elapsedMs < MINUTE_MS) {
    return "Just now";
  }

  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)} min ago`;
  }

  const days = Math.round((startOfDay(now) - startOfDay(edited)) / DAY_MS);

  if (days === 0) {
    return `${Math.floor(elapsedMs / HOUR_MS)} h ago`;
  }

  if (days === 1) {
    return "Yesterday";
  }

  if (days < 7) {
    return `${days} days ago`;
  }

  return edited.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(edited.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Each side's database, exact pair and Effect flavor, as My projects lists them
 *
 * A one-version project has one line; a side-by-side project has one per side, named only when its author named it.
 */
export function getProjectReleaseLines(project: ProjectRecord): ReleaseLine[] {
  if (isSideBySide(project)) {
    return project.manifest.sides.map((side) => toReleaseLine(side, side.name));
  }

  return [toReleaseLine(project.manifest, undefined)];
}

function toReleaseLine(
  side: Pick<RunManifest, "target" | "dependencies" | "guestFlavor">,
  name: string | undefined,
): ReleaseLine {
  return {
    name,
    dialect: side.target.dialect,
    ormVersion: side.dependencies["drizzle-orm"],
    kitVersion: side.dependencies["drizzle-kit"],
    guestFlavor: resolveGuestFlavor(side),
  };
}

/** A project's share link in this browser, as My projects shows it. */
export interface ProjectShare {
  linkId: string;
  /** Listed while this browser keeps the link in Community; Community may have removed it since. */
  visibility: "link_only" | "community";
  bugRepro: boolean;
}

/** Each project's share link in this browser, by project id. */
export function toProjectShares(links: readonly ProjectShareLink[]): Record<string, ProjectShare> {
  return Object.fromEntries(
    links.map(({ projectId, link }) => [
      projectId,
      {
        linkId: link.linkId,
        visibility: link.listing === undefined ? "link_only" : "community",
        bugRepro: link.listing?.topic === "bug-repros",
      },
    ]),
  );
}
