/** A JSON primitive kept as is. */
export type SerializedPrimitive = null | boolean | number | string;

/** A value from a run made safe to send across realms and store as JSON. */
export type SerializedValue =
  | { type: "undefined" }
  | { type: "primitive"; value: SerializedPrimitive }
  | { type: "bigint"; value: string }
  | { type: "date"; value: string }
  | { type: "array"; value: readonly SerializedValue[] }
  | { type: "object"; value: Readonly<Record<string, SerializedValue>> }
  | { type: "unsupported"; valueType: string; description?: string }
  | { type: "circular"; path: string };

/** An error made safe to send across realms, with its cause chain. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

/** How deep a serialized value nests; a value past it becomes an `unsupported` entry one level below. */
export const MAX_SERIALIZED_DEPTH = 64;

const MAX_SERIALIZED_ENTRIES = 10_000;

/** How many causes a serialized error keeps; the last link says the chain was cut. */
export const MAX_SERIALIZED_ERROR_CAUSE_DEPTH = 8;

/** The most UTF-8 bytes a serialized error message, stack or output line keeps. */
export const MAX_SERIALIZED_TEXT_BYTES = 64 * 1024; // 64 KiB

/** The most UTF-8 bytes a serialized error name keeps. */
export const MAX_SERIALIZED_ERROR_NAME_BYTES = 1024; // 1 KiB

const truncationMark = "… [truncated]";

/** The serialized form of `undefined`. */
export const SERIALIZED_UNDEFINED: SerializedValue = Object.freeze({ type: "undefined" });

/**
 * Serialize a value from a run
 *
 * Never throws: getters that throw, non-finite numbers, symbols, functions, cycles, and values past the depth or
 * entry limits become `unsupported` or `circular` entries.
 */
export function serializeValue(value: unknown): SerializedValue {
  const context: SerializationContext = {
    entries: 0,
    ancestors: new Map<object, string>(),
  };

  return serializeValueAtPath(value, "$", 0, context);
}

interface SerializationContext {
  entries: number;
  /** The objects being serialized around the current value, with their paths. */
  ancestors: Map<object, string>;
}

function serializeValueAtPath(
  value: unknown,
  path: string,
  depth: number,
  context: SerializationContext,
): SerializedValue {
  if (depth > MAX_SERIALIZED_DEPTH) {
    return createUnsupported("depth", "Maximum serialization depth exceeded");
  }

  if (context.entries >= MAX_SERIALIZED_ENTRIES) {
    return createUnsupported("entry-limit", "Maximum serialization entry count exceeded");
  }

  context.entries += 1;

  if (value === undefined) {
    return SERIALIZED_UNDEFINED;
  }

  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return { type: "primitive", value };
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? { type: "primitive", value } : createUnsupported("number", toSafeString(value));
  }

  if (typeof value === "bigint") {
    return { type: "bigint", value: value.toString() };
  }

  if (typeof value === "symbol") {
    return createUnsupported("symbol", toSafeString(value));
  }

  if (typeof value === "function") {
    return createUnsupported("function", toSafeString(value));
  }

  if (typeof value !== "object") {
    return createUnsupported(typeof value, toSafeString(value));
  }

  try {
    const ancestorPath = context.ancestors.get(value);

    if (ancestorPath !== undefined) {
      return { type: "circular", path: ancestorPath };
    }

    // Only a value that contains itself is a cycle: one reached again from another branch is serialized again.
    context.ancestors.set(value, path);

    try {
      if (isDate(value)) {
        const timestamp = Date.prototype.getTime.call(value);

        return Number.isNaN(timestamp)
          ? createUnsupported("date", "Invalid Date")
          : { type: "date", value: Date.prototype.toISOString.call(value) };
      }

      if (Array.isArray(value)) {
        return serializeArray(value, path, depth, context);
      }

      return serializeObject(value, path, depth, context);
    } finally {
      context.ancestors.delete(value);
    }
  } catch {
    return createUnsupported("object", "Could not inspect value");
  }
}

function serializeArray(value: unknown[], path: string, depth: number, context: SerializationContext): SerializedValue {
  let length: number;

  try {
    length = value.length;
  } catch {
    return createUnsupported("array", "Could not read array length");
  }

  const remainingEntries = MAX_SERIALIZED_ENTRIES - context.entries;

  if (!Number.isSafeInteger(length) || length < 0 || length > remainingEntries) {
    return createUnsupported("array", "Maximum serialization entry count exceeded");
  }

  const serialized: SerializedValue[] = [];

  for (let index = 0; index < length; index += 1) {
    let entry: unknown;

    try {
      entry = Reflect.get(value, String(index));
    } catch {
      serialized.push(createUnsupported("getter", "Could not read array entry"));
      context.entries += 1;
      continue;
    }

    serialized.push(serializeValueAtPath(entry, `${path}[${index}]`, depth + 1, context));
  }

  return { type: "array", value: serialized };
}

