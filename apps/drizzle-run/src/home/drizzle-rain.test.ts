import { describe, expect, it } from "vitest";

import { scatterRainDrops } from "./drizzle-rain";

describe("drizzle rain", () => {
  it("should scatter the same drops on every load, so screenshots stay stable", () => {
    expect(scatterRainDrops()).toEqual(scatterRainDrops());
    expect(scatterRainDrops()).toHaveLength(36);
  });

  it("should mix plain lime drops into neutral ones, about one in six", () => {
    const tones = scatterRainDrops().map((drop) => drop.tone);

    expect(tones.filter((tone) => tone === "bg-lime")).toHaveLength(6);
    expect(tones.every((tone) => tone === "bg-lime" || /^bg-text\/\d+$/.test(tone))).toBe(true);
  });

  it("should start every drop mid-fall with a negative delay", () => {
    expect(scatterRainDrops().every((drop) => /^-\d+s$/.test(drop.delay))).toBe(true);
  });
});
