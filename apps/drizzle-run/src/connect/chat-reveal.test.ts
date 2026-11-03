import { describe, expect, it } from "vitest";

import {
  REVEAL_PACING,
  type Reveal,
  getRevealLimit,
  getRevealPace,
  getRevealedText,
  startReveal,
  stepReveal,
} from "./chat-reveal";

const FRAME_MS = 1000 / 60;

function makeStart(change: Partial<Parameters<typeof startReveal>[0]> = {}) {
  return startReveal({ streaming: true, reducedMotion: false, resumed: false, text: "", ...change });
}

function makeWords(count: number, from = 0): string {
  return Array.from({ length: count }, (_, index) => `word${from + index}`).join(" ");
}

/** Runs 60 fps frames for `durationMs` against a fixed text. */
function runFrames(reveal: Reveal, text: string, durationMs: number): Reveal {
  let current = reveal;

  for (let elapsed = 0; elapsed < durationMs; elapsed += FRAME_MS) {
    current = stepReveal(current, { type: "reveal.frame", elapsedMs: FRAME_MS, text });
  }

  return current;
}

describe("getRevealPace", () => {
  it("should clear a backlog in about one target lag, never below the minimum pace", () => {
    expect(getRevealPace(500)).toBeCloseTo(500 / REVEAL_PACING.targetLagMs);
    expect(getRevealPace(0)).toBe(REVEAL_PACING.minCharsPerMs);
    expect(getRevealPace(1)).toBe(REVEAL_PACING.minCharsPerMs);
    expect(getRevealPace(4_000)).toBeGreaterThan(getRevealPace(400));
  });
});

describe("getRevealLimit", () => {
  it("should stop before the last word, which may still be arriving", () => {
    expect(getRevealLimit("Hello wor")).toBe("Hello".length);
    expect(getRevealLimit("Hello   world")).toBe("Hello".length);
    expect(getRevealLimit("Hello world\n")).toBe("Hello world".length);
    expect(getRevealLimit("Hello")).toBe(0);
    expect(getRevealLimit("")).toBe(0);
  });
});

describe("startReveal", () => {
  it("should flush a finished answer and any answer under reduced motion", () => {
    expect(makeStart({ streaming: false, text: "Done." })).toEqual({ phase: "flushed" });
    expect(makeStart({ reducedMotion: true, text: "Writing this" })).toEqual({ phase: "flushed" });
    expect(getRevealedText("Writing this", makeStart({ reducedMotion: true }))).toBe("Writing this");
  });

  it("should reveal a new streaming answer from its start", () => {
    const reveal = makeStart({ text: "First words" });

    expect(reveal).toEqual({ phase: "idle" });
    expect(getRevealedText("First words", reveal)).toBe("");
  });

  it("should show what a resumed answer already has at once", () => {
    const text = `${makeWords(200)} partia`;
    const reveal = makeStart({ resumed: true, text });

    expect(reveal.phase).toBe("caught_up");
    expect(getRevealedText(text, reveal)).toBe(makeWords(200));
  });
});

