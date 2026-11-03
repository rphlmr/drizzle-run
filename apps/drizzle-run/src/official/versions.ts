import { OfficialVersionIdSchema } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

/**
 * Versions of official examples and guides
 *
 * A slug is permanent: it names the example or guide in every address and embed. Each version under a slug has its
 * own id, so a project forked from one keeps pointing at what it copied after a new version replaces it.
 */

/** Where a version stands: shown, shown in development builds only, or kept so the projects forked from it resolve. */
export const CATALOG_STATUSES = ["published", "draft", "deleted"] as const;

/** The status of one version. */
export const CatalogStatusSchema = z.enum(CATALOG_STATUSES);

/** The status of one version. */
export type CatalogStatus = z.output<typeof CatalogStatusSchema>;

/** What every version carries, whatever it is a version of. */
export interface CatalogVersion {
  /** A lowercase UUID, unique across every version, deleted ones included; never reused. */
  id: string;
  /** Permanent and URL-safe, such as `transactions`; at most one published and one draft version share it. */
  slug: string;
  status: CatalogStatus;
}

/** What a slug may hold, for messages. */
export const SLUG_FORMAT = "letters, digits, -, _, . or ~, so it works in a URL";

/**
 * A slug
 *
 * The characters RFC 3986 leaves unreserved, so it sits in a URL path segment without encoding, and not `.` or `..`,
 * which a URL path resolves away.
 */
export const SlugSchema = z.string().check(
  z.regex(/^[\w.~-]+$/),
  z.refine((value) => value !== "." && value !== ".."),
);

/** A version id: a lowercase UUID, the id a forked project's source names. */
export const VersionIdSchema = OfficialVersionIdSchema;

/** Whether drafts show: in development builds only. */
export const SHOWS_DRAFTS: boolean = import.meta.env?.DEV ?? false;

/**
 * Check the versions of one kind
 *
 * Ids are unique, deleted versions included, and each slug has at most one published and one draft version. Throws
 * naming the first broken rule.
 *
 * @param kind - What the versions are, for the message: "example" or "guide".
 */
export function checkVersions(kind: string, versions: readonly CatalogVersion[]): void {
  const ids = new Set<string>();
  const liveVersions = new Set<string>();

  for (const version of versions) {
    if (ids.has(version.id)) {
      throw new Error(`Expected each ${kind} version to have its own id, but "${version.id}" is used twice.`);
    }

    ids.add(version.id);

    if (version.status === "deleted") {
      continue;
    }

    const key = `${version.status}:${version.slug}`;

    if (liveVersions.has(key)) {
      throw new Error(`Expected one ${version.status} version of the ${kind} "${version.slug}", but there are more.`);
    }

    liveVersions.add(key);
  }
}

/**
 * Pick the versions shown, one per slug
 *
 * The published version, or with `drafts` the draft that will replace it. Deleted versions never show, and a slug
 * with only a draft shows nothing without `drafts`. Keeps the input order.
 */
export function pickShown<Version extends CatalogVersion>(
  versions: readonly Version[],
  drafts: boolean = SHOWS_DRAFTS,
): Version[] {
  const shown = new Map<string, Version>();

  for (const version of versions) {
    if (version.status === "published" && !shown.has(version.slug)) {
      shown.set(version.slug, version);
    }

    if (version.status === "draft" && drafts) {
      shown.set(version.slug, version);
    }
  }

  return versions.filter((version) => shown.get(version.slug) === version);
}
