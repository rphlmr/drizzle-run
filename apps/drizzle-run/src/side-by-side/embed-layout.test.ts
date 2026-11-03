import { describe, expect, it } from "vitest";

import { EMBED_TWO_COLUMNS_QUERY, getEmbedViewAfterRun } from "./embed-layout";

describe("side-by-side embed layout", () => {
  it("should show both sides from 760 px, as a media query", () => {
    expect(EMBED_TWO_COLUMNS_QUERY).toBe("(min-width: 760px)");
  });

  it("should open Story on a side whose run failed, where its error shows, and keep the view otherwise", () => {
    expect(getEmbedViewAfterRun("problems", "results")).toBe("story");
    expect(getEmbedViewAfterRun("problems", "logs")).toBe("story");
    expect(getEmbedViewAfterRun("results", "logs")).toBe("logs");
    expect(getEmbedViewAfterRun(undefined, "results")).toBe("results");
  });
});
