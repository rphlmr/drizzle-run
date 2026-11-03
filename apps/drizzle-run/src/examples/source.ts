/** Parsing helpers for example folders. */

import * as z from "zod/mini";

import { FieldsSchema } from "../lib/records";

/** The only origin a docs link may point to. */
export const DOCS_ORIGIN = "https://orm.drizzle.team";
/** The only origin a notes link may point to. */
export const NOTES_ORIGIN = "https://notes.drizzle.run";

/** A link of an example: to the docs, to the notes, or to another example by slug. */
export type ExampleLink =
  | { kind: "docs"; label: string; url: string }
  | { kind: "notes"; label: string; url: string }
  | { kind: "example"; label: string; slug: string };

/** A broken example folder, named by its folder under `examples/`. */
export class ExampleError extends Error {
  constructor(folder: string, message: string, options?: ErrorOptions) {
    super(`Example "${folder}": ${message}`, options);
    this.name = "ExampleError";
  }
}

const RequiredTextSchema = z.string().check(z.refine((value) => value.trim() !== ""));
const WebLinkKindSchema = z.enum(["docs", "notes"]);

/**
 * Read one field of an example folder
 *
 * @param problem - What the field must be, as the error names it: `"featured must be true or false."`
 * @returns The field as the schema parses it; throws an `ExampleError` with `problem` when it does not parse.
 */
export function readExampleField<Schema extends z.core.$ZodType>(
  folder: string,
  schema: Schema,
  value: unknown,
  problem: string,
): z.output<Schema> {
  const parsed = z.safeParse(schema, value);

  if (!parsed.success) {
    throw new ExampleError(folder, problem, { cause: parsed.error });
  }

  return parsed.data;
}

/** Reads a required string field; throws when it is missing or blank. */
export function readRequiredText(folder: string, fields: Record<string, unknown>, field: string): string {
  return readExampleField(folder, RequiredTextSchema, fields[field], `${field} must be a non-empty string.`);
}

/** Parses one entry of an example's `links`; throws when its kind, URL or origin is wrong. */
export function parseLink(folder: string, value: unknown): ExampleLink {
  const fields = readExampleField(folder, FieldsSchema, value, "each link must be an object.");
  const label = readRequiredText(folder, fields, "label");

  if (fields.kind === "example") {
    return { kind: "example", label, slug: readRequiredText(folder, fields, "slug") };
  }

  const kind = readExampleField(folder, WebLinkKindSchema, fields.kind, `link "${label}" has an unknown kind.`);
  const url = readRequiredText(folder, fields, "url");
  const origin = kind === "docs" ? DOCS_ORIGIN : NOTES_ORIGIN;
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new ExampleError(folder, `link "${label}" is not a valid URL.`, { cause });
  }

  if (parsed.origin !== origin) {
    throw new ExampleError(folder, `${kind} link "${label}" must point to ${origin}.`);
  }

  return { kind, label, url: parsed.href };
}
