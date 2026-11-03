import type { DisplayResult, RunResult } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  EMBED_MAX_RUN_DISPLAYS_BYTES,
  EMBED_MAX_RUN_ERROR_LENGTH,
  getEmbedJsonByteLength,
  parseEmbedFrameMessage,
} from "../embed-loader/protocol";
import { toEmbedRunSummary } from "./run-summary";

function makeDisplay({ label = "Users", text = "Ada" }: { label?: string; text?: string } = {}): DisplayResult {
  return { label, values: [{ type: "primitive", value: text }], source: "query.ts", line: 3 };
}

/** The fields of a run result the summary reads. */
function makeResult({
  displays = [makeDisplay()],
  diagnostics = [],
}: {
  displays?: DisplayResult[];
  diagnostics?: RunResult["diagnostics"];
} = {}): Pick<RunResult, "displays" | "diagnostics"> {
  return { displays, diagnostics };
}

describe("toEmbedRunSummary", () => {
  it("should carry a succeeded run's display labels and values, without their source", () => {
    expect(toEmbedRunSummary({ outcome: "succeeded", result: makeResult() })).toEqual({
      outcome: "succeeded",
      displays: [{ label: "Users", values: [{ type: "primitive", value: "Ada" }] }],
      truncated: false,
    });
  });

  it("should name the side of a side-by-side run", () => {
    expect(toEmbedRunSummary({ outcome: "cancelled" }, 1)).toEqual({
      outcome: "cancelled",
      side: 1,
      displays: [],
      truncated: false,
    });
  });

  it("should give a failed run its error, its first error diagnostic, or a fallback", () => {
    const diagnostics = [
      { severity: "warning", message: "unused import" },
      { severity: "error", message: "no such table: users" },
    ] satisfies RunResult["diagnostics"];

    expect(toEmbedRunSummary({ outcome: "failed", error: "The worker crashed." }).error).toBe("The worker crashed.");
    expect(toEmbedRunSummary({ outcome: "failed", result: makeResult({ diagnostics }) }).error).toBe(
      "no such table: users",
    );
    expect(toEmbedRunSummary({ outcome: "failed" }).error).toBe("The run failed.");
    expect(toEmbedRunSummary({ outcome: "succeeded", error: "ignored" }).error).toBeUndefined();
  });

  it("should truncate a long error to the protocol's limit", () => {
    const { error } = toEmbedRunSummary({ outcome: "failed", error: "x".repeat(EMBED_MAX_RUN_ERROR_LENGTH * 2) });

    expect(error).toHaveLength(EMBED_MAX_RUN_ERROR_LENGTH);
    expect(error?.endsWith("…")).toBe(true);
  });

  it("should not cut an emoji in half when truncating an error", () => {
    const message = `${"x".repeat(EMBED_MAX_RUN_ERROR_LENGTH - 2)}🙂${"x".repeat(10)}`;
    const { error } = toEmbedRunSummary({ outcome: "failed", error: message });

    expect(error).toBe(`${"x".repeat(EMBED_MAX_RUN_ERROR_LENGTH - 2)}…`);
    expect(error?.isWellFormed()).toBe(true);
  });

  it("should drop the displays past the JSON budget, keep the ones before, and pass the loader's parser", () => {
    const large = "y".repeat(EMBED_MAX_RUN_DISPLAYS_BYTES / 3);
    const displays = [
      makeDisplay({ label: "first", text: large }),
      makeDisplay({ label: "second", text: large }),
      makeDisplay({ label: "third", text: large }),
      makeDisplay({ label: "small" }),
    ];

    const run = toEmbedRunSummary({ outcome: "succeeded", result: makeResult({ displays }) });

    expect(run.displays.map((display) => display.label)).toEqual(["first", "second"]);
    expect(run.truncated).toBe(true);
    expect(getEmbedJsonByteLength(run.displays)).toBeLessThanOrEqual(EMBED_MAX_RUN_DISPLAYS_BYTES);
    expect(
      parseEmbedFrameMessage({
        protocol: "drizzle-run-embed",
        version: 1,
        kind: "run-settled",
        nonce: "a".repeat(32),
        run,
      }),
    ).not.toBeNull();
  });
});
