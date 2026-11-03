import { describe, expect, it } from "vitest";

import { MAX_SERIALIZED_TEXT_BYTES, serializeError, serializeValue, truncateText } from "./serialization.ts";

describe("serializeValue", () => {
  it.each([
    [undefined, { type: "undefined" }],
    [false, { type: "primitive", value: false }],
    [0, { type: "primitive", value: 0 }],
    ["", { type: "primitive", value: "" }],
    [null, { type: "primitive", value: null }],
    [1n, { type: "bigint", value: "1" }],
  ])("should preserve %p", (value, expected) => {
    expect(serializeValue(value)).toEqual(expected);
  });

  it("should mark an object that contains itself as circular without recursing forever", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(serializeValue(value)).toEqual({
      type: "object",
      value: { self: { type: "circular", path: "$" } },
    });
  });

  it("should serialize a value reached from two branches in full both times", () => {
    const user = { id: 1 };
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const serializedUser = { type: "object", value: { id: { type: "primitive", value: 1 } } };
    const serializedDate = { type: "date", value: "2026-01-01T00:00:00.000Z" };

    const serialized = serializeValue({ users: [user], first: user, createdAt, updatedAt: createdAt });

    expect(serialized).toEqual({
      type: "object",
      value: {
        users: { type: "array", value: [serializedUser] },
        first: serializedUser,
        createdAt: serializedDate,
        updatedAt: serializedDate,
      },
    });
  });

  it("should return an unsupported value when nested data exceeds the depth limit", () => {
    let value: Record<string, unknown> = {};
    const root = value;

    for (let depth = 0; depth < 80; depth += 1) {
      const child: Record<string, unknown> = {};
      value.child = child;
      value = child;
    }

    value.leaf = true;

    let serialized = serializeValue(root);

    for (let depth = 0; depth < 65; depth += 1) {
      if (serialized.type !== "object") {
        break;
      }

      serialized = serialized.value.child;
    }

    expect(serialized).toMatchObject({
      type: "unsupported",
      valueType: "depth",
    });
  });

  it("should bound the number of serialized entries", () => {
    const oversized = Array.from({ length: 20_000 }, (_, index) => index);

    expect(serializeValue(oversized)).toMatchObject({
      type: "unsupported",
      valueType: "array",
    });
    expect(serializeValue(Array.from({ length: 9_999 }, (_, index) => index))).toMatchObject({
      type: "array",
      value: expect.any(Array),
    });
  });

  it("should preserve an own __proto__ property without changing the result prototype", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const serialized = serializeValue(input);

    expect(serialized.type).toBe("object");

    if (serialized.type !== "object") {
      return;
    }

    expect(Object.getPrototypeOf(serialized.value)).toBe(null);
    expect(Object.hasOwn(serialized.value, "__proto__")).toBe(true);
    expect(serialized.value["__proto__"]).toEqual({
      type: "object",
      value: { polluted: { type: "primitive", value: true } },
    });
  });

  it("should convert throwing getters and proxy traps into unsupported values", () => {
    const input = Object.defineProperty({}, "broken", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });
    const throwingGet = new Proxy(
      { value: 1 },
      {
        get(target, key, receiver) {
          if (key === "value") {
            throw new Error("proxy get failed");
          }

          return Reflect.get(target, key, receiver);
        },
      },
    );
    const throwingKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy ownKeys failed");
        },
      },
    );

    expect(serializeValue(input)).toMatchObject({
      type: "object",
      value: { broken: { type: "unsupported", valueType: "getter" } },
    });
    expect(serializeValue(throwingGet)).toMatchObject({
      type: "object",
      value: { value: { type: "unsupported", valueType: "getter" } },
    });
    expect(serializeValue(throwingKeys)).toMatchObject({
      type: "unsupported",
      valueType: "object",
    });
    expect(serializeValue(Symbol("key"))).toMatchObject({
      type: "unsupported",
      valueType: "symbol",
    });
  });
});

describe("serializeError", () => {
  it("should limit self-referential and deeply nested error causes", () => {
    const selfCause = new Error("self");
    Object.defineProperty(selfCause, "cause", { value: selfCause });

    let cause: Error = new Error("leaf");

    for (let index = 0; index < 100; index += 1) {
      const parent = new Error(`cause-${index}`);
      Object.defineProperty(parent, "cause", { value: cause });
      cause = parent;
    }

    expect(serializeError(selfCause)).toMatchObject({
      name: "Error",
      message: "self",
      cause: { name: "Error", message: "Circular error cause" },
    });

    let serialized = serializeError(cause);
    let causeDepth = 0;

    while (serialized.cause !== undefined) {
      serialized = serialized.cause;
      causeDepth += 1;
    }

    expect(causeDepth).toBe(8);
    expect(serialized.message).toBe("Maximum error cause depth exceeded");
  });

  it("should survive throwing error getters and hostile thrown values", () => {
    const error = new Error("original");

    Object.defineProperties(error, {
      name: {
        get() {
          throw new Error("name getter failed");
        },
      },
      message: {
        get() {
          throw new Error("message getter failed");
        },
      },
      cause: {
        get() {
          throw new Error("cause getter failed");
        },
      },
    });

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap failed");
        },
      },
    );

    expect(serializeError(error)).toMatchObject({
      name: "Error",
      message: "Unprintable error message",
    });
    expect(serializeError(hostile)).toEqual({
      name: "Error",
      message: "Could not inspect thrown value",
    });
  });
});

describe("truncateText", () => {
  it("should keep text within the limit as is", () => {
    expect(truncateText("é".repeat(10), 20)).toBe("é".repeat(10));
  });

  it("should cut text past the limit to whole characters within the byte limit", () => {
    const truncated = truncateText("😀".repeat(100), 50);

    expect(truncated.endsWith("… [truncated]")).toBe(true);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(50);
    expect(truncated).not.toContain("\uFFFD");
  });

  it("should cut an error message and stack to the serialized text limit", () => {
    const error = new Error(`Failed query: ${"x".repeat(MAX_SERIALIZED_TEXT_BYTES)}`);
    error.stack = "s".repeat(MAX_SERIALIZED_TEXT_BYTES + 1);

    const serialized = serializeError(error);

    expect(new TextEncoder().encode(serialized.message).byteLength).toBeLessThanOrEqual(MAX_SERIALIZED_TEXT_BYTES);
    expect(new TextEncoder().encode(serialized.stack ?? "").byteLength).toBeLessThanOrEqual(MAX_SERIALIZED_TEXT_BYTES);
    expect(serialized.message.startsWith("Failed query: xxx")).toBe(true);
  });
});
