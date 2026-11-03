import { listRetiredReleases, type ProjectRecord, type RetiredRelease } from "../project/projects";
import type { RetiredPairPlayground } from "../share/playgrounds-contract";
import type { EmbedFailure } from "./embed-failure";

/** What an embed's source loads: a project to open, or a playground published on a pair Drizzle Run no longer ships. */
export type EmbedPlaygroundLoad =
  | { project: ProjectRecord; retired?: never }
  | { retired: RetiredPairPlayground; project?: never };

/** A playground on removed pairs, with the release to choose for each. */
export interface RetiredEmbedPlayground {
  playground: RetiredPairPlayground;
  releases: readonly RetiredRelease[];
}

/** What the embed shows once its playground loaded. */
export type EmbedLoadState =
  | { kind: "project"; project: ProjectRecord }
  | { kind: "retired"; retired: RetiredEmbedPlayground }
  | { kind: "failed"; failure: EmbedFailure };

/** Said when the playground exists but this version cannot open it; the full playground says why. */
const unopenableMessage = "This shared playground cannot be opened in an embed.";

/**
 * Resolve what an embed shows for its loaded playground
 *
 * A project opens. A playground on removed pairs asks for a release per pair. Anything else, such as a manifest with
 * another problem than its pair, is `unopenable`: a retry would load the same playground, so the loader offers none and
 * links to the full playground instead.
 */
export function resolveEmbedLoad(loaded: EmbedPlaygroundLoad | null): EmbedLoadState {
  if (loaded?.project !== undefined) {
    return { kind: "project", project: loaded.project };
  }

  const releases = loaded?.retired === undefined ? undefined : listRetiredReleases(loaded.retired.snapshot.manifest);

  if (loaded?.retired !== undefined && releases !== undefined && releases.length > 0) {
    return { kind: "retired", retired: { playground: loaded.retired, releases } };
  }

  return { kind: "failed", failure: { code: "unopenable", message: unopenableMessage } };
}
