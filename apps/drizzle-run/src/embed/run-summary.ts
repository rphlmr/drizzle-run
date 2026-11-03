import type { RunResult } from "@drizzle-run/core/contracts";
import type { PairSideIndex } from "@drizzle-run/core/pair";
import type { RunOutcome } from "@drizzle-run/orchestration";

import {
  EMBED_MAX_RUN_DISPLAYS_BYTES,
  EMBED_MAX_RUN_ERROR_LENGTH,
  getEmbedJsonByteLength,
  type EmbedRunDisplay,
  type EmbedRunSummary,
} from "../embed-loader/protocol";

const FAILED_WITHOUT_MESSAGE = "The run failed.";

/** The parts of a run machine's `run.settled` event a summary reads. */
type SettledRun = Pick<RunOutcome, "outcome" | "error"> & {
  result?: Pick<RunResult, "displays" | "diagnostics">;
};

/** The settled run's error: the run's own, else its first error diagnostic, cut to the protocol's limit. */
function getRunError(settled: SettledRun): string {
  const message =
    settled.error ??
    settled.result?.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ??
    FAILED_WITHOUT_MESSAGE;

  if (message.length <= EMBED_MAX_RUN_ERROR_LENGTH) {
    return message;
  }

  const cut = EMBED_MAX_RUN_ERROR_LENGTH - 1;
  // A cut between the two halves of a surrogate pair, such as an emoji, would leave half a character.
  const end = isHighSurrogate(message.charCodeAt(cut - 1)) ? cut - 1 : cut;

  return `${message.slice(0, end)}…`;
}

function isHighSurrogate(code: number) {
  return code >= 0xd8_00 && code <= 0xdb_ff;
}

/**
 * Keep the displays that fit the protocol's JSON budget, in order
 *
 * Stops at the first display that would pass {@link EMBED_MAX_RUN_DISPLAYS_BYTES}, so the host never gets a later
 * display without an earlier one.
 */
function boundDisplays(displays: readonly EmbedRunDisplay[]): { displays: EmbedRunDisplay[]; truncated: boolean } {
  const kept: EmbedRunDisplay[] = [];
  let totalBytes = 2;

  for (const display of displays) {
    const separatorBytes = kept.length === 0 ? 0 : 1;
    const displayBytes = getEmbedJsonByteLength(display) + separatorBytes;

    if (totalBytes + displayBytes > EMBED_MAX_RUN_DISPLAYS_BYTES) {
      return { displays: kept, truncated: true };
    }

    kept.push(display);
    totalBytes += displayBytes;
  }

  return { displays: kept, truncated: false };
}

/**
 * Summarize a settled run for the host page
 *
 * Carries the outcome, the error of a failed run (truncated to `EMBED_MAX_RUN_ERROR_LENGTH` characters), and the
 * display labels and values that fit `EMBED_MAX_RUN_DISPLAYS_BYTES` of JSON. Pass `side` for a side-by-side embed.
 * A run that settled without a result, such as one that failed to start, has no displays.
 */
export function toEmbedRunSummary(settled: SettledRun, side?: PairSideIndex): EmbedRunSummary {
  const displays = (settled.result?.displays ?? []).map(({ label, values }) => ({ label, values }));
  const bounded = boundDisplays(displays);

  return {
    outcome: settled.outcome,
    ...(side === undefined ? {} : { side }),
    ...(settled.outcome === "failed" ? { error: getRunError(settled) } : {}),
    displays: bounded.displays,
    truncated: bounded.truncated,
  };
}
