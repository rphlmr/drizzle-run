import * as z from "zod/mini";

import type { DataRecord } from "../shared/records.ts";
import { createDataRecordSchema, refined, withIssueCode } from "../shared/schema.ts";
import {
  MAX_SERIALIZED_DEPTH,
  MAX_SERIALIZED_ERROR_CAUSE_DEPTH,
  MAX_SERIALIZED_ERROR_NAME_BYTES,
  MAX_SERIALIZED_TEXT_BYTES,
  type SerializedError,
  type SerializedPrimitive,
  type SerializedValue,
} from "./serialization.ts";

// Its limits are the serializer's, so anything the serializer writes passes.

const textEncoder = new TextEncoder();

const PlainObjectSchema = createDataRecordSchema("Expected an object.");

const TextSchema = z.string({ error: "Expected text." });

const SerializedPrimitiveSchema = refined<SerializedPrimitive>(
  (value) =>
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)),
  withIssueCode("INVALID_TYPE", "Expected a JSON primitive."),
);

const SERIALIZED_VALUE_TYPES = [
  "undefined",
  "primitive",
  "bigint",
  "date",
  "array",
  "object",
  "unsupported",
  "circular",
] as const satisfies readonly SerializedValue["type"][];

function boundedText(maxBytes: number) {
  return TextSchema.check(
    z.refine((text) => textEncoder.encode(text).byteLength <= maxBytes, {
      error: `Expected at most ${maxBytes} UTF-8 bytes.`,
    }),
  );
}

/** A field the object must have, reported as missing by its own name before its schema reads it. */
function required<Schema extends z.core.$ZodType>(schema: Schema) {
  return z.pipe(
    refined<unknown>((value) => value !== undefined, {
      error: (issue) => `Missing field: ${String(issue.path?.at(-1))}.`,
      params: { code: "INVALID_TYPE" },
    }),
    schema,
  );
}

function taggedByType<Union extends z.core.$ZodType<unknown, DataRecord>>(union: Union) {
  return z.pipe(PlainObjectSchema, union);
}

function unionByType<const Shapes extends readonly [z.core.$ZodTypeDiscriminable, ...z.core.$ZodTypeDiscriminable[]]>(
  shapes: Shapes,
) {
  return z.discriminatedUnion("type", shapes, {
    error: `Expected type to be one of ${SERIALIZED_VALUE_TYPES.join(", ")}.`,
  });
}

const UnsupportedShape = z.strictObject({
  type: z.literal("unsupported"),
  valueType: required(TextSchema),
  description: z.optional(TextSchema),
});

const serializedValueSchemas: z.ZodMiniType<SerializedValue>[] = [];

/** A serialized value at `depth`; past `MAX_SERIALIZED_DEPTH` only the serializer's `unsupported` cut is valid. */
function getSerializedValueSchema(depth: number): z.ZodMiniType<SerializedValue> {
  const cached = serializedValueSchemas[depth];

  if (cached !== undefined) {
    return cached;
  }

  const nested = z.lazy(() => getSerializedValueSchema(depth + 1));
  const objectValues = z.pipe(
    PlainObjectSchema,
    z.transform((fields, payload) => {
      const entries: [string, SerializedValue][] = [];

      for (const [key, value] of Object.entries(fields)) {
        const parsed = nested.safeParse(value);

        if (parsed.success) {
          entries.push([key, parsed.data]);
        } else {
          for (const issue of parsed.error.issues) {
            payload.issues.push({ ...issue, path: [key, ...issue.path], input: undefined });
          }
        }
      }

      return Object.fromEntries(entries);
    }),
  );
  const schema: z.ZodMiniType<SerializedValue> =
    depth > MAX_SERIALIZED_DEPTH
      ? taggedByType(
          z.discriminatedUnion("type", [UnsupportedShape], {
            error: `Values nest at most ${MAX_SERIALIZED_DEPTH} levels.`,
          }),
        )
      : taggedByType(
          unionByType([
            z.strictObject({ type: z.literal("undefined") }),
            z.strictObject({ type: z.literal("primitive"), value: required(SerializedPrimitiveSchema) }),
            z.strictObject({
              type: z.literal("bigint"),
              value: required(TextSchema.check(z.regex(/^-?\d+$/, { error: "Expected a whole number." }))),
            }),
            z.strictObject({
              type: z.literal("date"),
              value: required(
                TextSchema.check(z.refine((text) => Number.isFinite(Date.parse(text)), { error: "Expected a date." })),
              ),
            }),
            z.strictObject({
              type: z.literal("array"),
              value: required(z.array(nested, { error: "Expected a list." })),
            }),
            z.strictObject({
              type: z.literal("object"),
              value: required(objectValues),
            }),
            UnsupportedShape,
            z.strictObject({ type: z.literal("circular"), path: required(TextSchema) }),
          ]),
        );

  serializedValueSchemas[depth] = schema;

  return schema;
}

/** A value `serializeValue` wrote. */
export const SerializedValueSchema = getSerializedValueSchema(0);

/** The fields of a serialized error whose causes start at `depth`. */
function getSerializedErrorShape(depth: number) {
  return {
    name: required(boundedText(MAX_SERIALIZED_ERROR_NAME_BYTES)),
    message: required(boundedText(MAX_SERIALIZED_TEXT_BYTES)),
    stack: z.optional(boundedText(MAX_SERIALIZED_TEXT_BYTES)),
    cause: z.optional(z.lazy(() => getSerializedErrorSchema(depth + 1))),
  };
}

const serializedErrorSchemas: z.ZodMiniType<SerializedError>[] = [];

/** A serialized error at cause `depth`, keeping at most `MAX_SERIALIZED_ERROR_CAUSE_DEPTH` causes. */
function getSerializedErrorSchema(depth: number): z.ZodMiniType<SerializedError> {
  const cached = serializedErrorSchemas[depth];

  if (cached !== undefined) {
    return cached;
  }

  const schema: z.ZodMiniType<SerializedError> =
    depth > MAX_SERIALIZED_ERROR_CAUSE_DEPTH
      ? refined<SerializedError>(
          () => false,
          withIssueCode("INVALID_VALUE", `Error causes nest at most ${MAX_SERIALIZED_ERROR_CAUSE_DEPTH} levels.`),
        )
      : z.pipe(PlainObjectSchema, z.strictObject(getSerializedErrorShape(depth)));

  serializedErrorSchemas[depth] = schema;

  return schema;
}

/** An error `serializeError` wrote, with its cause chain. */
export const SerializedErrorSchema = getSerializedErrorSchema(0);

/** The fields of a top-level serialized error, for a schema that adds its own beside them. */
export const serializedErrorShape = getSerializedErrorShape(0);
