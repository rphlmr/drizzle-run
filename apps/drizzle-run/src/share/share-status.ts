import { digestPlaygroundSnapshot, parsePlaygroundSnapshot } from "@drizzle-run/core/contracts";

import type { ProjectRecord } from "../project/projects";
import type { ShareLinkRecord } from "../store/storage";

/** Where a project's share stands, as the editor's Share button shows it. */
export type ShareStatus = { status: "not_shared" } | { status: "published" } | { status: "changed" };

/**
 * The content digest of the project as the Share dialog would publish it
 *
 * Returns undefined when the project cannot become a snapshot, such as a manifest the snapshot contract refuses.
 */
export function resolveProjectDigest(project: ProjectRecord): string | undefined {
  try {
    return digestPlaygroundSnapshot(
      parsePlaygroundSnapshot({ snapshotVersion: 1, name: project.name, manifest: project.manifest }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Compare the project with what its link shows
 *
 * A link whose published digest this browser does not know yet reads as published: the dialog checks it with the
 * server and keeps the digest for next time.
 */
export function getShareStatus(record: ShareLinkRecord | undefined, projectDigest: string | undefined): ShareStatus {
  if (record === undefined) {
    return { status: "not_shared" };
  }

  if (record.publishedDigest === undefined || projectDigest === undefined || record.publishedDigest === projectDigest) {
    return { status: "published" };
  }

  return { status: "changed" };
}
