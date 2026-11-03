import {
  createRecordedRun,
  digestPlaygroundSnapshot,
  toRecordedGuest,
  type PlaygroundSnapshot,
  type RecordedRun,
} from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { pairSide } from "@drizzle-run/core/pair";
import type { RunRecord } from "@drizzle-run/orchestration";

/** What the Share dialog offers for "Include my last run's output". */
export type RecordingOffer =
  /** No succeeded run of exactly the snapshot's code: the box is not shown. */
  | { status: "none" }
  /** The run fits no recording: the box shows unticked and disabled. */
  | { status: "too_large"; maxBytes: number }
  | { status: "offered"; recording: RecordedRun };

/** Equal manifests give equal digests, since the digest is of canonical JSON. Invalid ones never match. */
function getManifestDigest(manifest: RunManifest): string | null {
  try {
    return digestPlaygroundSnapshot({ snapshotVersion: 1, name: "run", manifest });
  } catch {
    return null;
  }
}

function hasRunCode(run: RunRecord, expected: RunManifest): boolean {
  const ranDigest = getManifestDigest(run.submission.manifest);

  return ranDigest !== null && ranDigest === getManifestDigest(expected);
}

/**
 * Resolve the recording the Share dialog offers
 *
 * Takes the latest settled run of a one-version project, or of each side of a side-by-side one, in side order. Offers
 * it only when every run succeeded on exactly the snapshot's code, so readers never see output of other code. Each run
 * records the guest it ran on, so a reader can tell it apart once a companion refresh replaces that guest.
 */
export function resolveRecordingOffer({
  snapshot,
  latestRuns,
}: {
  snapshot: PlaygroundSnapshot;
  latestRuns: readonly (RunRecord | undefined)[];
}): RecordingOffer {
  const manifest = snapshot.manifest;
  const expected = manifest.kind === "drizzle-run-pair" ? [pairSide(manifest, 0), pairSide(manifest, 1)] : [manifest];
  const runs = latestRuns.filter((run): run is RunRecord => run !== undefined);

  if (runs.length !== expected.length || runs.some((run, index) => !hasRunCode(run, expected[index]))) {
    return { status: "none" };
  }

  const results = runs.map((run) => run.result);
  const guests = runs.map((run) => toRecordedGuest(run.submission.manifest));
  const [first, second] = results;
  const [firstGuest, secondGuest] = guests;

  if (
    first === undefined ||
    firstGuest === undefined ||
    firstGuest === null ||
    results.some((result) => result === undefined) ||
    guests.some((guest) => guest === null)
  ) {
    return { status: "none" };
  }

  const recordedAt = new Date(Math.max(...runs.map((run) => run.settledAt))).toISOString();
  const snapshotDigest = digestPlaygroundSnapshot(snapshot);
  const created =
    second === undefined || secondGuest === undefined || secondGuest === null
      ? createRecordedRun({ result: first, guests: [firstGuest], snapshotDigest, recordedAt })
      : createRecordedRun({ sides: [first, second], guests: [firstGuest, secondGuest], snapshotDigest, recordedAt });

  switch (created.status) {
    case "recorded":
      return { status: "offered", recording: created.recording };

    case "too_large":
      return { status: "too_large", maxBytes: created.maxBytes };

    case "unrecordable":
      return { status: "none" };
  }
}
