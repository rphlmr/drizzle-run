import * as z from "zod/mini";

import { isProjectFilePath, RunDependencyPinsSchema, RunManifestTargetSchema } from "../manifest/schema.ts";
import type { RunDependencyPins, RunManifestTarget } from "../manifest/types.ts";
import type { PairSideIndex } from "../pair/types.ts";
import { GUEST_FLAVORS, type GuestFlavor } from "../releases/catalog.ts";
import { isCanonicalProjectPath, SLUG, type IssuePath, type ReportIssue } from "./records.ts";
import { isGuideHref, parseRichText } from "./rich-text.ts";
import {
  createPlainObjectSchema,
  createStrictDataObjectSchema,
  readDataFields,
  reportIssue,
  toContractIssues,
  withFailureMessage,
  withIssueCode,
  type BaseIssueCode,
} from "./schema.ts";

/**
 * Schema models shared by guide steps and, later, other manifest kinds such as
 * learning paths: edits, focus, links, rich text, and consumer meta.
 */

/** Consumer-owned data. Core and the machines never read it. */
export type ManifestMeta = Readonly<Record<string, unknown>>;

/**
 * A scripted change to one project file
 *
 * `replace` swaps an anchor that must match exactly once; `write` creates the file or replaces its whole content.
 */
export type GuideEdit = (
  | { readonly file: string; readonly replace: { readonly anchor: string; readonly with: string } }
  | { readonly file: string; readonly write: string }
) & {
  /** In a side-by-side project, the side whose copy of a per-side file changes. A shared file has no side. */
  readonly side?: PairSideIndex;
};

/**
 * One side a split opens: an optional name, and a database, release or guest flavor only where it differs from the
 * project's.
 */
export interface GuideSplitSide {
  /** Same rules as a side-by-side side's name; without one, the side goes by its release. */
  readonly name?: string;
  /** The side's database. A side on another one needs its own schema: split the schema and rewrite it in the step. */
  readonly target?: RunManifestTarget;
  readonly dependencies?: RunDependencyPins;
  readonly guestFlavor?: GuestFlavor;
}

/**
 * Opens two sides from a one-version project, before the step's edits apply
 *
 * Each listed file gets a copy per side, both starting as the file is now; every other file stays shared, and the
 * seed always does. Later edits name the side whose copy they change, as in a side-by-side guide.
 */
export interface GuideSplit {
  readonly sides: readonly [GuideSplitSide, GuideSplitSide];
  readonly files: readonly string[];
}

/**
 * Returns a side-by-side project to one version, before the step's edits apply
 *
 * The project keeps the shared files plus the kept side's own files, release and guest flavor.
 */
export interface GuideMerge {
  readonly keep: PairSideIndex;
}

/**
 * The lines a step points the learner at
 *
 * Lines are 1-based and inclusive.
 */
export interface GuideFocus {
  readonly file: string;
  readonly lines: readonly [start: number, end: number];
  /** In a side-by-side project, the side's editor to point at; without it, a shared file shows on both. */
  readonly side?: PairSideIndex;
}

/** A labelled link shown with a step. */
export interface GuideLink {
  readonly label: string;
  /** An https URL, or a host-relative path such as `/examples/joins`. */
  readonly href: string;
}

/**
 * Context for an AI agent that answers questions during the guide (the guided chat). Core
 * validates it and never reads it to run a guide.
 */
export interface GuideAssistant {
  /** What the guide or step really teaches and the usual confusions, in plain text. */
  readonly notes?: string;
  /** Pages the agent reads beyond the step's links, which count as sources too. */
  readonly sources?: readonly GuideLink[];
}

/** Longest `assistant.notes`, so a guide cannot crowd out the agent's own context. */
export const GUIDE_ASSISTANT_NOTES_MAX = 4_000;

/** Why a guide edit did not apply. */
export type GuideEditFailure =
  | "MISSING_FILE"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_NOT_UNIQUE"
  | "SIDE_REQUIRED"
  | "NOT_PER_SIDE";

/** Thrown when a guide edit does not apply, with the edit's index in its step and the file it targets. */
export class GuideEditError extends Error {
  readonly file: string;
  readonly index: number;
  readonly reason: GuideEditFailure;

