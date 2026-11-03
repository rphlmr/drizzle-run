import { omit } from "es-toolkit";
import { describe, expect, expectTypeOf, it } from "vitest";

import { safeParseCheckSpec, type CheckSpec } from "../checks/index.ts";
import { defineRunManifest } from "../manifest/define.ts";
import { createPairManifest } from "../pair/operations.ts";
import { resolveSupportedTuple } from "../registry/selectors.ts";
import {
  applyEdits,
  defineGuideManifest,
  diffRunResults,
  GuideEditError,
  GuideManifestValidationError,
  isGuideHref,
  isPairProject,
  parseGuideManifest,
  parseRichText,
  projectFiles,
  resolveStep,
  safeParseGuideManifest,
  type GuideManifestIssue,
  type GuideStep,
} from "./index.ts";
import { readStepBase, STEP_KINDS, type StepKindDefinition } from "./step-kinds.ts";
import type { GuideStepBase } from "./types.ts";
import { createGuideManifestParser } from "./validation.ts";

const project = defineRunManifest({
  kind: "drizzle-run",
  manifestVersion: 1,
  target: { dialect: "postgresql" },
  dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
  files: {
    "schema.ts": [
      'import { pgTable, integer } from "drizzle-orm/pg-core";',
      "",
      'export const accounts = pgTable("accounts", { id: integer("id") });',
      "",
    ].join("\n"),
    "query.ts": 'import { db } from "@drizzle-run/runtime/context";\n\n// transfer\n',
  },
  entrypoints: { schema: "schema.ts", run: "query.ts" },
});

/** A walkthrough guide with optional fields. */
const guide = {
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "transactions",
  title: "Move money",
  project,
  steps: [
    {
      type: "walkthrough",
      id: "01-transfer",
      label: "Transfer",
      title: "Move 30 from Ada to Grace",
      body: [
        "Both updates commit **together**, or not at all. Press `Run`.",
        "See [the docs](https://orm.drizzle.team/docs/transactions).",
      ].join("\n\n"),
      edits: [
        {
          file: "query.ts",
          replace: { anchor: "// transfer", with: "await db.transaction(async () => {});" },
        },
      ],
      focus: { file: "query.ts", lines: [3, 3] },
      run: "required",
      highlight: { displays: ["Balances"] },
      links: [{ label: "Transactions docs", href: "https://orm.drizzle.team/docs/transactions" }],
      meta: { points: 10, tags: ["money"] },
    },
    {
      type: "walkthrough",
      id: "02-helper",
      label: "Helper",
      title: "Add a helper",
      body: "A new file.",
      edits: [{ file: "helpers.ts", write: "export const cents = (value: number) => value * 100;\n" }],
      focus: { file: "helpers.ts", lines: [1, 1] },
      run: "none",
    },
  ],
  meta: { course: "DB-101", nested: { keep: [1, 2, 3] } },
} as const;

function getIssueCodes(issues: readonly GuideManifestIssue[]) {
  return issues.map((issue) => issue.code);
}

/** Parse a guide expected to fail, and get its issues. */
function getParseIssues(input: unknown): readonly GuideManifestIssue[] {
  const result = safeParseGuideManifest(input);

  expect(result.success).toBe(false);

  return result.success ? [] : result.issues;
}

function makeGuideWithEdit(file: string, anchor: string) {
  return { ...guide, steps: [{ ...guide.steps[0], edits: [{ file, replace: { anchor, with: "" } }] }] };
}

