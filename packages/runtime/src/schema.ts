/** Zod building blocks for the messages and inventories the runtime checks. */

import { isPlainObject } from "es-toolkit";
import * as z from "zod/mini";

/**
 * A schema that accepts what `predicate` accepts, failing with `message` otherwise
 *
 * The output is the input itself. Its issues do not abort the object around it, so the checks of that object still run.
 */
export function refined<Output>(predicate: (value: unknown) => value is Output, message?: string) {
  return z.custom<Output>().check(z.refine(predicate, message === undefined ? undefined : { error: message }));
}

/**
 * A plain object, its prototype `Object.prototype` or null, failing with `message` otherwise
 *
 * Arrays, class instances, `Date`, `Error` and typed arrays are not plain objects. The output is the input itself.
 */
export function plainRecord(message?: string) {
  return refined<Record<string, unknown>>(isPlainObject, message);
}

/** A plain object, such as a parsed or structured-cloned message. */
export const PlainRecordSchema = plainRecord();

/**
 * An optional field kept only when it matches `schema`
 *
 * A missing field or any other value reads as `undefined`, so a lenient reader drops a malformed field instead of
 * rejecting the whole value.
 */
export function keepIfValid<Output>(schema: z.ZodMiniType<Output>) {
  return z.union([schema, z.transform((): undefined => undefined)]);
}
