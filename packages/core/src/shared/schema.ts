/** Zod building blocks shared by the manifest, pair, snapshot and recording schemas. */

import { isPlainObject } from "es-toolkit";
import * as z from "zod/mini";

import type { DataRecord, IssuePath } from "./records.ts";

/** The codes every validated contract reports, whatever its own extra codes. */
const BASE_ISSUE_CODES = ["INVALID_TYPE", "UNKNOWN_FIELD", "INVALID_VALUE"] as const;

/** A code every validated contract reports. */
export type BaseIssueCode = (typeof BASE_ISSUE_CODES)[number];

/** One problem found in validated input, at a path inside it. */
export interface ContractIssue<Code extends string = BaseIssueCode> {
  path: readonly (string | number)[];
  code: Code;
  message: string;
}

/**
 * Error params that name the issue code a contract reports
 *
 * Zod issues keep their own codes, so a schema that needs a contract code such as `MISSING_FILE` carries it in its
 * params; `toContractIssues` reads it back.
 */
export function withIssueCode<Code extends string>(
  code: Code,
  message: string,
): { error: string; params: { code: Code } } {
  return { error: message, params: { code } };
}

/**
 * Report an issue from a refinement
 *
 * `continue` keeps later checks running, so a check reports every problem instead of the first one.
 */
export function reportIssue(
  payload: { issues: z.core.$ZodRawIssue[]; value: unknown },
  issue: { path?: IssuePath; code: string; message: string },
): void {
  payload.issues.push({
    code: "custom",
    input: payload.value,
    path: [...(issue.path ?? [])],
    message: issue.message,
    params: { code: issue.code },
    continue: true,
  });
}

function readIssueCode<Code extends string>(
  issue: z.core.$ZodIssue,
  codes: readonly Code[],
): Code | BaseIssueCode | undefined {
  if (issue.code !== "custom") {
    return undefined;
  }

  const code: unknown = issue.params?.code;

  return [...BASE_ISSUE_CODES, ...codes].find((knownCode) => knownCode === code);
}

function toPathSegments(path: readonly PropertyKey[]): (string | number)[] {
  return path.filter((segment): segment is string | number => typeof segment !== "symbol");
}

/**
 * Turn Zod issues into contract issues
 *
 * A custom issue keeps the code in its params when `codes` lists it; a type issue is `INVALID_TYPE`, an unknown key
 * becomes one `UNKNOWN_FIELD` per key, and anything else is `INVALID_VALUE`. Messages stay the schema's own.
 *
 * @param prefix - Prepended to every path, for a contract checked inside another one
 */
export function toContractIssues<Code extends string>(
  issues: readonly z.core.$ZodIssue[],
  codes: readonly Code[],
  prefix: IssuePath = [],
): ContractIssue<Code | BaseIssueCode>[] {
  return issues.flatMap((issue): ContractIssue<Code | BaseIssueCode>[] => {
    const path = [...prefix, ...toPathSegments(issue.path)];

    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...path, key],
        code: "UNKNOWN_FIELD",
        message: `Unknown field: ${key}.`,
      }));
    }

    const code = readIssueCode(issue, codes) ?? (issue.code === "invalid_type" ? "INVALID_TYPE" : "INVALID_VALUE");

    return [{ path, code, message: issue.message }];
  });
}

/**
 * A value that passes `predicate`
 *
 * Unlike `z.custom`, its issue does not stop the checks across fields of the object around it, so one bad field does
 * not hide the problems of the others.
 */
export function refined<Output>(predicate: (value: unknown) => boolean, params?: string | z.core.$ZodCustomParams) {
  return z.custom<Output>().check(z.refine(predicate, params));
}

/**
 * An optional field kept only when it matches `schema`
 *
 * A missing field or any other value reads as `undefined`, so a lenient reader drops a malformed field instead of
 * rejecting the whole value.
 */
export function keepIfValid<Output>(schema: z.ZodMiniType<Output>) {
  return z.union([schema, z.transform((): undefined => undefined)]);
}

/** A field of a plain object that is not JSON data. */
export interface DataFieldProblem {
  path: IssuePath;
  message: string;
}

/**
 * Read the enumerable string-keyed data fields of an object
 *
 * Symbol and accessor fields are left out and listed as problems, so a getter never runs.
 */
export function readDataFields(input: object): { fields: DataRecord; problems: DataFieldProblem[] } {
  const fields: [string, unknown][] = [];
  const problems: DataFieldProblem[] = [];

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      problems.push({ path: [], message: "Symbol fields are not valid JSON fields." });
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(input, key);

    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      problems.push({ path: [key], message: "Fields must be enumerable data properties." });
      continue;
    }

    fields.push([key, descriptor.value]);
  }

  return { fields: Object.fromEntries(fields), problems };
}

/**
 * A plain object, its prototype `Object.prototype` or null, failing with `message` otherwise
 *
 * Its output is the input itself, not a copy.
 */
export function createPlainObjectSchema(message = "Expected a plain object.") {
  return refined<Readonly<Record<string, unknown>>>(isPlainObject, withIssueCode("INVALID_TYPE", message));
}

/**
 * A plain object read as JSON-like data
 *
 * Fails with `message` for anything but a plain object, and reports symbol and accessor fields. Its output is a
 * detached copy, so a later change to the input never reaches the parsed value.
 */
export function createDataRecordSchema(message = "Expected a plain object.") {
  return z.pipe(
    createPlainObjectSchema(message),
    z.transform((input: Readonly<Record<string, unknown>>, payload) => {
      const { fields, problems } = readDataFields(input);

      for (const problem of problems) {
        reportIssue(payload, { ...problem, code: "INVALID_VALUE" });
      }

      return fields;
    }),
  );
}

/** A plain object with JSON-like data fields: the input every contract schema starts from. */
export const DataRecordSchema = createDataRecordSchema();

/** A plain object read as data, then checked by `shape`, which reports every other field as unknown. */
export function createStrictDataObjectSchema<Shape extends z.core.$ZodShape>(shape: Shape) {
  return z.pipe(DataRecordSchema, z.strictObject(shape));
}

/**
 * `schema`, failing with one `message` at its own path
 *
 * For a value whose nested issues would say less than one plain sentence, such as a database target.
 */
export function withFailureMessage<Output>(schema: z.ZodMiniType<Output>, message: string) {
  return z.transform((value: unknown, payload): Output => {
    const result = schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    reportIssue(payload, { code: "INVALID_VALUE", message });

    return z.NEVER;
  });
}
