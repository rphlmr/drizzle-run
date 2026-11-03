import { CONNECT_LIMITS } from "@drizzle-run/core/connect";

/**
 * Chat reveal
 *
 * The companion sends an answer's text in batches, a few a second, so each batch would land as a jump. The tab
 * reveals a growing prefix of the streaming answer instead, one frame at a time, at a pace that follows the backlog:
 * steady while batches keep coming, fast when far behind. The received text stays the source of truth; the reveal
 * only decides how much of it shows.
 *
 * ```text
 * idle ──frame (a word arrived)──▶ revealing ◀──frame (more text)──▶ caught_up
 *   └──────────────── flush (turn ended, stopped, failed, reduced motion) ──────────────▶ flushed
 * ```
 */

/** How the reveal paces itself. */
export const REVEAL_PACING = {
  /** The lag the reveal aims for: one batch of the companion's text, so it never runs much further behind. */
  targetLagMs: CONNECT_LIMITS.textBatchMs,
  /** The slowest pace, in characters per millisecond, so the last words of a batch never crawl. */
  minCharsPerMs: 0.06,
  /** How quickly the pace follows the backlog: slower smooths the pace between batches, faster catches up sooner. */
  paceSmoothingMs: 200,
  /** The longest frame counted, so a tab back from the background catches up at pace rather than in one jump. */
  maxFrameMs: 100,
} as const;

/** Where a streaming answer's reveal stands. `position` counts the characters shown, `pace` is per millisecond. */
export type Reveal =
  | { phase: "idle" }
  | { phase: "revealing"; position: number; pace: number }
  | { phase: "caught_up"; position: number; pace: number }
  | { phase: "flushed" };

/** What moves a reveal: a frame with the text received so far, or the end of streaming. */
export type RevealEvent = { type: "reveal.frame"; elapsedMs: number; text: string } | { type: "reveal.flush" };

/** How an answer's reveal starts. */
export interface RevealStart {
  /** The answer is the one the agent writes now. */
  streaming: boolean;
  /** The reader asked for reduced motion. */
  reducedMotion: boolean;
  /** The answer was already on screen when the chat opened: what it has so far shows at once. */
  resumed: boolean;
  /** The text received so far. */
  text: string;
}

/**
 * Start a reveal
 *
 * A finished answer, or any answer under reduced motion, starts flushed. A streaming answer the chat opened on starts
 * caught up with what it already has, so only the text still to come reveals.
 */
export function startReveal({ streaming, reducedMotion, resumed, text }: RevealStart): Reveal {
  if (!streaming || reducedMotion) {
    return { phase: "flushed" };
  }

  if (resumed) {
    return { phase: "caught_up", position: getRevealLimit(text), pace: REVEAL_PACING.minCharsPerMs };
  }

  return { phase: "idle" };
}

/**
 * Reveal pace
 *
 * The characters per millisecond that clear `backlogChars` in about one target lag, never below the minimum pace.
 */
export function getRevealPace(backlogChars: number): number {
  return Math.max(REVEAL_PACING.minCharsPerMs, backlogChars / REVEAL_PACING.targetLagMs);
}

/**
 * Step a reveal
 *
 * A frame moves the position toward the last whole word received, at a pace eased toward `getRevealPace` of the
 * backlog. A flush ends the reveal for good: every later event leaves it flushed.
 */
export function stepReveal(reveal: Reveal, event: RevealEvent): Reveal {
  if (reveal.phase === "flushed") {
    return reveal;
  }

  if (event.type === "reveal.flush") {
    return { phase: "flushed" };
  }

  const limit = getRevealLimit(event.text);

  if (reveal.phase === "idle") {
    return limit === 0 ? reveal : { phase: "revealing", position: 0, pace: getRevealPace(limit) };
  }

  const backlog = limit - reveal.position;

  if (backlog <= 0) {
    return reveal.phase === "caught_up" ? reveal : { phase: "caught_up", position: reveal.position, pace: reveal.pace };
  }

  const elapsedMs = Math.min(Math.max(event.elapsedMs, 0), REVEAL_PACING.maxFrameMs);
  const easing = Math.min(1, elapsedMs / REVEAL_PACING.paceSmoothingMs);
  const pace = Math.max(REVEAL_PACING.minCharsPerMs, reveal.pace + (getRevealPace(backlog) - reveal.pace) * easing);
  const position = Math.min(limit, reveal.position + pace * elapsedMs);

  return { phase: position >= limit ? "caught_up" : "revealing", position, pace };
}

/**
 * Revealed text
 *
 * The part of `text` a reveal shows: all of it once flushed, nothing while idle, else the prefix up to the last word
 * boundary at or before the position, so a word never shows half written.
 */
export function getRevealedText(text: string, reveal: Reveal): string {
  switch (reveal.phase) {
    case "flushed":
      return text;
    case "idle":
      return "";
    case "revealing":
    case "caught_up":
      return text.slice(0, getWordBoundaryAtOrBefore(text, Math.floor(reveal.position)));
  }
}

/**
 * Reveal limit
 *
 * How far a streaming text may reveal: up to its last whitespace, since the word after it may still be arriving.
 * The end of the text shows only on a flush. Returns 0 for a text with no whitespace yet.
 */
export function getRevealLimit(text: string): number {
  return getWordBoundaryAtOrBefore(text, text.length - 1);
}

function getWordBoundaryAtOrBefore(text: string, index: number): number {
  let boundary = Math.max(0, Math.min(index, text.length - 1));

  while (boundary > 0 && !isWhitespace(text[boundary])) {
    boundary -= 1;
  }

  while (boundary > 0 && isWhitespace(text[boundary - 1])) {
    boundary -= 1;
  }

  return boundary;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}
