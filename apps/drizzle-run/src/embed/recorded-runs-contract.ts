import type { RecordedRun } from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

/** `GET .../recording`: the recording itself is checked by core's recorded run parser. */
export const RecordedRunResponseSchema = z.object({ recording: z.optional(z.unknown()) });

/** Record the author's run of what a link shows. */
export interface RecordRunRequest {
  linkId: string;
  recording: RecordedRun;
  signal: AbortSignal;
}

/** Load the recorded run of a link, made of exactly `snapshotDigest`. */
export interface GetRecordedRunRequest {
  linkId: string;
  snapshotDigest: string;
  signal: AbortSignal;
}

/** The author's recorded runs of shared links. */
export interface RecordedRunsService {
  /**
   * Record the author's run of what a link shows
   *
   * Needs the owner's signed-in session. Sending the same recording again succeeds; the server refuses a run of other
   * code. Pushing other code to the link drops the recording.
   */
  recordRun(request: RecordRunRequest): Promise<void>;
  /**
   * Get the recorded run of a link
   *
   * Returns `null` when the link has none, when its recording is not of `snapshotDigest`, or when it ran on a guest
   * the catalog has since refreshed or replaced, so a reader never sees output from other code or an older guest.
   */
  getRecordedRun(request: GetRecordedRunRequest): Promise<RecordedRun | null>;
}
