import type { LoadedPlayground } from "../share/playgrounds-contract";
import type { ShareLinkRecord } from "../store/storage";

/**
 * The link record of a project opened from the account's own share
 *
 * It keeps the published digest, so the editor sees edits, and the share's description and Community listing, so the
 * next push starts from them.
 */
export function toOwnedShareLink(
  linkId: string,
  shared: Pick<LoadedPlayground, "updatedAt" | "digest" | "description" | "community">,
): ShareLinkRecord {
  const listing = shared.community;

  return {
    linkId,
    publishedAt: shared.updatedAt,
    publishedDigest: shared.digest,
    ...(shared.description === null ? {} : { description: shared.description }),
    ...(listing === null
      ? {}
      : {
          listing: {
            topic: listing.topic,
            ...(listing.description === null ? {} : { description: listing.description }),
          },
        }),
  };
}
