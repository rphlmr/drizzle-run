import * as z from "zod/mini";

type EncodedValue =
  | { type: "undefined" }
  | { type: "primitive"; value: string | number | boolean | null }
  | { type: "bigint" | "date" | "bytes" | "array_buffer"; value: string }
  | { type: "array"; value: EncodedValue[] }
  | { type: "object"; value: [string, EncodedValue][] };

function createEncodedValueSchema(depth: number): z.ZodMiniType<EncodedValue> {
  return z.lazy(() => {
    if (depth > 64) {
      return z.never();
    }

    const child = createEncodedValueSchema(depth + 1);

    return z.discriminatedUnion("type", [
      z.object({ type: z.literal("undefined") }),
      z.object({ type: z.literal("primitive"), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
      z.object({ type: z.literal("bigint"), value: z.string().check(z.regex(/^-?\d+$/)) }),
      z.object({ type: z.literal("date"), value: z.iso.datetime() }),
      z.object({ type: z.enum(["bytes", "array_buffer"]), value: z.base64() }),
      z.object({ type: z.literal("array"), value: z.array(child) }),
      z.object({ type: z.literal("object"), value: z.array(z.tuple([z.string(), child])) }),
    ]);
  });
}

const EncodedValueSchema = createEncodedValueSchema(0);

/** Encode database bytes without relying on platform-specific Buffer implementations. */
export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }

  return btoa(binary);
}

/** Preserve database values across the VM's JSON-only callback boundary. */
export function encodeDatabaseValue(value: unknown, depth = 0): EncodedValue {
  if (depth > 64) {
    throw new TypeError("Database transport nesting exceeds 64 levels");
  }

  if (value === undefined) {
    return { type: "undefined" };
  }

  if (typeof value === "bigint") {
    return { type: "bigint", value: String(value) };
  }

  if (value instanceof Date) {
    return { type: "date", value: value.toISOString() };
  }

  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    return { type: value instanceof ArrayBuffer ? "array_buffer" : "bytes", value: encodeBytes(bytes) };
  }

  if (Array.isArray(value)) {
    return { type: "array", value: value.map((entry: unknown) => encodeDatabaseValue(entry, depth + 1)) };
  }

  if (value !== null && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Unsupported database transport object");
    }

    return {
      type: "object",
      value: Object.entries(value).map(([key, entry]: [string, unknown]) => [
        key,
        encodeDatabaseValue(entry, depth + 1),
      ]),
    };
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { type: "primitive", value };
  }

  throw new TypeError("Unsupported database transport value");
}

/** Validate a database transport value, including its 64-level nesting limit, before decoding it. */
export function decodeDatabaseValue(input: unknown): unknown {
  const result = EncodedValueSchema.safeParse(input);

  if (!result.success) {
    throw new TypeError("Invalid database transport value", { cause: result.error });
  }

  return decodeValue(result.data);
}

function decodeValue(value: EncodedValue): unknown {
  switch (value.type) {
    case "undefined":
      return undefined;
    case "primitive":
      return value.value;
    case "bigint":
      return BigInt(value.value);
    case "date":
      return new Date(value.value);
    case "bytes":
      return Uint8Array.from(atob(value.value), (character) => character.charCodeAt(0));
    case "array_buffer":
      return Uint8Array.from(atob(value.value), (character) => character.charCodeAt(0)).buffer;
    case "array":
      return value.value.map(decodeValue);
    case "object":
      return Object.fromEntries(value.value.map(([key, entry]) => [key, decodeValue(entry)]));
  }
}
