import type { RunManifestTarget } from "@drizzle-run/core/manifest";

import { listProjectDialects } from "../project/projects";
import { listExamples, type ExampleSectionId, type OfficialExample } from "./catalog";

/** The database a gallery reader works with; the gallery opens each example on it when it can. */
export type GalleryDialect = RunManifestTarget["dialect"];

/** The databases a reader can pick in the gallery, in the order its toggle lists them. */
export const GALLERY_DIALECTS = [
  { value: "postgresql", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
] as const satisfies readonly { value: GalleryDialect; label: string }[];

/**
 * One pattern of the gallery: a single example, or the same example written once per database
 *
 * `versions` holds one example per database it runs on, PostgreSQL first.
 */
export interface ExampleFamily {
  /** The slug without its database suffix, shared by every version. */
  key: string;
  section: ExampleSectionId;
  versions: readonly OfficialExample[];
}

const DIALECT_SUFFIX = /-(postgresql|sqlite)$/;
const TITLE_DIALECT = / \((?:PostgreSQL|SQLite)\)$| with (?:PostgreSQL|SQLite)$|^(?:PostgreSQL|SQLite) /;

/** Each database an example runs, its sides included. */
function getDialects(example: OfficialExample): GalleryDialect[] {
  return listProjectDialects(example.manifest);
}

/**
 * Group examples written once per database into one family each
 *
 * Two examples form a family when their slugs only differ by a `-postgresql` or `-sqlite` suffix, such as
 * `pagination-postgresql` and `pagination-sqlite`, or `reusable-helpers` and `reusable-helpers-sqlite`. Each must run
 * on one database, a different one, and sit in the same section. Every other example is a family of its own. Families
 * keep the order of their first example.
 *
 * Throws when two examples share a family key but cannot be one family.
 */
export function groupExampleFamilies(examples: readonly OfficialExample[]): ExampleFamily[] {
  const byKey = new Map<string, OfficialExample[]>();

  for (const example of examples) {
    const key = example.slug.replace(DIALECT_SUFFIX, "");
    byKey.set(key, [...(byKey.get(key) ?? []), example]);
  }

  const families: ExampleFamily[] = [];
  const placed = new Set<string>();

  for (const example of examples) {
    const key = example.slug.replace(DIALECT_SUFFIX, "");
    const members = byKey.get(key) ?? [];

    if (members.length < 2) {
      families.push({ key: example.slug, section: example.section, versions: [example] });
      continue;
    }

    if (placed.has(key)) {
      continue;
    }

    const dialects = members.map(getDialects);

    if (
      members.length !== 2 ||
      dialects.some((list) => list.length !== 1) ||
      dialects[0][0] === dialects[1][0] ||
      members[0].section !== members[1].section
    ) {
      throw new Error(
        `Examples ${members.map(({ slug }) => `"${slug}"`).join(" and ")} share the family "${key}", so they must be one PostgreSQL and one SQLite example in the same section.`,
      );
    }

    placed.add(key);
    families.push({
      key,
      section: example.section,
      versions: members.toSorted(
        (left, right) => Number(getDialects(left)[0] !== "postgresql") - Number(getDialects(right)[0] !== "postgresql"),
      ),
    });
  }

  return families;
}

let shownFamilies: readonly ExampleFamily[] | undefined;

/** The shown examples grouped into families, in gallery order. */
export function listExampleFamilies(): readonly ExampleFamily[] {
  shownFamilies ??= groupExampleFamilies(listExamples());

  return shownFamilies;
}

/** The family whose key, or one of whose versions' slug, is `slug`. */
export function findExampleFamily(
  slug: string,
  families: readonly ExampleFamily[] = listExampleFamilies(),
): ExampleFamily | undefined {
  return families.find((family) => family.key === slug || family.versions.some((version) => version.slug === slug));
}

/** The version the gallery opens for a reader on `dialect`: the one running it, else the only one. */
export function pickFamilyVersion(family: ExampleFamily, dialect: GalleryDialect): OfficialExample {
  return family.versions.find((version) => getDialects(version).includes(dialect)) ?? family.versions[0];
}

/** Whether some version of the family runs on `dialect`, a side of a side-by-side example included. */
export function familyRuns(family: ExampleFamily, dialect: GalleryDialect): boolean {
  return family.versions.some((version) => getDialects(version).includes(dialect));
}

/** The family's title: its version's title without the database it names, when the family has another version. */
export function getFamilyTitle(family: ExampleFamily, version: OfficialExample): string {
  if (family.versions.length < 2) {
    return version.title;
  }

  const title = version.title.replace(TITLE_DIALECT, "");

  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The database a version runs on, as the gallery names it; both, for a version comparing them. */
export function getVersionDialectLabel(version: OfficialExample): string {
  return getDialects(version)
    .map((dialect) => GALLERY_DIALECTS.find(({ value }) => value === dialect)?.label ?? dialect)
    .join(" + ");
}
