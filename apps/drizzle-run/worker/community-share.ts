import * as z from "zod/mini";

import type { CommunityTopic, StoredCommunityListing } from "./community-repository";
import { getAvatarUrl } from "./session";
import type { SnapshotPair } from "./snapshot-summary";

/** A listed snapshot's database and pair. */
export type ListedPair = SnapshotPair;

/** What the Community page shows for one share. Report counts stay private. */
export interface CommunityShare {
  id: string;
  title: string;
  description: string | null;
  topic: CommunityTopic;
  /** The database and pair of a one-version share, or of a side-by-side share's left side. */
  releasePair: ListedPair;
  /** Both sides' databases and pairs, in order; only on a side-by-side share. */
  sides?: [ListedPair, ListedPair];
  files: string[];
  listedAt: string;
  /** The GitHub account that listed it. */
  owner: { login: string; avatarUrl: string };
}

const FileNamesSchema = z.array(z.string());

/** The file names a listing row keeps as JSON; throws when they do not read, since only this Worker writes them. */
function readFileNames(fileNames: string): string[] {
  return FileNamesSchema.parse(JSON.parse(fileNames));
}

/** A listing row as the Community page and a listed shared link show it. */
export function toCommunityShare(
  row: StoredCommunityListing,
  owner: { githubId: number; login: string },
): CommunityShare {
  const files = readFileNames(row.fileNames);

  return {
    id: row.linkId,
    title: row.title,
    description: row.description,
    topic: row.topic,
    releasePair: { dialect: row.dialect, orm: row.ormVersion, kit: row.kitVersion, guestFlavor: row.guestFlavor },
    ...(row.secondDialect === null ||
    row.secondOrmVersion === null ||
    row.secondKitVersion === null ||
    row.secondGuestFlavor === null
      ? {}
      : {
          sides: [
            {
              dialect: row.dialect,
              orm: row.ormVersion,
              kit: row.kitVersion,
              guestFlavor: row.guestFlavor,
              ...(row.sideName === null ? {} : { name: row.sideName }),
            },
            {
              dialect: row.secondDialect,
              orm: row.secondOrmVersion,
              kit: row.secondKitVersion,
              guestFlavor: row.secondGuestFlavor,
              ...(row.secondSideName === null ? {} : { name: row.secondSideName }),
            },
          ],
        }),
    files,
    listedAt: row.listedAt,
    owner: { login: owner.login, avatarUrl: getAvatarUrl(owner.githubId) },
  };
}
