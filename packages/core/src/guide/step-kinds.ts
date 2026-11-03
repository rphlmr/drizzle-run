import * as z from "zod/mini";

import { safeParseRunManifest } from "../manifest/validation.ts";
import { safeParsePairManifest } from "../pair/validation.ts";
import {
  createSlugSchema,
  GuideAssistantSchema,
  GuideEditError,
  GuideEditSchema,
  GuideFocusSchema,
  GuideLinkSchema,
  GuideMergeSchema,
  GuideRichTextSchema,
  GuideSplitSchema,
  GuideTextSchema,
  ManifestMetaSchema,
  readField,
  type GuideEdit,
  type GuideFocus,
} from "../shared/models.ts";
import { checkKnownFields, type DataRecord, type IssuePath, type ReportIssue } from "../shared/records.ts";
import { createStrictDataObjectSchema } from "../shared/schema.ts";
import {
  applyProjectEdits,
  applyProjectShape,
  GuideShapeError,
  isPairProject,
  projectFiles,
  type GuideProject,
  type GuideShapeChange,
} from "./project.ts";
import type { GuideManifestIssue, GuideRunPolicy, GuideStep, GuideStepBase, WalkthroughStep } from "./types.ts";

/** Reports one guide manifest issue. */
export type ReportGuideIssue = ReportIssue<GuideManifestIssue["code"]>;

/** What a step kind reads a step with. */
export interface StepReadContext {
  path: IssuePath;
  /**
   * The project before this step, or undefined when it cannot be known (an invalid project or an earlier unknown
   * step).
   */
  project: GuideProject | undefined;
  report: ReportGuideIssue;
}

/** A read step, undefined when invalid, and the project after it. */
export interface StepReadResult<Step> {
  step: Step | undefined;
  /** The project after this step, or undefined when it cannot be known. */
  project: GuideProject | undefined;
}

/**
 * One step kind: its fields and how to read them. The guide validator dispatches on
 * `type`, so adding a kind adds an entry without touching existing ones.
 */
export interface StepKindDefinition<Step extends { readonly type: string } = { readonly type: string }> {
  type: Step["type"];
  read(record: DataRecord, context: StepReadContext): StepReadResult<Step>;
}

/** Fields every step kind accepts. */
export const STEP_BASE_FIELDS = ["type", "id", "label", "title", "body", "links", "assistant", "meta"] as const;

const StepIdSchema = createSlugSchema(
  "Step ids are lowercase words and digits joined by hyphens, such as 01-transfer.",
);

const StepLinksSchema = z.optional(z.array(GuideLinkSchema, { error: "Expected a list." }));

/**
 * Read the fields every step kind shares
 *
 * Reports every invalid field and leaves it out of the result, so a step kind can tell which are missing.
 */
export function readStepBase(record: DataRecord, path: IssuePath, report: ReportGuideIssue): Partial<GuideStepBase> {
  const id = readField(StepIdSchema, record.id, [...path, "id"], report);
  const label = readField(GuideTextSchema, record.label, [...path, "label"], report);
  const title = readField(GuideTextSchema, record.title, [...path, "title"], report);
  const body = readField(GuideRichTextSchema, record.body, [...path, "body"], report);
  const links = readField(StepLinksSchema, record.links, [...path, "links"], report);
  const assistant = readField(z.optional(GuideAssistantSchema), record.assistant, [...path, "assistant"], report);
  const meta = readField(z.optional(ManifestMetaSchema), record.meta, [...path, "meta"], report);

  return {
    ...(id.success ? { id: id.data } : {}),
    ...(label.success ? { label: label.data } : {}),
    ...(title.success ? { title: title.data } : {}),
    ...(body.success ? { body: body.data } : {}),
    ...(links.success && links.data !== undefined ? { links: links.data } : {}),
    ...(assistant.success && assistant.data !== undefined ? { assistant: assistant.data } : {}),
    ...(meta.success && meta.data !== undefined ? { meta: meta.data } : {}),
  };
}

const RUN_POLICIES = ["required", "optional", "none"] as const satisfies readonly GuideRunPolicy[];

const RunPolicySchema = z.enum(RUN_POLICIES, `Expected one of ${RUN_POLICIES.join(", ")}.`);

const DISPLAY_LABEL_FAILURE = "Expected a display label as non-empty text.";

