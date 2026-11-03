import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { type Reveal, getRevealedText, startReveal, stepReveal } from "./chat-reveal";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const RENDER_INTERVAL_MS = 32;

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = matchMedia(REDUCED_MOTION_QUERY);

  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
}

function getReducedMotion(): boolean {
  return matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Revealed text
 *
 * The part of an agent's answer to draw: the whole of it unless it is the one streaming now, which reveals word by
 * word on animation frames (see `chat-reveal.ts`). A flush shows everything at once: when streaming ends, or when the
 * reader asks for reduced motion. Rendered without a browser, the text shows whole.
 *
 * @param resumed - The answer was on screen when the chat opened, so the text it has so far shows at once.
 */
export function useRevealedText({
  text,
  streaming,
  resumed,
}: {
  text: string;
  streaming: boolean;
  resumed: boolean;
}): string {
  const reducedMotion = useSyncExternalStore(subscribeToReducedMotion, getReducedMotion, () => true);
  const [reveal, setReveal] = useState<Reveal>(() => startReveal({ streaming, reducedMotion, resumed, text }));
  const readText = useEffectEvent(() => text);
  const readReveal = useEffectEvent(() => reveal);
  const live = streaming && !reducedMotion;

  if (!live && reveal.phase !== "flushed") {
    setReveal(stepReveal(reveal, { type: "reveal.flush" }));
  }

  const flushed = reveal.phase === "flushed";

  useEffect(() => {
    if (!live || flushed) {
      return;
    }

    // The loop owns the reveal from its start; it reads the committed one only once, so commits never reset it.
    let current = readReveal();
    let shown = getRevealedText(readText(), current).length;
    let lastFrameAt: number | undefined;
    let lastCommitAt = 0;
    let frame = requestAnimationFrame(onFrame);

    function onFrame(now: number) {
      const received = readText();

      current = stepReveal(current, {
        type: "reveal.frame",
        elapsedMs: lastFrameAt === undefined ? 0 : now - lastFrameAt,
        text: received,
      });
      lastFrameAt = now;

      const length = getRevealedText(received, current).length;

      if (length !== shown && now - lastCommitAt >= RENDER_INTERVAL_MS) {
        shown = length;
        lastCommitAt = now;
        setReveal(current);
      }

      frame = requestAnimationFrame(onFrame);
    }

    return () => cancelAnimationFrame(frame);
  }, [live, flushed]);

  return getRevealedText(text, reveal);
}
