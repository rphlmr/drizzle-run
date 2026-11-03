import { removeControlCharacters, truncateCharacters } from "./plain-text";
import type { ListingCopy } from "./snapshot-repository";
import { readSnapshotSummary, type SnapshotPair } from "./snapshot-summary";

/** The longest Community listing title, in characters; a listing copies the project name up to it. */
export const maxListingTitleLength = 160;

/** What a listing and a share's link preview read from a stored snapshot: its title, pairs, and file paths. */
export interface ListedSnapshot {
  title: string;
  pair: SnapshotPair;
  second: SnapshotPair | null;
  files: string[];
}

/**
 * Read a stored snapshot's listing view from its summary
 *
 * Title, databases, pairs, and files come from the stored snapshot, never from the request. A side-by-side snapshot
 * lists each side's database and pair, and every path either side runs.
 */
export function readListedSnapshot(summaryJson: string): ListedSnapshot {
  const summary = readSnapshotSummary(summaryJson);
  const [pair, second = null] = summary.pairs;
  // Without control characters, which D1's length() check cannot count past.
  const listedName = removeControlCharacters(summary.name).trim();

  return {
    title: truncateCharacters(listedName === "" ? "Untitled project" : listedName, maxListingTitleLength),
    pair,
    second,
    files: Object.keys(summary.files).toSorted(),
  };
}

/** The columns a Community listing copies from a snapshot's summary, for search and filters. */
export function toListingCopy(summaryJson: string): ListingCopy {
  const listed = readListedSnapshot(summaryJson);

  return {
    title: listed.title,
    dialect: listed.pair.dialect,
    ormVersion: listed.pair.orm,
    kitVersion: listed.pair.kit,
    guestFlavor: listed.pair.guestFlavor,
    secondDialect: listed.second?.dialect ?? null,
    secondOrmVersion: listed.second?.orm ?? null,
    secondKitVersion: listed.second?.kit ?? null,
    secondGuestFlavor: listed.second?.guestFlavor ?? null,
    sideName: listed.second === null ? null : (listed.pair.name ?? null),
    secondSideName: listed.second?.name ?? null,
    fileNames: JSON.stringify(listed.files),
  };
}
