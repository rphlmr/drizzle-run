import type { RunLanding } from "@drizzle-run/orchestration";

/**
 * From this embed width both sides show in two columns, like two browsers (`SideBySideEmbedWide`);
 * under it, one side at a time with a side switch, like phones (`SideBySideEmbed`).
 */
export const EMBED_TWO_COLUMNS_MIN_WIDTH = 760;

/** Matches when the embed is wide enough for both sides. */
export const EMBED_TWO_COLUMNS_QUERY = `(min-width: ${EMBED_TWO_COLUMNS_MIN_WIDTH}px)`;

/** The output views an embed offers: Results, Story (where a failed run's error shows) and Logs. */
export const EMBED_SIDE_VIEWS = ["results", "story", "logs"] as const;

/** An output view a side offers in an embed. */
export type EmbedSideView = (typeof EMBED_SIDE_VIEWS)[number];

/** Where a side's output goes when its run settles: a failed run shows its error in Story. */
export function getEmbedViewAfterRun(opens: RunLanding | undefined, current: EmbedSideView): EmbedSideView {
  return opens === "problems" ? "story" : current;
}
