import { DIALECTS, resolveGuestFlavor, type GuestFlavor } from "@drizzle-run/core/catalog";
import {
  PAIR_SEED_PATH,
  pairSideLabels,
  pairSideName,
  type PairManifest,
  type PairSideIndex,
} from "@drizzle-run/core/pair";

import { formatPairText, getReleaseLabel } from "../ui/release-options";

/** What a side shows in its pane head and picker. */
export interface SideRelease {
  side: PairSideIndex;
  /**
   * What the side is called everywhere: its name, or its release, ending in its database, or " (1)" and " (2)", when
   * both sides match
   */
  label: string;
  /** The side's database, as the UI writes it: "PostgreSQL" or "SQLite". */
  database: string;
  /** The author's name for the side, empty when it goes by its release. */
  name: string;
  /** The side's release, as `pairSideName` gives it. */
  short: string;
  /** The release line, as `getReleaseLabel` gives it, with " + Effect" on the Effect image. */
  line: string;
  /** The side's ORM and Kit versions, as `formatPairText` gives them. */
  pair: string;
  guestFlavor: GuestFlavor;
}

/**
 * How a side is named: its label, release, release line and pair
 *
 * Both sides may run one pair in two flavors, so the Effect side's release and line end in " + Effect".
 */
export function getSideRelease(manifest: PairManifest, side: PairSideIndex): SideRelease {
  const pairSide = manifest.sides[side];
  const { "drizzle-orm": ormVersion, "drizzle-kit": kitVersion } = pairSide.dependencies;
  const guestFlavor = resolveGuestFlavor(pairSide);
  const line = getReleaseLabel(ormVersion);

  return {
    side,
    label: pairSideLabels(manifest)[side],
    database: DIALECTS[pairSide.target.dialect].label,
    name: pairSide.name ?? "",
    short: pairSideName({ ormVersion, guestFlavor }),
    line: guestFlavor === "effect" ? `${line} + Effect` : line,
    pair: formatPairText(ormVersion, kitVersion),
    guestFlavor,
  };
}

/** Both sides' names, in order. */
export function getSideReleases(manifest: PairManifest): readonly [SideRelease, SideRelease] {
  return [getSideRelease(manifest, 0), getSideRelease(manifest, 1)];
}

/**
 * Both sides' releases, as the status bar and the phone header name them
 *
 * One release followed by " on both sides" when they match, otherwise both joined with " and ". Sides on two
 * databases name them too: "rc.5 on PostgreSQL and SQLite", or "0.45 on PostgreSQL and rc.5 on SQLite".
 */
export function formatBothSides(manifest: PairManifest) {
  const [first, second] = getSideReleases(manifest);

  if (first.database !== second.database) {
    return first.short === second.short
      ? `${first.short} on ${first.database} and ${second.database}`
      : `${first.short} on ${first.database} and ${second.short} on ${second.database}`;
  }

  return first.short === second.short ? `${first.short} on both sides` : `${first.short} and ${second.short}`;
}

/** A file tab's hint: the seed is always shared, others are shared or have a copy per side. */
export function getFileHint(manifest: PairManifest, path: string): string {
  if (path === PAIR_SEED_PATH) {
    return `${path} is always shared: it may only use drizzle-seed or db, so it runs on every version`;
  }

  return Object.hasOwn(manifest.files, path)
    ? `${path} is shared: an edit shows on both sides`
    : `${path} has its own copy per side`;
}

/** Shared files first in entry order, then per-side ones: run, schema, seed, then helpers by name. */
export function listPairFiles(manifest: PairManifest): string[] {
  const all = new Set([...Object.keys(manifest.files), ...Object.keys(manifest.sides[0].files)]);
  const { run, schema, seed } = manifest.entrypoints;
  const entries = [run, schema, seed].filter(
    (path, index, list): path is string => path !== undefined && all.has(path) && list.indexOf(path) === index,
  );
  const helpers = [...all]
    .filter((path) => !entries.includes(path))
    .toSorted((left, right) => left.localeCompare(right));

  return [...entries, ...helpers];
}
