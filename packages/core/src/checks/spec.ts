import * as z from "zod/mini";

import { isProjectFilePath } from "../manifest/schema.ts";
import type { IssuePath } from "../shared/records.ts";
import { createStrictDataObjectSchema, DataRecordSchema, toContractIssues } from "../shared/schema.ts";

const TEXT_FAILURE = "Expected non-empty text.";

const NAMES_FAILURE = "Expected a non-empty list of names.";

const COLUMNS_FAILURE = "Expected a non-empty list of columns.";

const BOOLEAN_FAILURE = "Expected true or false.";

const ROW_COUNT_FAILURE = "Expected a whole number.";

const CheckTextSchema = z.string({ error: TEXT_FAILURE }).check(z.refine((text) => text.trim() !== "", TEXT_FAILURE));

const NamesSchema = z
  .array(z.string({ error: NAMES_FAILURE }).check(z.minLength(1, NAMES_FAILURE)), { error: NAMES_FAILURE })
  .check(z.minLength(1, NAMES_FAILURE));

const OptionalBooleanSchema = z.optional(z.boolean({ error: BOOLEAN_FAILURE }));

const CheckedColumnSchema = createStrictDataObjectSchema({
  name: CheckTextSchema,
  dataType: z.optional(CheckTextSchema),
  nullable: OptionalBooleanSchema,
});

const CheckedColumnsSchema = z
  .array(CheckedColumnSchema, { error: COLUMNS_FAILURE })
  .check(z.minLength(1, COLUMNS_FAILURE));

const CheckFileSchema = CheckTextSchema.check(
  z.refine(isProjectFilePath, {
    error: (issue) => `Expected a project file path such as "schema.ts", but got "${String(issue.input)}".`,
  }),
);

/** Each check type's fields. */
const CHECK_SCHEMAS = {
  noError: z.strictObject({ type: z.literal("noError") }),
  table: z.strictObject({ type: z.literal("table"), name: CheckTextSchema, columns: z.optional(CheckedColumnsSchema) }),
  foreignKey: z.strictObject({
    type: z.literal("foreignKey"),
    table: CheckTextSchema,
    columns: NamesSchema,
    references: createStrictDataObjectSchema({ table: CheckTextSchema, columns: NamesSchema }),
  }),
  index: z.strictObject({
    type: z.literal("index"),
    table: CheckTextSchema,
    columns: NamesSchema,
    unique: OptionalBooleanSchema,
  }),
  display: z.strictObject({
    type: z.literal("display"),
    label: CheckTextSchema,
    rowCount: z.optional(z.int({ error: ROW_COUNT_FAILURE }).check(z.minimum(0, ROW_COUNT_FAILURE))),
    columns: z.optional(NamesSchema),
  }),
  matchesSolution: z.strictObject({
    type: z.literal("matchesSolution"),
    label: CheckTextSchema,
    ordered: OptionalBooleanSchema,
    ignore: z.optional(NamesSchema),
  }),
  sqlExecuted: z.strictObject({ type: z.literal("sqlExecuted"), contains: CheckTextSchema }),
  fileContains: z.strictObject({ type: z.literal("fileContains"), file: CheckFileSchema, contains: CheckTextSchema }),
};

/**
 * A check a guide step runs on its result
 *
 * Pure evaluators over a `RunResult`, and over the files the learner ran for `fileContains`. New check types are
 * added over time; a core version that meets a type it does not know reports `UNSUPPORTED_CHECK`.
 */
export type CheckSpec = { [Type in CheckType]: z.output<(typeof CHECK_SCHEMAS)[Type]> }[CheckType];

/** Every check type this version knows. */
export type CheckType = keyof typeof CHECK_SCHEMAS;

/** Every check type this version knows, in declaration order. */
export const CHECK_TYPES: readonly CheckType[] = Object.keys(CHECK_SCHEMAS).filter(isCheckType);

/** One problem found in a check, at a path inside the manifest. */
export interface CheckIssue {
  path: readonly (string | number)[];
  code: "INVALID_TYPE" | "INVALID_VALUE" | "UNKNOWN_FIELD" | "UNSUPPORTED_CHECK";
  message: string;
}

/** The result of `safeParseCheckSpec`: the check, or every issue found. */
export type SafeParseCheckResult =
  | { success: true; data: CheckSpec }
  | { success: false; issues: readonly CheckIssue[] };

const CHECK_ISSUE_CODES = ["UNSUPPORTED_CHECK"] as const satisfies readonly CheckIssue["code"][];

function isCheckType(value: unknown): value is CheckType {
  return typeof value === "string" && Object.hasOwn(CHECK_SCHEMAS, value);
}

/**
 * Validate one check
 *
 * `path` prefixes issue paths when the check sits inside a manifest. An unknown check type fails with
 * `UNSUPPORTED_CHECK`.
 */
export function safeParseCheckSpec(value: unknown, path: IssuePath = []): SafeParseCheckResult {
  const record = DataRecordSchema.safeParse(value);

  if (!record.success) {
    return { success: false, issues: toContractIssues(record.error.issues, CHECK_ISSUE_CODES, path) };
  }

  const { type } = record.data;

  if (typeof type !== "string") {
    return {
      success: false,
      issues: [{ path: [...path, "type"], code: "INVALID_TYPE", message: "Expected a check type." }],
    };
  }

  if (!isCheckType(type)) {
    const message = `Unsupported check type: ${type}. This version knows ${CHECK_TYPES.join(", ")}.`;

    return { success: false, issues: [{ path: [...path, "type"], code: "UNSUPPORTED_CHECK", message }] };
  }

  const check = CHECK_SCHEMAS[type].safeParse(record.data);

  if (!check.success) {
    return { success: false, issues: toContractIssues(check.error.issues, CHECK_ISSUE_CODES, path) };
  }

  return { success: true, data: check.data };
}