const HighlightSchema = z.optional(
  createStrictDataObjectSchema({
    displays: z.array(
      z.string({ error: DISPLAY_LABEL_FAILURE }).check(z.refine((label) => label.trim() !== "", DISPLAY_LABEL_FAILURE)),
      { error: "Expected a list of display labels." },
    ),
  }),
);

/** The side fields a split writes; a pair issue on any of them is reported where the split names it. */
const SPLIT_SIDE_FIELDS = ["name", "dependencies", "guestFlavor"] as const;

function toShapeIssueCode(reason: GuideShapeError["reason"]): GuideManifestIssue["code"] {
  if (reason === "MISSING_FILE") {
    return "MISSING_FILE";
  }

  return reason === "SEED_FILE" || reason === "RENAMED_SEED" ? "INVALID_VALUE" : reason;
}

const PROPER_FIRST_WORDS = new Set(["Drizzle", "Legacy", "Next", "Effect", "PostgreSQL", "SQLite"]);

/** The issue message as the end of "When this step splits, ...": its first word lowercased unless it is a name. */
function toSentenceTail(message: string): string {
  const firstWord = /^[A-Z][a-z']*\b/.exec(message)?.[0];

  if (firstWord === undefined || PROPER_FIRST_WORDS.has(firstWord)) {
    return message;
  }

  return `${firstWord.toLowerCase()}${message.slice(firstWord.length)}`;
}

/**
 * Apply a step's split or merge on the known project
 *
 * Reports a change that does not fit the project, or sides that cannot run, at the step's `split` or `merge`, and
 * returns undefined then.
 */
function replayShape(change: GuideShapeChange, project: GuideProject, context: StepReadContext) {
  const field = change.split === undefined ? "merge" : "split";
  let shaped: GuideProject;

  try {
    shaped = applyProjectShape(project, change);
  } catch (cause) {
    if (!(cause instanceof GuideShapeError)) {
      throw cause;
    }

    const fileIndex = cause.file === undefined ? -1 : (change.split?.files.indexOf(cause.file) ?? -1);
    const filePath = fileIndex < 0 ? [] : ["files", fileIndex];

    context.report([...context.path, field, ...filePath], toShapeIssueCode(cause.reason), cause.message);
    return undefined;
  }

  if (shaped === project || !isPairProject(shaped)) {
    return shaped;
  }

  // A split's sides are checked before the edits, so a bad name or release is reported where it is written.
  const result = safeParsePairManifest(shaped);

  if (!result.success) {
    for (const issue of result.issues) {
      const isSplitField = issue.path[0] === "sides" && SPLIT_SIDE_FIELDS.some((name) => name === issue.path[2]);
      const sidePath = isSplitField ? issue.path.slice(0, 3) : [];

      context.report(
        [...context.path, "split", ...sidePath],
        issue.code,
        `When this step splits, ${toSentenceTail(issue.message)}`,
      );
    }

    return undefined;
  }

  return shaped;
}

/**
 * Replay a step's split or merge, then its edits, on the known project
 *
 * Reports a change or an edit that does not apply, or a project the step leaves invalid, and returns undefined then.
 * Returns undefined without a report when the project before the step is unknown.
 */
export function replayEdits(
  edits: readonly GuideEdit[],
  context: StepReadContext,
  change: GuideShapeChange = {},
): GuideProject | undefined {
  if (context.project === undefined) {
    return undefined;
  }

  const shaped = replayShape(change, context.project, context);

  if (shaped === undefined) {
    return undefined;
  }

  let project: GuideProject;

  try {
    project = applyProjectEdits(shaped, edits);
  } catch (cause) {
    if (!(cause instanceof GuideEditError)) {
      throw cause;
    }

    const code = cause.reason === "MISSING_FILE" ? "MISSING_FILE" : "EDIT_CONFLICT";

    context.report([...context.path, "edits", cause.index], code, cause.message);
    return undefined;
  }

  const result = isPairProject(project) ? safeParsePairManifest(project) : safeParseRunManifest(project);

  if (!result.success) {
    for (const issue of result.issues) {
      context.report([...context.path, "edits"], issue.code, `After this step's edits, ${issue.message}`);
    }

    return undefined;
  }

  return result.data;
}

/**
 * The files a focus points into: a side's files, or the shared files of a side-by-side project when it names no side
 *
 * Null, reported, when the side does not fit the project.
 */
function resolveFocusFiles(
  { file, side }: GuideFocus,
  project: GuideProject,
  path: IssuePath,
  report: ReportGuideIssue,
): Readonly<Record<string, string>> | null {
  if (!isPairProject(project)) {
    if (side !== undefined) {
      report([...path, "side"], "INVALID_VALUE", "Only a side-by-side step names a side.");
      return null;
    }

    return project.files;
  }

  if (side === undefined && !Object.hasOwn(project.files, file) && Object.hasOwn(projectFiles(project, 0), file)) {
    report([...path, "side"], "INVALID_VALUE", `${file} has a copy per side, so the focus names its side.`);
    return null;
  }

  return side === undefined ? project.files : projectFiles(project, side);
}

/** Check that a focus points at a file and lines the project has after its step, reporting why not. */
function isFocusInProject(focus: GuideFocus, project: GuideProject, path: IssuePath, report: ReportGuideIssue) {
  const files = resolveFocusFiles(focus, project, path, report);

  if (files === null) {
    return false;
  }

  const source = Object.hasOwn(files, focus.file) ? files[focus.file] : undefined;

  if (source === undefined) {
    report([...path, "file"], "MISSING_FILE", `${focus.file} does not exist at this step.`);
    return false;
  }

  const lineCount = source.split("\n").length;
  const [, end] = focus.lines;

  if (end > lineCount) {
    report(
      [...path, "lines"],
      "INVALID_VALUE",
      `Focus ends at line ${end}, but ${focus.file} has ${lineCount} lines at this step.`,
    );
    return false;
  }

  return true;
}

const StepEditsSchema = z.optional(z.array(GuideEditSchema, { error: "Expected a list." }));

/** The walkthrough step kind: scripted edits, a focus, and a run policy. */
export const walkthroughStepKind: StepKindDefinition<WalkthroughStep> = {
  type: "walkthrough",
  read(record, context) {
    const { path, report } = context;

    checkKnownFields(
      record,
      [...STEP_BASE_FIELDS, "split", "merge", "edits", "focus", "run", "highlight"],
      path,
      report,
    );

    const base = readStepBase(record, path, report);
    const split = readField(z.optional(GuideSplitSchema), record.split, [...path, "split"], report);
    const merge = readField(z.optional(GuideMergeSchema), record.merge, [...path, "merge"], report);
    const edits = readField(StepEditsSchema, record.edits, [...path, "edits"], report);
    const change: GuideShapeChange = {
      ...(split.success && split.data !== undefined ? { split: split.data } : {}),
      ...(merge.success && merge.data !== undefined ? { merge: merge.data } : {}),
    };
    const isReplayable = split.success && merge.success && edits.success;
    const project = isReplayable ? replayEdits(edits.data ?? [], context, change) : undefined;
    const focusPath: IssuePath = [...path, "focus"];
    const focus = readField(z.optional(GuideFocusSchema), record.focus, focusPath, report);
    const keptFocus =
      focus.success &&
      focus.data !== undefined &&
      (project === undefined || isFocusInProject(focus.data, project, focusPath, report))
        ? focus.data
        : undefined;
    const run = readField(RunPolicySchema, record.run, [...path, "run"], report);
    const highlight = readField(HighlightSchema, record.highlight, [...path, "highlight"], report);
    const { id, label, title, body } = base;

    if (
      id === undefined ||
      label === undefined ||
      title === undefined ||
      body === undefined ||
      !run.success ||
      !isReplayable
    ) {
      return { step: undefined, project };
    }

    const step: WalkthroughStep = {
      type: "walkthrough",
      id,
      label,
      title,
      body,
      ...change,
      ...(edits.data === undefined ? {} : { edits: edits.data }),
      ...(keptFocus === undefined ? {} : { focus: keptFocus }),
      run: run.data,
      ...(highlight.success && highlight.data !== undefined ? { highlight: highlight.data } : {}),
      ...(base.links === undefined ? {} : { links: base.links }),
      ...(base.assistant === undefined ? {} : { assistant: base.assistant }),
      ...(base.meta === undefined ? {} : { meta: base.meta }),
    };

    return { step, project };
  },
};

/** Every step kind this version knows, by `type`. */
export const STEP_KINDS: readonly StepKindDefinition<GuideStep>[] = [walkthroughStepKind];