describe("stepReveal", () => {
  it("should stay idle until a whole word arrives, then reveal word by word", () => {
    const idle = stepReveal(makeStart(), { type: "reveal.frame", elapsedMs: FRAME_MS, text: "Hel" });

    expect(idle).toEqual({ phase: "idle" });

    const text = "Hello there, this is a streamed answer with several words";
    const shown = new Set<string>();
    let reveal = stepReveal(idle, { type: "reveal.frame", elapsedMs: FRAME_MS, text });

    expect(reveal.phase).toBe("revealing");

    for (let frame = 0; frame < 60; frame += 1) {
      reveal = stepReveal(reveal, { type: "reveal.frame", elapsedMs: FRAME_MS, text });
      shown.add(getRevealedText(text, reveal));
    }

    for (const prefix of shown) {
      expect(prefix === "" || text.startsWith(`${prefix} `)).toBe(true);
    }

    expect(shown.size).toBeGreaterThan(5);
    expect(reveal.phase).toBe("caught_up");
    expect(getRevealedText(text, reveal)).toBe("Hello there, this is a streamed answer with several");
  });

  it("should catch up quickly when far behind", () => {
    const text = `${makeWords(1_000)} tail`;
    const started = stepReveal(makeStart(), { type: "reveal.frame", elapsedMs: 0, text });
    const reveal = runFrames(started, text, 3 * REVEAL_PACING.targetLagMs);

    expect(reveal.phase).toBe("caught_up");
    expect(getRevealedText(text, reveal)).toBe(makeWords(1_000));
  });

  it("should never lag much more than one batch while batches keep coming", () => {
    const batchMs = REVEAL_PACING.targetLagMs;
    let text = "";
    let reveal = makeStart();
    let maxLagChars = 0;

    for (let batch = 0; batch < 40; batch += 1) {
      text = `${text}${makeWords(8, batch * 8)} `;

      for (let elapsed = 0; elapsed < batchMs; elapsed += FRAME_MS) {
        reveal = stepReveal(reveal, { type: "reveal.frame", elapsedMs: FRAME_MS, text });

        if (batch > 4) {
          maxLagChars = Math.max(maxLagChars, getRevealLimit(text) - getRevealedText(text, reveal).length);
        }
      }
    }

    const batchChars = `${makeWords(8, 100)} `.length;

    expect(maxLagChars).toBeLessThan(2 * batchChars);
  });

  it("should keep the pace steady between steady batches", () => {
    const batchMs = REVEAL_PACING.targetLagMs;
    let text = "";
    let reveal = makeStart();
    const paces: number[] = [];

    for (let batch = 0; batch < 40; batch += 1) {
      text = `${text}${makeWords(8, batch * 8)} `;

      for (let elapsed = 0; elapsed < batchMs; elapsed += FRAME_MS) {
        reveal = stepReveal(reveal, { type: "reveal.frame", elapsedMs: FRAME_MS, text });

        if (batch > 10 && reveal.phase !== "idle" && reveal.phase !== "flushed") {
          paces.push(reveal.pace);
        }
      }
    }

    expect(Math.max(...paces) / Math.min(...paces)).toBeLessThan(2);
  });

  it("should move on from caught_up when more text arrives", () => {
    const first = "One two three ";
    const caughtUp = runFrames(
      stepReveal(makeStart(), { type: "reveal.frame", elapsedMs: 0, text: first }),
      first,
      500,
    );

    expect(caughtUp.phase).toBe("caught_up");

    const more = `${first}four five six `;
    const revealing = stepReveal(caughtUp, { type: "reveal.frame", elapsedMs: FRAME_MS, text: more });

    expect(revealing.phase).toBe("revealing");
    expect(getRevealedText(more, runFrames(revealing, more, 500))).toBe("One two three four five six");
  });

  it("should count a long frame as at most the maximum frame", () => {
    const text = `${makeWords(1_000)} tail`;
    const started = stepReveal(makeStart(), { type: "reveal.frame", elapsedMs: 0, text });
    const afterLongFrame = stepReveal(started, { type: "reveal.frame", elapsedMs: 10_000, text });
    const afterMaxFrame = stepReveal(started, { type: "reveal.frame", elapsedMs: REVEAL_PACING.maxFrameMs, text });

    expect(afterLongFrame).toEqual(afterMaxFrame);
  });

  it("should show everything on flush, the last partial word included, and stay flushed", () => {
    const text = "The turn ended mid-wo";
    const revealing = stepReveal(makeStart(), { type: "reveal.frame", elapsedMs: 0, text });
    const flushed = stepReveal(revealing, { type: "reveal.flush" });

    expect(flushed).toEqual({ phase: "flushed" });
    expect(getRevealedText(text, flushed)).toBe(text);
    expect(stepReveal(flushed, { type: "reveal.frame", elapsedMs: FRAME_MS, text: `${text}rd` })).toBe(flushed);
  });
});
