import type { RecordedRun } from "@drizzle-run/core/contracts";

import { resolveOfficialRecording, type OfficialEmbed } from "./official-embeds";

/** The recordings `pnpm record:official` writes, one chunk each, loaded only by an embed that cannot run. */
const recordingModules = import.meta.glob<unknown>(
  ["../../examples/*/recording.json", "../../guides/*/recordings/*.json"],
  { import: "default" },
);

/**
 * Load the recorded run of an official embed
 *
 * Returns `null` when it has none, when it was recorded for other code, or when its chunk fails to load: the embed
 * then offers a new tab, as for a share without a recording.
 */
export async function loadOfficialRecording(embed: OfficialEmbed): Promise<RecordedRun | null> {
  const loadRecording = recordingModules[`../../${embed.recordingPath}`];

  if (loadRecording === undefined) {
    return null;
  }

  try {
    return resolveOfficialRecording(embed, await loadRecording());
  } catch {
    return null;
  }
}
