import type { CSSProperties } from "react";

import { cn } from "../lib/utils";

/** Neutral drops vary in strength; the classes are listed whole so Tailwind can find them. */
const NEUTRAL_TONES = ["bg-text/10", "bg-text/13", "bg-text/16", "bg-text/19", "bg-text/22"] as const;

/** One drop of the rain: its place, length, tone, and animation timing, as CSS values. */
export interface RainDrop {
  left: string;
  top: string;
  height: string;
  tone: string;
  duration: string;
  delay: string;
}

/** A deterministic scatter: the drops look random but land the same on every load, so screenshots stay stable. */
export function scatterRainDrops(count = 36): RainDrop[] {
  return Array.from({ length: count }, (_, index) => ({
    left: `${(index * 37 + 11) % 100}%`,
    top: `${(index * 53 + 7) % 100}%`,
    height: `${16 + ((index * 11) % 22)}px`,
    tone: index % 6 === 2 ? "bg-lime" : NEUTRAL_TONES[(index * 7) % 5],
    duration: `${7 + ((index * 13) % 7)}s`,
    delay: `-${(index * 17) % 11}s`,
  }));
}

const DROPS = scatterRainDrops();

/**
 * Drizzle falling across the dot grid, clear in the middle so the hero stays readable. Reduced motion holds it still.
 */
export function DrizzleRain() {
  return (
    <div
      className="pointer-events-none absolute inset-[-30%] rotate-30 mask-[radial-gradient(ellipse_46%_52%_at_50%_50%,transparent_35%,var(--ink)_80%)]"
      aria-hidden="true"
    >
      {DROPS.map((drop, index) => {
        const style: CSSProperties = {
          left: drop.left,
          top: drop.top,
          height: drop.height,
          animationDuration: drop.duration,
          animationDelay: drop.delay,
        };

        return (
          <span
            key={index}
            className={cn("absolute w-1.25 animate-drizzle rounded-pill motion-reduce:animate-none", drop.tone)}
            style={style}
          />
        );
      })}
    </div>
  );
}