describe("guide manifest", () => {
  it("should parse a walkthrough guide", () => {
    const parsed = parseGuideManifest(guide);

    expect(parsed.id).toBe("transactions");
    expect(parsed.steps.map((step) => step.id)).toEqual(["01-transfer", "02-helper"]);
    expect(parsed.project).toEqual(project);
  });

  it("should keep meta untouched on the guide and its steps", () => {
    const parsed = parseGuideManifest(guide);

    expect(parsed.meta).toBe(guide.meta);
    expect(parsed.steps[0].meta).toBe(guide.steps[0].meta);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(JSON.stringify(guide)));
  });

  it("should reject unknown fields with UNKNOWN_FIELD, at the top level and in steps", () => {
    const issues = getParseIssues({ ...guide, color: "lime", steps: [{ ...guide.steps[0], points: 3 }] });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_FIELD", path: ["color"] }),
        expect.objectContaining({ code: "UNKNOWN_FIELD", path: ["steps", 0, "points"] }),
      ]),
    );
  });

  it("should read the optional assistant context on the guide and its steps", () => {
    const assistant = {
      notes: "A savepoint is part of the outer transaction.",
      sources: [{ label: "Docs index", href: "https://orm.drizzle.team/llms.txt" }],
    };
    const stepAssistant = {
      sources: [{ label: "Transactions", href: "https://orm.drizzle.team/docs/transactions" }],
    };
    const parsed = parseGuideManifest({
      ...guide,
      assistant,
      steps: [{ ...guide.steps[0], assistant: stepAssistant }, guide.steps[1]],
    });

    expect(parsed.assistant).toEqual(assistant);
    expect(parsed.steps[0].assistant).toEqual(stepAssistant);
    expect(parsed.steps[1]).not.toHaveProperty("assistant");
    expect(parseGuideManifest(guide).assistant).toBeUndefined();
  });

  it("should validate assistant like any other field", () => {
    const issues = getParseIssues({
      ...guide,
      assistant: { notes: "", tone: "kind", sources: [{ label: "Plain", href: "http://example.com" }] },
      steps: [{ ...guide.steps[0], assistant: { notes: "x".repeat(4_001) } }, guide.steps[1]],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_FIELD", path: ["assistant", "tone"] }),
        expect.objectContaining({ code: "INVALID_VALUE", path: ["assistant", "notes"] }),
        expect.objectContaining({ code: "INVALID_VALUE", path: ["assistant", "sources", 0, "href"] }),
        expect.objectContaining({ code: "INVALID_VALUE", path: ["steps", 0, "assistant", "notes"] }),
      ]),
    );
    expect(getIssueCodes(getParseIssues({ ...guide, assistant: "notes" }))).toEqual(["INVALID_TYPE"]);
  });

  it("should report meta that is not a plain object, on the guide and its steps", () => {
    const issues = getParseIssues({ ...guide, meta: 1, steps: [{ ...guide.steps[0], meta: "points" }] });

    expect(issues).toEqual([
      expect.objectContaining({ code: "INVALID_TYPE", path: ["meta"] }),
      expect.objectContaining({ code: "INVALID_TYPE", path: ["steps", 0, "meta"] }),
    ]);
  });

  it("should reject an unknown step kind with UNSUPPORTED_STEP_KIND", () => {
    const issues = getParseIssues({ ...guide, steps: [{ ...guide.steps[0], type: "exercise" }] });

    expect(issues).toEqual([expect.objectContaining({ code: "UNSUPPORTED_STEP_KIND", path: ["steps", 0, "type"] })]);
  });

  it("should reject a newer manifest version with UNSUPPORTED_VERSION alone", () => {
    const issues = getParseIssues({ ...guide, manifestVersion: 2, somethingNew: true });

    expect(issues).toEqual([expect.objectContaining({ code: "UNSUPPORTED_VERSION", path: ["manifestVersion"] })]);
  });

  it("should report the run manifest issues of the project under project", () => {
    const issues = getParseIssues({
      ...guide,
      project: { ...project, dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "0.31.11" } },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_COMBINATION", path: ["project", "dependencies"] }),
      ]),
    );
  });

  it("should replay edits: an anchor must match exactly once, in a file that exists", () => {
    expect(getParseIssues(makeGuideWithEdit("query.ts", "// missing"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EDIT_CONFLICT", path: ["steps", 0, "edits", 0] })]),
    );
    expect(getParseIssues(makeGuideWithEdit("query.ts", "o"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EDIT_CONFLICT", path: ["steps", 0, "edits", 0] })]),
    );
    expect(getParseIssues(makeGuideWithEdit("nope.ts", "a"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_FILE", path: ["steps", 0, "edits", 0] })]),
    );
  });

  it("should report an edit or focus on a name that is not a project file, such as an object key", () => {
    for (const file of ["toString", "__proto__", "constructor"]) {
      const withFocus = { ...guide, steps: [{ ...guide.steps[0], focus: { file, lines: [1, 1] } }] };

      expect(getParseIssues(makeGuideWithEdit(file, "a")), file).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "INVALID_VALUE" })]),
      );
      expect(getParseIssues(withFocus), file).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "INVALID_VALUE" })]),
      );
    }
  });

  it("should check focus against the files at that step", () => {
    const step = guide.steps[1];
    const outOfRangeFocus = { ...guide, steps: [{ ...step, focus: { file: "helpers.ts", lines: [1, 9] } }] };
    const missingFileFocus = {
      ...guide,
      steps: [{ ...step, edits: undefined, focus: { file: "helpers.ts", lines: [1, 1] } }],
    };

    expect(getParseIssues(outOfRangeFocus)).toEqual([
      expect.objectContaining({ code: "INVALID_VALUE", path: ["steps", 0, "focus", "lines"] }),
    ]);
    expect(getParseIssues(missingFileFocus)).toEqual([
      expect.objectContaining({ code: "MISSING_FILE", path: ["steps", 0, "focus", "file"] }),
    ]);
  });

  it("should require unique step ids, a run policy, and safe body text", () => {
    const issues = getParseIssues({
      ...guide,
      steps: [guide.steps[0], { ...guide.steps[1], id: "01-transfer", run: "always", body: "an `open span" }],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_ID", path: ["steps", 1, "id"] }),
        expect.objectContaining({ code: "INVALID_VALUE", path: ["steps", 1, "run"] }),
        expect.objectContaining({ code: "INVALID_VALUE", path: ["steps", 1, "body"] }),
      ]),
    );
  });

  it("should format each issue path in the thrown error", () => {
    const expectedError = new GuideManifestValidationError([
      {
        path: ["steps", 0, "run"],
        code: "INVALID_VALUE",
        message: "Expected one of required, optional, none.",
      },
    ]);

    expect(() => parseGuideManifest({ ...guide, steps: [{ ...guide.steps[0], run: "sometimes" }] })).toThrowError(
      expectedError,
    );
    expect(() => parseGuideManifest({ ...guide, steps: [] })).toThrow('$["steps"]: A guide needs at least one step.');
  });

  it("should keep literal types in defineGuideManifest and validate at runtime", () => {
    const defined = defineGuideManifest(guide);

    expectTypeOf(defined.id).toEqualTypeOf<"transactions">();
    expect(() => defineGuideManifest({ ...guide, id: "Not a slug" })).toThrow(GuideManifestValidationError);
    expect(() =>
      defineGuideManifest({
        ...guide,
        // @ts-expect-error an older Legacy fix release is not a supported pair.
        project: { ...project, dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
      }),
    ).toThrow("changes when parsed at project.dependencies.drizzle-kit, most likely because it pins an older Legacy");
    expect(defineGuideManifest({ ...guide, project: { ...project, guestFlavor: "slim" } }).project).toMatchObject({
      guestFlavor: "slim",
    });

    expect(() =>
      // @ts-expect-error focus names a file that no edit or project file provides.
      defineGuideManifest({ ...guide, steps: [{ ...guide.steps[1], focus: { file: "ghost.ts", lines: [1, 1] } }] }),
    ).toThrow('$["steps"][0]["focus"]["file"]: ghost.ts does not exist at this step.');

    const typed = defineGuideManifest<{ course: string }, { points?: number }>();

    // @ts-expect-error course must be text.
    expect(() => typed({ ...guide, meta: { course: 101 } })).not.toThrow();
  });
});