function serializeObject(value: object, path: string, depth: number, context: SerializationContext): SerializedValue {
  let keys: string[];

  try {
    keys = Object.keys(value);
  } catch {
    return createUnsupported("object", "Could not enumerate object properties");
  }

  const remainingEntries = MAX_SERIALIZED_ENTRIES - context.entries;

  if (keys.length > remainingEntries) {
    return createUnsupported("object", "Maximum serialization entry count exceeded");
  }

  const serialized: Record<string, SerializedValue> = Object.create(null);

  for (const key of keys) {
    let entry: unknown;

    try {
      entry = Reflect.get(value, key);
    } catch {
      defineOwnEntry(serialized, key, createUnsupported("getter", "Could not read object property"));
      context.entries += 1;
      continue;
    }

    defineOwnEntry(serialized, key, serializeValueAtPath(entry, `${path}.${key}`, depth + 1, context));
  }

  return { type: "object", value: serialized };
}

function isDate(value: object): value is Date {
  try {
    Date.prototype.getTime.call(value);

    return true;
  } catch {
    return false;
  }
}

function defineOwnEntry(target: Record<string, SerializedValue>, key: string, value: SerializedValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function createUnsupported(valueType: string, description?: string): SerializedValue {
  return {
    type: "unsupported",
    valueType,
    ...(description === undefined ? {} : { description }),
  };
}

function toSafeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "Unprintable value";
  }
}

/**
 * Serialize a thrown value
 *
 * Never throws. A non-error becomes an `Error` with its text as the message; causes are followed up to
 * `MAX_SERIALIZED_ERROR_CAUSE_DEPTH`, and a cycle ends with a "Circular error cause" entry. The name, message and
 * stack are cut to the byte limits `SerializedErrorSchema` accepts.
 */
export function serializeError(value: unknown): SerializedError {
  return serializeErrorAtDepth(value, new Set<object>(), 0);
}

function serializeErrorAtDepth(value: unknown, seen: Set<object>, depth: number): SerializedError {
  if (depth >= MAX_SERIALIZED_ERROR_CAUSE_DEPTH) {
    return { name: "Error", message: "Maximum error cause depth exceeded" };
  }

  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return {
      name: "Error",
      message: truncateText(typeof value === "string" ? value : toSafeString(value), MAX_SERIALIZED_TEXT_BYTES),
    };
  }

  let isError = false;

  try {
    isError = value instanceof Error;
  } catch {
    return { name: "Error", message: "Could not inspect thrown value" };
  }

  if (!isError) {
    return { name: "Error", message: truncateText(toSafeString(value), MAX_SERIALIZED_TEXT_BYTES) };
  }

  if (seen.has(value)) {
    return { name: "Error", message: "Circular error cause" };
  }

  seen.add(value);

  const name = truncateText(readStringProperty(value, "name", "Error"), MAX_SERIALIZED_ERROR_NAME_BYTES);
  const message = truncateText(
    readStringProperty(value, "message", "Unprintable error message"),
    MAX_SERIALIZED_TEXT_BYTES,
  );
  const rawStack = readOptionalStringProperty(value, "stack");
  const stack = rawStack === undefined ? undefined : truncateText(rawStack, MAX_SERIALIZED_TEXT_BYTES);
  const cause = readProperty(value, "cause");
  let serializedCause: SerializedError | undefined;

  if (cause === value) {
    serializedCause = { name: "Error", message: "Circular error cause" };
  } else if (cause !== undefined) {
    serializedCause = serializeErrorAtDepth(cause, seen, depth + 1);
  }

  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(serializedCause === undefined ? {} : { cause: serializedCause }),
  };
}

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readStringProperty(value: object, key: string, fallback: string): string {
  const result = readProperty(value, key);

  return typeof result === "string" ? result : fallback;
}

function readOptionalStringProperty(value: object, key: string): string | undefined {
  const result = readProperty(value, key);

  return typeof result === "string" ? result : undefined;
}

/**
 * Cut text to at most `maxBytes` UTF-8 bytes
 *
 * Text that fits comes back as is. Longer text keeps whole characters up to the limit and ends with a truncation mark.
 * Counts bytes by code point, since the guest may have no `TextEncoder`.
 */
export function truncateText(text: string, maxBytes: number): string {
  // A UTF-16 unit never takes more than 3 UTF-8 bytes.
  if (text.length * 3 <= maxBytes) {
    return text;
  }

  const budget = maxBytes - getUtf8ByteLength(truncationMark);
  let bytes = 0;
  let index = 0;
  let cutIndex = 0;

  for (const character of text) {
    bytes += getCodePointByteLength(character.codePointAt(0) ?? 0);

    if (bytes <= budget) {
      cutIndex = index + character.length;
    }

    if (bytes > maxBytes) {
      return `${text.slice(0, cutIndex)}${truncationMark}`;
    }

    index += character.length;
  }

  return text;
}

function getUtf8ByteLength(text: string): number {
  let bytes = 0;

  for (const character of text) {
    bytes += getCodePointByteLength(character.codePointAt(0) ?? 0);
  }

  return bytes;
}

/** A lone surrogate counts 3 bytes, as `TextEncoder` writes it as U+FFFD. */
function getCodePointByteLength(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }

  if (codePoint < 0x800) {
    return 2;
  }

  return codePoint < 0x10000 ? 3 : 4;
}
