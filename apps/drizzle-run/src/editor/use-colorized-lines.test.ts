import { describe, expect, it } from "vitest";

import { splitColorizedLines } from "./use-colorized-lines";

describe("splitColorizedLines", () => {
  it("should give one entry per line of Monaco's colorized HTML", () => {
    const html =
      '<div class="monaco-tokenized-source"><span class="mtk8">import</span><br/><br/><span class="mtk1">x</span><br/></div>';

    expect(splitColorizedLines(html)).toEqual([
      '<span class="mtk8">import</span>',
      "",
      '<span class="mtk1">x</span>',
      "",
    ]);
  });
});