describe("extension safety", () => {
  interface ExerciseStep extends GuideStepBase {
    readonly type: "exercise";
    readonly checks: readonly CheckSpec[];
  }

  /** A test-only kind that checks extension of the step union. */
  const exerciseStepKind: StepKindDefinition<ExerciseStep> = {
    type: "exercise",
    read(record, { path, project: guideProject, report }) {
      const base = readStepBase(record, path, report);
      const checks: CheckSpec[] = [];

      for (const [index, value] of (Array.isArray(record.checks) ? record.checks : []).entries()) {
        const result = safeParseCheckSpec(value, [...path, "checks", index]);

        if (result.success) {
          checks.push(result.data);
        } else {
          for (const issue of result.issues) {
            report(issue.path, issue.code, issue.message);
          }
        }
      }

      const { id, label, title, body } = base;

      return {
        step: id && label && title && body ? { type: "exercise", id, label, title, body, checks } : undefined,
        project: guideProject,
      };
    },
  };
  const parseWithExercise = createGuideManifestParser<GuideStep | ExerciseStep>([...STEP_KINDS, exerciseStepKind]);
  const exercise = {
    type: "exercise",
    id: "03-try",
    label: "Try",
    title: "Your turn",
    body: "Write it.",
    checks: [{ type: "noError" }],
  };

  it("should still parse a walkthrough guide written today after a new kind joins the union", () => {
    const result = parseWithExercise(guide);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(parseGuideManifest(guide));
  });

  it("should parse the new kind next to walkthrough steps", () => {
    const result = parseWithExercise({ ...guide, steps: [...guide.steps, exercise] });

    expect(result.success && result.data.steps.map((step) => step.type)).toEqual([
      "walkthrough",
      "walkthrough",
      "exercise",
    ]);
  });

  it("should report UNSUPPORTED_CHECK for a check type this version does not know", () => {
    const result = parseWithExercise({
      ...guide,
      steps: [{ ...exercise, checks: [{ type: "passesCertification" }] }],
    });

    expect(result.success).toBe(false);
    expect(!result.success && getIssueCodes(result.issues)).toEqual(["UNSUPPORTED_CHECK"]);
    expect(!result.success && result.issues[0].path).toEqual(["steps", 0, "checks", 0, "type"]);
  });

  it("should refuse the new kind clearly in a core version without it", () => {
    const issues = getParseIssues({ ...guide, steps: [...guide.steps, exercise] });

    expect(getIssueCodes(issues)).toEqual(["UNSUPPORTED_STEP_KIND"]);
  });

  it("should report a step that is not a plain object before any kind reads it", () => {
    const issues = getParseIssues({ ...guide, steps: [[]] });

    expect(issues).toEqual([expect.objectContaining({ code: "INVALID_TYPE", path: ["steps", 0] })]);
  });
});

