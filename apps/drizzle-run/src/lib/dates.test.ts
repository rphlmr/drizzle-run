import { describe, expect, it } from "vitest";

import { formatLongDate, formatShortDate } from "./dates";

describe("dates", () => {
  it("should say today, drop this year, and keep another year", () => {
    const now = new Date(2026, 9, 13, 15);

    expect(formatShortDate(new Date(2026, 9, 13, 9).toISOString(), now)).toBe("Today");
    expect(formatShortDate(new Date(2026, 9, 10, 9).toISOString(), now)).toBe("Oct 10");
    expect(formatShortDate(new Date(2025, 11, 2, 9).toISOString(), now)).toBe("Dec 2, 2025");
    expect(formatShortDate("invalid", now)).toBe("");
  });

  it("should write a long date with its year", () => {
    expect(formatLongDate(new Date(2026, 9, 17, 9).toISOString())).toBe("Oct 17, 2026");
    expect(formatLongDate("invalid")).toBe("");
  });
});
