import { findReplacedGuest, parseRecordedRun, safeParseRecordedRun } from "@drizzle-run/core/contracts";

import { readApiErrorCode, readJsonBody, sendApiRequest, type Fetch } from "../lib/api";
import { PlaygroundIdSchema } from "../share/playgrounds-contract";
import { RecordedRunResponseSchema, type RecordedRunsService } from "./recorded-runs-contract";

/** What the recorded runs API needs: the network and the origin it runs on. */
export interface RecordedRunsServiceDependencies {
  /** Sends every request; the browser's `fetch` in the app, a fake in tests. */
  fetch: Fetch;
  /** The Drizzle Run origin requests go to, such as `https://drizzle.run`. */
  origin: string;
}

const errorMessages: Readonly<Partial<Record<string, string>>> = {
  recording_too_large: "This run's output is too large to include. The snapshot is published without it.",
  recording_digest_mismatch: "This run is of different code than the published snapshot, so it was not included.",
  recording_exists: "This shared playground already has a recorded run.",
  invalid_recording: "This run's output could not be included.",
  unsupported_version: "This run's output uses a format this version of Drizzle Run cannot store.",
  rate_limited: "Too many runs were recorded. Try again shortly.",
  publish_storage_full:
    "Drizzle Run has no room left for recorded runs, so the snapshot is published without this run.",
  rate_limit_unavailable: "Recording runs is unavailable right now. Try again in a moment.",
  recording_storage_unavailable: "Recording runs is unavailable right now. Try again in a moment.",
  sign_in_required: "Sign in with the GitHub account that shared this link to add your run.",
  not_link_owner: "This share belongs to another GitHub account, so it cannot add the run.",
  playground_not_found: "This shared playground could not be found.",
};

function getRecordingPath(linkId: string): string {
  if (!PlaygroundIdSchema.safeParse(linkId).success) {
    throw new TypeError(`Expected a playground ID, but got '${linkId}'`);
  }

  return `/api/playgrounds/${encodeURIComponent(linkId)}/recording`;
}

async function readError(response: Response, signal: AbortSignal): Promise<Error> {
  const code = await readApiErrorCode(response, signal);

  return new Error(
    (code === undefined ? undefined : errorMessages[code]) ??
      "The run's output could not be included. Check your connection and try again.",
  );
}

/** Create the recorded runs API, sending every request to `origin`. */
export function createRecordedRunsService({ fetch, origin }: RecordedRunsServiceDependencies): RecordedRunsService {
  const toUrl = (path: string) => new URL(path, origin).href;

  return {
    async recordRun({ linkId, recording, signal }) {
      const path = getRecordingPath(linkId);
      const response = await sendApiRequest(fetch, toUrl(path), {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(parseRecordedRun(recording)),
        signal,
      });

      if (!response.ok) {
        throw await readError(response, signal);
      }
    },

    async getRecordedRun({ linkId, snapshotDigest, signal }) {
      const response = await sendApiRequest(fetch, toUrl(getRecordingPath(linkId)), {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw await readError(response, signal);
      }

      const body = RecordedRunResponseSchema.safeParse(await readJsonBody(response, signal));
      const parsed = safeParseRecordedRun(body.success ? body.data.recording : undefined);

      if (!parsed.success || parsed.data.snapshotDigest !== snapshotDigest || findReplacedGuest(parsed.data) !== null) {
        return null;
      }

      return parsed.data;
    },
  };
}