describe("resolveStep and applyEdits", () => {
  it("should return the project before and after each step, ready to run", () => {
    const parsed = parseGuideManifest(guide);
    const first = resolveStep(parsed, 0);
    const second = resolveStep(parsed, 1);

    expect(first.previous).toEqual(project);
    expect(projectFiles(first.project)["query.ts"]).toContain("await db.transaction");
    expect(second.previous).toEqual(first.project);
    expect(Object.keys(projectFiles(second.project)).toSorted()).toEqual(["helpers.ts", "query.ts", "schema.ts"]);
    expect(second.project).toEqual({ ...project, files: projectFiles(second.project) });
    expect(() => resolveStep(parsed, 2)).toThrow(RangeError);
  });

  it("should not mutate its input and should name the failing edit", () => {
    const files = { "a.ts": "one two" };

    const edited = applyEdits(files, [{ file: "a.ts", replace: { anchor: "two", with: "$& three" } }]);

    expect(edited).toEqual({ "a.ts": "one $& three" });
    expect(files).toEqual({ "a.ts": "one two" });
    expect(() =>
      applyEdits(files, [
        { file: "a.ts", write: "x" },
        { file: "a.ts", replace: { anchor: "two", with: "" } },
      ]),
    ).toThrowError(expect.objectContaining({ name: "GuideEditError", index: 1, reason: "ANCHOR_NOT_FOUND" }));
    expect(new GuideEditError(0, "a.ts", "ANCHOR_NOT_UNIQUE").message).toContain("more than once");
  });
});

describe("rich text", () => {
  it("should parse paragraphs, code, bold, and links", () => {
    const text = [
      "Press **Run**, then read `rows`.",
      "See [docs](https://orm.drizzle.team) or [joins](/examples/joins).",
    ].join("\n\n");

    expect(parseRichText(text)).toEqual([
      [
        { kind: "text", text: "Press " },
        { kind: "bold", text: "Run" },
        { kind: "text", text: ", then read " },
        { kind: "code", text: "rows" },
        { kind: "text", text: "." },
      ],
      [
        { kind: "text", text: "See " },
        { kind: "link", text: "docs", href: "https://orm.drizzle.team" },
        { kind: "text", text: " or " },
        { kind: "link", text: "joins", href: "/examples/joins" },
        { kind: "text", text: "." },
      ],
    ]);
  });

  it("should refuse unsafe links and unclosed spans", () => {
    expect(() => parseRichText("[x](javascript:alert(1))")).toThrow("https URL");
    expect(() => parseRichText("[x](//evil.example)")).toThrow("https URL");
    expect(isGuideHref("/examples/joins")).toBe(true);
    expect(isGuideHref("/\t/evil.example")).toBe(false);
    expect(isGuideHref("/\n/evil.example")).toBe(false);
    expect(() => parseRichText("**open")).toThrow("not closed");
  });
});

