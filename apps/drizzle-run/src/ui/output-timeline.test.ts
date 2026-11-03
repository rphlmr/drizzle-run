import type { Dialect } from "@drizzle-run/core/catalog";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatProblemForCopy, OutputTimeline } from "./output-timeline";
import type { TimelineProblem } from "./run-timeline";

const failedQuery = {
  kind: "error",
  phase: "run",
  message: 'Failed query: update "accounts" set "balance" = $1\nparams: 70',
  location: { severity: "error", message: "Failed query", source: "query.ts", line: 7, column: 9 },
  query: 'relation "accounts" does not exist',
} satisfies TimelineProblem;

describe("formatProblemForCopy", () => {
  it("should copy the kind, the message and where the run failed", () => {
    const text = formatProblemForCopy({
      kind: "error",
      phase: "run",
      message: 'relation "accounts" does not exist',
      location: {
        severity: "error",
        message: 'relation "accounts" does not exist',
        source: "query.ts",
        line: 7,
        column: 9,
      },
    });

    expect(text).toBe('Run error: relation "accounts" does not exist\n    at query.ts:7:9');
  });

  it("should copy only the kind and message when the problem names no file", () => {
    expect(formatProblemForCopy({ kind: "thrown", message: "Runtime crashed" })).toBe("Run error: Runtime crashed");
  });

  it("should copy a diagnostic with its severity as the kind", () => {
    const text = formatProblemForCopy({
      kind: "diagnostic",
      diagnostic: { severity: "warning", message: "Unused import", source: "schema.ts", line: 2, column: 1 },
    });

    expect(text).toBe("Warning: Unused import\n    at schema.ts:2:1");
  });

  it("should copy a query error with what the database said, then the full error with its SQL", () => {
    expect(formatProblemForCopy(failedQuery, "postgresql")).toBe(
      [
        'Query error: relation "accounts" does not exist',
        "    at query.ts:7:9",
        "",
        'Failed query: update "accounts" set "balance" = $1',
        "params: 70",
      ].join("\n"),
    );
  });
});

const renderProblem = (problem: TimelineProblem, dialect: Dialect = "postgresql") =>
  renderToStaticMarkup(
    createElement(OutputTimeline, {
      rows: [{ key: "error", kind: "problem", problem }],
      filter: "problems",
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
      dialect,
      onDiagnostic: () => undefined,
    }),
  );

describe("OutputTimeline problems", () => {
  it("should show a known query error with the database's message, a hint and the file it names", () => {
    const html = renderProblem(failedQuery);

    expect(html).toContain(">Query error<");
    expect(html).toContain("relation &quot;accounts&quot; does not exist");
    expect(html).toContain("The table wasn&#x27;t created for this run. Check that <code");
    expect(html).toMatch(/>schema\.ts<\/code> exports it\./);
    expect(html).toContain("Open schema.ts");
    expect(html).toContain("Show in code");
  });

  it("should keep the plain card for a database message no hint knows", () => {
    const html = renderProblem({ ...failedQuery, query: "canceling statement due to user request" });

    expect(html).toContain(">Run error<");
    expect(html).toContain("Failed query:");
    expect(html).not.toContain("Open schema.ts");
  });
});
