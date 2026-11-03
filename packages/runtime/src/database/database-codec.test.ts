import { describe, expect, it } from "vitest";

import { decodeDatabaseValue, encodeBytes, encodeDatabaseValue } from "./database-codec.ts";

function makeNestedValue(depth: number): unknown {
  let value: unknown = null;

  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }

  return value;
}

function makeEncodedNestedValue(depth: number): unknown {
  let value: unknown = { type: "primitive", value: null };

  for (let index = 0; index < depth; index += 1) {
    value = { type: "array", value: [value] };
  }

  return value;
}

describe("database transport codec", () => {
  it("should preserve database primitives, dates, bigints and binary representations", () => {
    const value = {
      empty: undefined,
      primitives: [null, true, false, 0, -1.25, "Élodie"],
      id: 9_007_199_254_740_993n,
      date: new Date("2026-11-03T12:00:00.000Z"),
      bytes: new Uint8Array([0, 127, 255]),
      buffer: new Uint8Array([255, 0, 128]).buffer,
    };

    expect(decodeDatabaseValue(encodeDatabaseValue(value))).toEqual(value);
  });

  it("should encode large byte arrays across base64 chunk boundaries", () => {
    const bytes = Uint8Array.from({ length: 20_000 }, (_, index) => index % 256);

    expect(encodeBytes(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(decodeDatabaseValue(encodeDatabaseValue(bytes))).toEqual(bytes);
  });

  it("should accept 64 nested values and refuse deeper encoding or decoding", () => {
    const value = makeNestedValue(64);

    expect(decodeDatabaseValue(encodeDatabaseValue(value))).toEqual(value);
    expect(() => encodeDatabaseValue(makeNestedValue(65))).toThrow("nesting exceeds 64 levels");
    expect(() => decodeDatabaseValue(makeEncodedNestedValue(65))).toThrow("Invalid database transport value");
  });

  it("should reject deeply nested untrusted input without exhausting the call stack", () => {
    let rejection: unknown;

    try {
      decodeDatabaseValue(makeEncodedNestedValue(10_000));
    } catch (cause) {
      rejection = cause;
    }

    expect(rejection).toBeDefined();
    expect(rejection).not.toBeInstanceOf(RangeError);
  });

  it.each([
    null,
    { type: "unknown" },
    { type: "primitive", value: Infinity },
    { type: "primitive", value: NaN },
    { type: "bigint", value: "1.5" },
    { type: "date", value: "invalid" },
    { type: "bytes", value: "not base64!" },
    { type: "array_buffer", value: "AAA" },
    { type: "array", value: [1] },
    { type: "object", value: [[1, { type: "undefined" }]] },
    { type: "object", value: [["key"]] },
  ])("should reject malformed database transport values: %j", (value) => {
    expect(() => decodeDatabaseValue(value)).toThrow("Invalid database transport value");
  });

  it.each([NaN, Infinity, () => {}, Symbol("value"), new Map(), new Set()])(
    "should reject unsupported runtime values: %s",
    (value) => {
      expect(() => encodeDatabaseValue(value)).toThrow("Unsupported database transport");
    },
  );

  it("should preserve prototype-shaped keys as own properties without changing the decoded prototype", () => {
    const value = decodeDatabaseValue({
      type: "object",
      value: [["__proto__", { type: "primitive", value: "database value" }]],
    });

    expect(value).toEqual(Object.fromEntries([["__proto__", "database value"]]));
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});