function primitive(value: string | number) {
  return { type: "primitive", value } as const;
}

function makeRowValue(id: number, name: string, balance: number) {
  return {
    type: "object",
    value: { id: primitive(id), name: primitive(name), balance: primitive(balance) },
  } as const;
}

function makeTableValue(...rows: ReturnType<typeof makeRowValue>[]) {
  return { type: "array", value: rows } as const;
}

describe("diffRunResults", () => {
  it("should match rows by id and report added, removed, and changed rows per label", () => {
    const previous = {
      displays: [
        {
          label: "Balances",
          values: [
            makeTableValue(makeRowValue(1, "Ada", 100), makeRowValue(2, "Grace", 50), makeRowValue(3, "Linus", 0)),
          ],
        },
        { label: "Old", values: [primitive(1)] },
      ],
    };
    const current = {
      displays: [
        {
          label: "Balances",
          values: [
            makeTableValue(makeRowValue(1, "Ada", 70), makeRowValue(2, "Grace", 50), makeRowValue(4, "Joan", 5)),
          ],
        },
        { label: "Count", values: [primitive(3)] },
      ],
    };

    const diff = diffRunResults(previous, current);

    expect(diff.changed).toBe(true);
    expect(diff.displays.map((display) => [display.label, display.status])).toEqual([
      ["Balances", "changed"],
      ["Count", "added"],
      ["Old", "removed"],
    ]);
    expect(diff.displays[0]).toMatchObject({
      added: [makeRowValue(4, "Joan", 5)],
      removed: [makeRowValue(3, "Linus", 0)],
      changed: [{ before: makeRowValue(1, "Ada", 100), after: makeRowValue(1, "Ada", 70) }],
      unchanged: 1,
    });
  });

  it("should compare rows without ids as values, and treat a first run as all added", () => {
    const values = {
      displays: [{ label: "Names", values: [{ type: "array", value: [primitive("a"), primitive("b")] }] }],
    } as const;
    const more = {
      displays: [
        {
          label: "Names",
          values: [{ type: "array", value: [primitive("a"), primitive("b"), primitive("b")] }],
        },
      ],
    } as const;

    expect(diffRunResults(values, values)).toEqual({
      displays: [{ label: "Names", status: "same", added: [], removed: [], changed: [], unchanged: 2 }],
      changed: false,
    });
    expect(diffRunResults(values, more).displays[0]).toMatchObject({
      status: "changed",
      added: [primitive("b")],
      unchanged: 2,
    });
    expect(diffRunResults(undefined, values).displays[0]).toMatchObject({
      status: "added",
      added: [primitive("a"), primitive("b")],
    });
  });
});

describe("side-by-side guides", () => {
  const pairProject = createPairManifest(
    project,
    [
      resolveSupportedTuple({ target: { dialect: "postgresql" }, ormVersion: "0.45.4", kitVersion: "0.31.11" }),
      resolveSupportedTuple({
        target: { dialect: "postgresql" },
        ormVersion: "1.0.0-rc.5",
        kitVersion: "1.0.0-rc.5",
      }),
    ],
    "separate",
  );
  const pairGuide = {
    kind: "drizzle-run-guide",
    manifestVersion: 1,
    id: "pair",
    title: "Both sides",
    project: pairProject,
    steps: [
      {
        type: "walkthrough",
        id: "01-sides",
        label: "Sides",
        title: "One change per side",
        body: "Each side changes its own copy.",
        edits: [
          { file: "query.ts", side: 0, replace: { anchor: "// transfer", with: "// legacy" } },
          { file: "query.ts", side: 1, replace: { anchor: "// transfer", with: "// next" } },
        ],
        focus: { file: "query.ts", lines: [3, 3], side: 1 },
        run: "required",
      },
    ],
  };

  it("should apply each edit to its side's copy", () => {
    const parsed = parseGuideManifest(pairGuide);
    const { project: resolved } = resolveStep(parsed, 0);

    expect(projectFiles(resolved, 0)["query.ts"]).toContain("// legacy");
    expect(projectFiles(resolved, 1)["query.ts"]).toContain("// next");
    expect(parsed.steps[0]?.focus).toEqual({ file: "query.ts", lines: [3, 3], side: 1 });
  });

  it("should need a side for a per-side file and refuse one elsewhere", () => {
    const step = pairGuide.steps[0];

    function makePairGuideWithEdits(edits: readonly unknown[], focus: unknown = step?.focus) {
      return { ...pairGuide, steps: [{ ...step, edits, focus }] };
    }

    const unsidedEdit = { file: "query.ts", replace: { anchor: "// transfer", with: "" } };
    const sharedFileEdit = { ...guide.steps[0].edits[0], side: 0 };

    expect(getParseIssues(makePairGuideWithEdits([unsidedEdit]))).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "edits", 0], code: "EDIT_CONFLICT" }),
    );
    expect(getParseIssues(makePairGuideWithEdits([], { file: "query.ts", lines: [1, 1] }))).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "focus", "side"] }),
    );
    expect(getParseIssues({ ...guide, steps: [{ ...guide.steps[0], edits: [sharedFileEdit] }] })).toContainEqual(
      expect.objectContaining({ code: "EDIT_CONFLICT" }),
    );
  });
});

