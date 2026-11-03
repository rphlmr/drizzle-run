import { describe, expect, it } from "vitest";

import { makeExecutionResult } from "../../test/quickjs/runner-fixture.ts";
import { decodeResult, ExecutionResultSchema } from "./contract.ts";

describe("QuickJS value boundary", () => {
  it("should preserve typed values and treat special object keys as own data", () => {
    const result = decodeResult({
      type: "object",
      value: [
        ["__proto__", { type: "primitive", value: "own value" }],
        [
          "values",
          {
            type: "array",
            value: [
              { type: "undefined" },
              { type: "bigint", value: "9007199254740993" },
              { type: "date", value: "2024-01-02T03:04:05.000Z" },
              { type: "bytes", value: [0, 255] },
            ],
          },
        ],
      ],
    });

    expect(result).toEqual(
      Object.fromEntries([
        ["__proto__", "own value"],
        ["values", [undefined, 9_007_199_254_740_993n, new Date("2024-01-02T03:04:05.000Z"), Uint8Array.of(0, 255)]],
      ]),
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it.each([
    { type: "bytes", value: [256] },
    { type: "bigint", value: "1.5" },
    { type: "date", value: "not a date" },
  ])("should reject malformed $type values at entry", (value) => {
    expect(() => decodeResult(value)).toThrow(/Invalid|Too big/);
  });
});

describe("QuickJS result boundary", () => {
  it("should require success output and attributed failures", () => {
    expect(ExecutionResultSchema.safeParse(makeExecutionResult()).success).toBe(true);
    expect(ExecutionResultSchema.safeParse({ status: "success" }).success).toBe(false);
    expect(ExecutionResultSchema.safeParse({ status: "error" }).success).toBe(false);
    expect(ExecutionResultSchema.safeParse({ status: "cancelled" }).success).toBe(false);
  });
});