  constructor(index: number, file: string, reason: GuideEditFailure) {
    const messages: Record<GuideEditFailure, string> = {
      MISSING_FILE: `${file} does not exist when this edit applies.`,
      ANCHOR_NOT_FOUND: `The anchor is not in ${file}.`,
      ANCHOR_NOT_UNIQUE: `The anchor matches more than once in ${file}.`,
      SIDE_REQUIRED: `${file} has a copy per side, so the edit names its side.`,
      NOT_PER_SIDE: `${file} has no copy per side, so the edit names no side.`,
    };

    super(messages[reason]);
    this.name = "GuideEditError";
    this.file = file;
    this.index = index;
    this.reason = reason;
  }
}

function countOccurrences(source: string, anchor: string): number {
  const firstIndex = source.indexOf(anchor);

  if (firstIndex === -1) {
    return 0;
  }

  return source.indexOf(anchor, firstIndex + 1) === -1 ? 1 : 2;
}

/**
 * Apply guide edits to a file set
 *
 * Applies edits in order and returns new files, leaving `files` untouched. Throws `GuideEditError` on the first edit
 * that does not apply cleanly.
 */
export function applyEdits(
  files: Readonly<Record<string, string>>,
  edits: readonly GuideEdit[],
): Record<string, string> {
  const editedFiles: Record<string, string> = { ...files };

  for (const [index, edit] of edits.entries()) {
    if ("write" in edit) {
      Object.defineProperty(editedFiles, edit.file, {
        value: edit.write,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }

    const source = Object.hasOwn(editedFiles, edit.file) ? editedFiles[edit.file] : undefined;

    if (source === undefined) {
      throw new GuideEditError(index, edit.file, "MISSING_FILE");
    }

    const matchCount = countOccurrences(source, edit.replace.anchor);

    if (matchCount !== 1) {
      throw new GuideEditError(index, edit.file, matchCount === 0 ? "ANCHOR_NOT_FOUND" : "ANCHOR_NOT_UNIQUE");
    }

    editedFiles[edit.file] = source.replace(edit.replace.anchor, () => edit.replace.with);
  }

  return editedFiles;
}

const MODEL_ISSUE_CODES = ["NON_CANONICAL_PATH"] as const;

/** A code a guide model field reports. */
export type ModelIssueCode = BaseIssueCode | (typeof MODEL_ISSUE_CODES)[number];

/** A field read with `readField`: its value, or a failure already reported. */
export type FieldReadResult<Output> = { success: true; data: Output } | { success: false };

/**
 * Read one field with `schema`
 *
 * Reports every issue at `path` and below, so a reader keeps going past one bad field and reports the others too.
 */
export function readField<Output>(
  schema: z.ZodMiniType<Output>,
  value: unknown,
  path: IssuePath,
  report: ReportIssue<ModelIssueCode>,
): FieldReadResult<Output> {
  const result = schema.safeParse(value);

  if (result.success) {
    return { success: true, data: result.data };
  }

  for (const issue of toContractIssues(result.error.issues, MODEL_ISSUE_CODES, path)) {
    report(issue.path, issue.code, issue.message);
  }

  return { success: false };
}

/** Non-empty text. */
export const GuideTextSchema = z
  .string({ error: "Expected text." })
  .check(z.refine((text) => text.trim() !== "", { error: "Expected non-empty text.", abort: true }));

/** A lowercase slug id, failing with `message` when the text is not one. */
export function createSlugSchema(message: string) {
  return GuideTextSchema.check(z.refine((text) => SLUG.test(text), message));
}

const ProjectFilePathSchema = GuideTextSchema.check(
  z.refine(isCanonicalProjectPath, {
    ...withIssueCode("NON_CANONICAL_PATH", "File paths must be canonical relative POSIX paths."),
    abort: true,
  }),
  // A name such as "toString" or "__proto__" would reach the prototype of the files it is looked up in.
  z.refine(isProjectFilePath, {
    error: (issue) => `Expected a project file path such as "schema.ts", but got "${String(issue.input)}".`,
  }),
);

const SideSchema = z.optional(z.literal([0, 1], "Expected side 0 or 1."));

const ANCHOR_FAILURE = "The anchor must be non-empty text.";

const GuideEditFieldsSchema = createStrictDataObjectSchema({
  file: ProjectFilePathSchema,
  write: z.optional(z.string({ error: "Expected the file's new content as text." })),
  replace: z.optional(
    createStrictDataObjectSchema({
      anchor: z.string({ error: ANCHOR_FAILURE }).check(z.minLength(1, ANCHOR_FAILURE)),
      with: z.string({ error: "Expected the replacement as text." }),
    }),
  ),
  side: SideSchema,
});

/** One guide edit: a file, exactly one of `replace` or `write`, and an optional side. */
export const GuideEditSchema = z.pipe(
  GuideEditFieldsSchema,
  z.transform(({ file, write, replace, side }, payload): GuideEdit => {
    const sideField = side === undefined ? {} : { side };

    if (write !== undefined && replace === undefined) {
      return { file, write, ...sideField };
    }

    if (replace !== undefined && write === undefined) {
      return { file, replace, ...sideField };
    }

    reportIssue(payload, { code: "INVALID_VALUE", message: "An edit has exactly one of replace or write." });

    return z.NEVER;
  }),
);

const LINES_FAILURE = "Expected [start, end] with 1 <= start <= end.";

const LineSchema = z.int({ error: LINES_FAILURE }).check(z.minimum(1, LINES_FAILURE));

/** A focus's shape. Whether its file and lines exist is checked against the project when the step replays. */
export const GuideFocusSchema = createStrictDataObjectSchema({
  file: ProjectFilePathSchema,
  lines: z
    .tuple([LineSchema, LineSchema], { error: LINES_FAILURE })
    .check(z.refine(([start, end]) => start <= end, LINES_FAILURE)),
  side: SideSchema,
});

/** A labelled link with an https URL or a host-relative path. */
export const GuideLinkSchema = createStrictDataObjectSchema({
  label: GuideTextSchema,
  href: GuideTextSchema.check(z.refine(isGuideHref, "Links use an https URL or a path starting with /.")),
});

/** Rich text source, kept as written once it parses. */
export const GuideRichTextSchema = GuideTextSchema.check(
  z.superRefine((source, payload) => {
    try {
      parseRichText(source);
    } catch (cause) {
      reportIssue(payload, { code: "INVALID_VALUE", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }),
);

/** Consumer meta: a plain object of data fields, kept as the value itself so it round-trips untouched. */
export const ManifestMetaSchema = z.pipe(
  createPlainObjectSchema(),
  z.transform((meta, payload) => {
    for (const problem of readDataFields(meta).problems) {
      reportIssue(payload, { ...problem, code: "INVALID_VALUE" });
    }

    return meta;
  }),
);

/** Assistant context: notes and sources, both optional, nothing else. */
export const GuideAssistantSchema = createStrictDataObjectSchema({
  notes: z.optional(
    GuideTextSchema.check(
      z.maxLength(GUIDE_ASSISTANT_NOTES_MAX, `Assistant notes hold up to ${GUIDE_ASSISTANT_NOTES_MAX} characters.`),
    ),
  ),
  sources: z.optional(z.array(GuideLinkSchema, { error: "Expected a list." })),
});

const GuideSplitSideSchema = createStrictDataObjectSchema({
  name: z.optional(GuideTextSchema),
  target: z.optional(
    withFailureMessage(RunManifestTargetSchema, 'Expected a database target, such as { "dialect": "sqlite" }.'),
  ),
  dependencies: z.optional(
    withFailureMessage(RunDependencyPinsSchema, "Expected drizzle-orm and drizzle-kit pins of one release."),
  ),
  guestFlavor: z.optional(z.enum(GUEST_FLAVORS, `Expected one of ${GUEST_FLAVORS.join(", ")}.`)),
});

const SPLIT_FILES_FAILURE = "Expected the list of files that get a copy per side.";

const SplitFilesSchema = z
  .array(
    z
      .string({ error: SPLIT_FILES_FAILURE })
      .check(
        z.refine(
          isCanonicalProjectPath,
          withIssueCode("NON_CANONICAL_PATH", "File paths must be canonical relative POSIX paths."),
        ),
      ),
    { error: SPLIT_FILES_FAILURE },
  )
  .check(
    z.minLength(1, SPLIT_FILES_FAILURE),
    z.superRefine((files, payload) => {
      for (const [index, file] of files.entries()) {
        if (files.indexOf(file) !== index) {
          reportIssue(payload, { path: [index], code: "INVALID_VALUE", message: `${file} is listed more than once.` });
        }
      }
    }),
  );

/**
 * A split's shape: two sides and a non-empty list of distinct canonical file paths
 *
 * Whether the files exist and the sides run is checked against the project when the step replays.
 */
export const GuideSplitSchema = createStrictDataObjectSchema({
  sides: z.tuple([GuideSplitSideSchema, GuideSplitSideSchema], { error: "Expected two sides." }),
  files: SplitFilesSchema,
});

/** A merge: the side to keep. */
export const GuideMergeSchema = createStrictDataObjectSchema({
  keep: z.literal([0, 1], "Expected the side to keep, 0 or 1."),
});