function makeStep(id: string, fields: Record<string, unknown> = {}) {
  return { type: "walkthrough", id, label: id, title: id, body: "A step.", run: "required", ...fields };
}

describe("split and merge", () => {
  const next = { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" } as const;
  const legacy = { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" } as const;
  const seeded = defineRunManifest({
    ...project,
    dependencies: next,
    files: { ...project.files, "seed.ts": 'import { db } from "@drizzle-run/runtime/context";\n' },
    entrypoints: { ...project.entrypoints, seed: "seed.ts" },
  });

  function makeGuide(steps: readonly unknown[], start: unknown = seeded) {
    return { ...guide, project: start, steps };
  }

  const sqlLike = { name: "SQL-like" };
  const rqb = { name: "RQB" };
  const comparison = makeGuide([
    makeStep("01-one"),
    makeStep("02-split", {
      split: { sides: [sqlLike, rqb], files: ["query.ts"] },
      edits: [
        { file: "schema.ts", write: "// relations\n" },
        { file: "query.ts", side: 1, replace: { anchor: "// transfer", with: "// rqb" } },
      ],
      focus: { file: "query.ts", lines: [3, 3], side: 1 },
    }),
    makeStep("03-pair", { edits: [{ file: "query.ts", side: 0, replace: { anchor: "// transfer", with: "// sql" } }] }),
    makeStep("04-merge", { merge: { keep: 1 } }),
  ]);

  it("should open two named sides on the project's release, with only the split files per side", () => {
    const parsed = parseGuideManifest(comparison);
    const { previous, project: pair } = resolveStep(parsed, 1);

    expect(isPairProject(previous)).toBe(false);
    expect(isPairProject(pair) && pair.sides.map((side) => [side.name, side.dependencies])).toEqual([
      ["SQL-like", next],
      ["RQB", next],
    ]);
    expect(isPairProject(pair) && Object.keys(pair.files).toSorted()).toEqual(["schema.ts", "seed.ts"]);
    expect(projectFiles(pair, 0)["query.ts"]).toContain("// transfer");
    expect(projectFiles(pair, 1)["query.ts"]).toContain("// rqb");
    expect(projectFiles(pair, 1)["schema.ts"]).toBe("// relations\n");
    expect(parsed.steps[1]).toMatchObject({ split: { sides: [sqlLike, rqb], files: ["query.ts"] } });
  });

  it("should open a guide on an older Legacy release, its project and split sides, on the current Legacy pair", () => {
    const olderLegacy = { "drizzle-orm": "0.45.1", "drizzle-kit": "0.31.8" };
    const older = makeGuide(
      [
        makeStep("01-one"),
        makeStep("02-split", {
          split: { sides: [{}, { name: "Legacy", dependencies: olderLegacy }], files: ["query.ts"] },
        }),
      ],
      { ...seeded, dependencies: olderLegacy },
    );
    const parsed = parseGuideManifest(older);
    const pair = resolveStep(parsed, 1).project;

    expect(parsed.project).toMatchObject({ dependencies: legacy });
    expect(isPairProject(pair) && pair.sides.map((side) => side.dependencies)).toEqual([legacy, legacy]);
  });

  it("should still report a guide pinned to a Next release the catalog no longer ships", () => {
    const removedNext = { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" };
    const result = safeParseGuideManifest(makeGuide([makeStep("01-one")], { ...seeded, dependencies: removedNext }));

    expect(result.success).toBe(false);
  });

  it("should keep the sides across steps until a merge keeps one", () => {
    const parsed = parseGuideManifest(comparison);
    const sideBySide = resolveStep(parsed, 2).project;
    const merged = resolveStep(parsed, 3).project;

    expect(projectFiles(sideBySide, 0)["query.ts"]).toContain("// sql");
    expect(merged).toEqual({
      ...seeded,
      files: { ...seeded.files, "schema.ts": "// relations\n", "query.ts": projectFiles(sideBySide, 1)["query.ts"] },
    });
  });

  it("should split again after a merge, and merge a side-by-side guide", () => {
    const again = makeGuide([
      ...comparison.steps,
      makeStep("05-split", { split: { sides: [{}, { name: "Next" }], files: ["schema.ts"] } }),
    ]);
    const pairGuide = makeGuide(
      [makeStep("01-merge", { merge: { keep: 0 } })],
      resolveStep(parseGuideManifest(comparison), 1).project,
    );

    expect(isPairProject(resolveStep(parseGuideManifest(again), 4).project)).toBe(true);
    expect(isPairProject(resolveStep(parseGuideManifest(pairGuide), 0).project)).toBe(false);
  });

  it("should open sides on two releases, as the relational queries guide compares them", () => {
    const legacyFiles = { "schema.ts": "// relations()\n", "query.ts": "// db.query, 0.45 style\n" };
    const parsed = parseGuideManifest(
      makeGuide([
        makeStep("01-compare", {
          split: { sides: [{ dependencies: legacy }, {}], files: ["schema.ts", "query.ts"] },
          edits: [
            { file: "schema.ts", side: 0, write: legacyFiles["schema.ts"] },
            { file: "query.ts", side: 0, write: legacyFiles["query.ts"] },
          ],
        }),
      ]),
    );
    const handBuilt = createPairManifest(
      seeded,
      [
        resolveSupportedTuple({ target: seeded.target, ormVersion: "0.45.4", kitVersion: "0.31.11" }),
        resolveSupportedTuple({ target: seeded.target, ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" }),
      ],
      "separate",
    );

    expect(resolveStep(parsed, 0).project).toEqual({
      ...handBuilt,
      sides: [{ ...handBuilt.sides[0], files: legacyFiles }, handBuilt.sides[1]],
    });
  });

  it("should report a split or merge that does not fit the project", () => {
    const pairStart = resolveStep(parseGuideManifest(comparison), 1).project;
    const split = { sides: [sqlLike, rqb], files: ["query.ts"] };

    expect(getParseIssues(makeGuide([makeStep("01-split", { split })], pairStart))).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split"], code: "SPLIT_NOT_ONE_VERSION" }),
    );
    expect(getParseIssues(makeGuide([makeStep("01-merge", { merge: { keep: 0 } })]))).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "merge"], code: "MERGE_NOT_PAIR" }),
    );
    expect(getParseIssues(makeGuide([makeStep("01-both", { split, merge: { keep: 0 } })]))).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split"], code: "SPLIT_AND_MERGE" }),
    );
  });

  function getSplitIssues(split: unknown) {
    return getParseIssues(makeGuide([makeStep("01-split", { split })]));
  }

  it("should report split files that are missing or the seed, and sides that cannot run", () => {
    expect(getSplitIssues({ sides: [sqlLike, rqb], files: ["missing.ts"] })).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split", "files", 0], code: "MISSING_FILE" }),
    );
    expect(getSplitIssues({ sides: [sqlLike, rqb], files: ["query.ts", "seed.ts"] })).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split", "files", 1], code: "INVALID_VALUE" }),
    );
    expect(getSplitIssues({ sides: [{ name: " padded" }, rqb], files: ["query.ts"] })).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split", "sides", 0, "name"] }),
    );
    expect(
      getSplitIssues({ sides: [{ dependencies: { "drizzle-orm": "0.1.0" } }, rqb], files: ["query.ts"] }),
    ).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split", "sides", 0, "dependencies"], code: "INVALID_VALUE" }),
    );
    expect(getSplitIssues({ sides: [sqlLike], files: [] })).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split", "sides"], code: "INVALID_VALUE" }),
    );
  });

  it("should report every split file that is listed twice or not canonical, not only the first", () => {
    const issues = getSplitIssues({ sides: [sqlLike, rqb], files: ["query.ts", "query.ts", "../schema.ts"] });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["steps", 0, "split", "files", 1], code: "INVALID_VALUE" }),
        expect.objectContaining({ path: ["steps", 0, "split", "files", 2], code: "NON_CANONICAL_PATH" }),
      ]),
    );
  });

  it("should refuse to split a project whose seed is not seed.ts, with the same words as a new side by side", () => {
    const renamed = {
      ...seeded,
      files: { ...omit(seeded.files, ["seed.ts"]), "db/seed.ts": seeded.files["seed.ts"] },
      entrypoints: { ...seeded.entrypoints, seed: "db/seed.ts" },
    };

    expect(
      getParseIssues(
        makeGuide([makeStep("01-split", { split: { sides: [sqlLike, rqb], files: ["query.ts"] } })], renamed),
      ),
    ).toContainEqual({
      path: ["steps", 0, "split"],
      code: "INVALID_VALUE",
      message: "A side-by-side project seeds from seed.ts: rename db/seed.ts to seed.ts first.",
    });
  });

  it("should write a pair issue as the end of its split sentence, keeping names capitalized", () => {
    const messages = getSplitIssues({ sides: [{ name: " padded" }, rqb], files: ["query.ts"] }).map(
      (issue) => issue.message,
    );
    const crossLine = getSplitIssues({ sides: [{ dependencies: legacy }, {}], files: ["query.ts"] }).map(
      (issue) => issue.message,
    );

    expect(messages.some((message) => message.startsWith("When this step splits, a side's name"))).toBe(true);
    expect(crossLine.every((message) => /^When this step splits, [a-z]/.test(message))).toBe(true);
  });

  it("should report a split across release lines that leaves a file shared", () => {
    expect(getSplitIssues({ sides: [{ dependencies: legacy }, {}], files: ["query.ts"] })).toContainEqual(
      expect.objectContaining({
        path: ["steps", 0, "split"],
        code: "INVALID_VALUE",
        message: expect.stringContaining("schema.ts is shared, but a Legacy side and a Next side share only the seed"),
      }),
    );
    expect(
      safeParseGuideManifest(
        makeGuide([
          makeStep("01-split", { split: { sides: [{ dependencies: legacy }, {}], files: ["schema.ts", "query.ts"] } }),
        ]),
      ).success,
    ).toBe(true);
  });

  it("should open sides on two databases, each side with its own schema", () => {
    const sqliteSchema = 'import { sqliteTable } from "drizzle-orm/sqlite-core";\n';
    const parsed = parseGuideManifest(
      makeGuide([
        makeStep("01-compare", {
          split: { sides: [{}, { target: { dialect: "sqlite" } }], files: ["schema.ts"] },
          edits: [{ file: "schema.ts", side: 1, write: sqliteSchema }],
        }),
      ]),
    );
    const { project: pair } = resolveStep(parsed, 0);

    expect(isPairProject(pair) && pair.sides.map((side) => side.target)).toEqual([
      seeded.target,
      { dialect: "sqlite" },
    ]);
    expect(projectFiles(pair, 1)["schema.ts"]).toBe(sqliteSchema);
    expect(getSplitIssues({ sides: [{}, { target: { dialect: "sqlite" } }], files: ["query.ts"] })).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split"], code: "INVALID_VALUE" }),
    );
    expect(getSplitIssues({ sides: [{}, { target: { dialect: "mysql" } }], files: ["schema.ts"] })).toContainEqual(
      expect.objectContaining({ path: ["steps", 0, "split", "sides", 1, "target"], code: "INVALID_VALUE" }),
    );
  });

  it("should check split files at the type level in defineGuideManifest", () => {
    const defined = defineGuideManifest({
      kind: "drizzle-run-guide",
      manifestVersion: 1,
      id: "typed-split",
      title: "Typed split",
      project: seeded,
      steps: [
        {
          type: "walkthrough",
          id: "01-split",
          label: "Split",
          title: "Split",
          body: "Two sides.",
          split: { sides: [sqlLike, rqb], files: ["query.ts"] },
          run: "required",
        },
      ],
    });

    expectTypeOf(defined.steps[0].split.files).toEqualTypeOf<readonly ["query.ts"]>();
    expect(() =>
      // @ts-expect-error the split names a file that no edit or project file provides.
      defineGuideManifest({
        ...defined,
        steps: [{ ...defined.steps[0], split: { sides: [sqlLike, rqb], files: ["ghost.ts"] } }],
      }),
    ).toThrow("ghost.ts does not exist when this step splits the project.");
  });
});
