import * as z from "zod/mini";

/**
 * A JSON object with its fields still unread, such as parsed JSON or a stored record
 *
 * Refuses null, arrays and other non-objects. Keeps the fields in their original order.
 */
export const FieldsSchema = z.record(z.string(), z.unknown());

/** A whole number, as `Number.isInteger` reads it. */
export const IntegerSchema = z.number().check(z.refine(Number.isInteger));
