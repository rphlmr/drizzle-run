import type { RecordedRun, RecordedRunResult } from "@drizzle-run/core/contracts";

import { getEmbedPlaygroundPath, type EmbedTarget } from "../embed-loader/protocol";
import { listExamples } from "../examples/catalog";
import { resolveOfficialEmbed } from "../official/official-embeds";
import { loadOfficialRecording } from "../official/official-recordings";
import {
  createProjectFromManifest,
  isOneVersion,
  openSharedSnapshot,
  type OneVersionProject,
  type ProjectRecord,
  type SideBySideProject,
} from "../project/projects";
import {
  isRetiredPairPlayground,
  PlaygroundNotFoundError,
  type PlaygroundsService,
} from "../share/playgrounds-contract";
import { EmbedTargetNotFoundError } from "./embed-failure";
import type { EmbedPlaygroundLoad } from "./embed-load";
import type { RecordedBy, RecordedReason } from "./recorded-embed";
import type { RecordedRunsService } from "./recorded-runs-contract";

/** A project with a recorded run of it, shown where the embed cannot run. */
export type RecordedPlayground = { recordedAt: string; reason: RecordedReason; recordedBy: RecordedBy } & (
  | { kind: "one_version"; project: OneVersionProject; result: RecordedRunResult }
  | { kind: "side_by_side"; project: SideBySideProject; sides: readonly [RecordedRunResult, RecordedRunResult] }
);

/** Where an embed's playground and its recorded run come from: a shared link, or an official example. */
export interface EmbedSource {
  /** What the loader names in its connect message; the bridge connects only to a loader naming it. */
  target: EmbedTarget;
  /** The full playground, which runs the code in its own tab. */
  playgroundHref: string;
  /** Load the playground to run. Throws when it cannot be loaded, with a not-found error when it does not exist. */
  loadPlayground(signal: AbortSignal): Promise<EmbedPlaygroundLoad | null>;
  /**
   * Find the recorded run to show where the embed cannot run, or `null` when there is none. Throws a not-found error
   * when the playground itself does not exist.
   */
  findRecorded(reason: RecordedReason, signal: AbortSignal): Promise<RecordedPlayground | null>;
}

/** Pairs a project with its recording; `null` when the recording does not fit the project's kind. */
function toRecordedPlayground({
  project,
  recording,
  reason,
  recordedBy,
}: {
  project: ProjectRecord;
  recording: RecordedRun;
  reason: RecordedReason;
  recordedBy: RecordedBy;
}): RecordedPlayground | null {
  const { recordedAt } = recording;

  if (isOneVersion(project)) {
    return recording.result === undefined
      ? null
      : { kind: "one_version", project, result: recording.result, recordedAt, reason, recordedBy };
  }

  return recording.sides === undefined
    ? null
    : { kind: "side_by_side", project, sides: recording.sides, recordedAt, reason, recordedBy };
}

/**
 * Create the source of a shared link
 *
 * Its recording is the author's run of what the link shows. `findRecorded` returns `null` when there is none,
 * when the snapshot needs a release choice first, or when loading fails: the embed then offers a new tab as before. A
 * link that answers 404 throws `PlaygroundNotFoundError` instead, since a new tab would not find it either.
 */
export function createSnapshotSource({
  snapshotId,
  playgrounds,
  recordedRuns,
}: {
  snapshotId: string;
  playgrounds: Pick<PlaygroundsService, "getPlaygroundSnapshot">;
  recordedRuns: Pick<RecordedRunsService, "getRecordedRun">;
}): EmbedSource {
  const target = { snapshotId };

  return {
    target,
    playgroundHref: getEmbedPlaygroundPath(target),
    async loadPlayground(signal) {
      const shared = await playgrounds.getPlaygroundSnapshot({ id: snapshotId, signal });
      const opened = openSharedSnapshot(shared);

      if (opened) {
        return { project: opened };
      }

      return isRetiredPairPlayground(shared) ? { retired: shared } : null;
    },
    async findRecorded(reason, signal) {
      try {
        const shared = await playgrounds.getPlaygroundSnapshot({ id: snapshotId, signal });

        if (isRetiredPairPlayground(shared)) {
          return null;
        }

        const project = openSharedSnapshot(shared);
        const recording =
          project === undefined
            ? null
            : await recordedRuns.getRecordedRun({
                linkId: snapshotId,
                snapshotDigest: shared.digest,
                signal,
              });

        return project === undefined || recording === null
          ? null
          : toRecordedPlayground({ project, recording, reason, recordedBy: "author" });
      } catch (cause) {
        if (cause instanceof PlaygroundNotFoundError) {
          throw cause;
        }

        return null;
      }
    },
  };
}

/**
 * Create the source of an official example, or of one step of its guide
 *
 * Its code ships with the app and its recording is the one `pnpm record:official` made, shown only for exactly that
 * code. `loadPlayground` and `findRecorded` throw `EmbedTargetNotFoundError` for an unknown example or step.
 */
export function createOfficialSource(target: { example: string; step?: string }): EmbedSource {
  const embed = resolveOfficialEmbed(listExamples(), target);
  const resolveEmbed = () => {
    if (embed === null) {
      throw new EmbedTargetNotFoundError("This example or guide step does not exist.");
    }

    return embed;
  };
  const openProject = () => {
    const { example, manifest } = resolveEmbed();

    return createProjectFromManifest(example.title, manifest);
  };

  return {
    target,
    playgroundHref: getEmbedPlaygroundPath(target),
    loadPlayground: async () => ({ project: openProject() }),
    async findRecorded(reason) {
      const recording = await loadOfficialRecording(resolveEmbed());

      return recording === null
        ? null
        : toRecordedPlayground({ project: openProject(), recording, reason, recordedBy: "drizzle-run" });
    },
  };
}
