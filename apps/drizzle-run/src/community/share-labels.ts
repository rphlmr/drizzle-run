import { DIALECTS } from "@drizzle-run/core/catalog";

import { formatShortDate } from "../lib/dates";
import type { CommunityPair, CommunityShare } from "./contract";

/** The database's name as Community writes it. */
export function getDialectName(dialect: CommunityPair["dialect"]) {
  return DIALECTS[dialect].label;
}

/** The databases a share runs, in side order: "PostgreSQL", or "PostgreSQL vs SQLite" for sides on two. */
export function formatShareDialects(share: CommunityShare) {
  const dialects = new Set((share.sides ?? [share.releasePair]).map((pair) => pair.dialect));

  return [...dialects].map(getDialectName).join(" vs ");
}

/** " + Effect" after a pair that runs on the Effect image, else nothing. */
export function getEffectSuffix(pair: CommunityPair) {
  return pair.guestFlavor === "effect" ? " + Effect" : "";
}

/** Community names a pair by its ORM version, never by a release label: "orm 0.45.4", "orm 1.0.0-rc.5 + Effect". */
export function getSharePairLabel(share: CommunityShare) {
  return `orm ${share.releasePair.orm}${getEffectSuffix(share.releasePair)}`;
}

function toPairTitle(pair: CommunityPair) {
  const title = `ORM ${pair.orm} with Kit ${pair.kit}${pair.guestFlavor === "effect" ? " and Effect 4" : ""}`;

  return pair.name === undefined ? title : `${pair.name}: ${title}`;
}

/** A share's ORM and Kit versions, one pair per side for a side by side, each after its side's name when named. */
export function getSharePairTitle(share: CommunityShare) {
  return (share.sides ?? [share.releasePair]).map(toPairTitle).join(", and ");
}

/** "1 file" or "3 files". */
export function formatFileCount(share: CommunityShare) {
  return `${share.files.length} file${share.files.length === 1 ? "" : "s"}`;
}

/** "Oct 9", or "today". */
export function formatSharedDate(share: CommunityShare, now?: Date): string {
  const when = formatShortDate(share.listedAt, now);
  return when === "Today" ? "today" : when;
}

const FILE_ORDER = ["query.ts", "schema.ts", "seed.ts"];

const rankTabFile = (file: string) => {
  const index = FILE_ORDER.indexOf(file);
  return index === -1 ? FILE_ORDER.length : index;
};

/** The files in the order of the editor's tabs. */
export function sortFilesForTabs(files: readonly string[]): string[] {
  return files.toSorted((left, right) => rankTabFile(left) - rankTabFile(right) || left.localeCompare(right));
}

/** The address of a Community share: its shared link. */
export function getCommunitySharePath(share: { id: string }) {
  return `/s/${share.id}`;
}
