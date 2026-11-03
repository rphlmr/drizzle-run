import { RUN_ERROR_DIAGNOSTIC_CODE } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { createErrorLocator } from "./source-location.ts";

const sourceMap = JSON.stringify({
  sources: ["drizzle-run-runtime:controller", "drizzle-run-project:query.ts"],
  mappings: "AAAA;ACEE,K",
});

function makeError({ message, stack, cause }: { message: string; stack: string; cause?: unknown }) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.stack = stack;

  return error;
}

describe("createErrorLocator", () => {
  it.each(["Error: broken\n    at run (drizzle-run-bundle.js:2:3)", "run@drizzle-run-bundle.js:2:3"])(
    "should recognize browser stack frames: %s",
    (stack) => {
      const error = makeError({ message: "broken", stack });

      expect(createErrorLocator(sourceMap)(error)).toEqual({
        severity: "error",
        code: RUN_ERROR_DIAGNOSTIC_CODE,
        message: "broken",
        source: "query.ts",
        line: 3,
        column: 3,
      });
    },
  );

  it("should follow causes but not attribute external or unmapped frames to project code", () => {
    const cause = makeError({ message: "inner", stack: "at drizzle-run-bundle.js:2:3" });
    const error = makeError({ message: "outer", stack: "at driver.js:12:1", cause });

    expect(createErrorLocator(sourceMap)(error)?.source).toBe("query.ts");

    for (const stack of ["at driver.js:2:3", "at drizzle-run-bundle.js:1:1", "at drizzle-run-bundle.js:2:9"]) {
      const external = makeError({ message: "external", stack });
      expect(createErrorLocator(sourceMap)(external)).toBeUndefined();
    }
  });

  it("should read the message of an error-like object from another realm", () => {
    const error = { name: "Error", message: "boom", stack: "at drizzle-run-bundle.js:2:3" };

    expect(createErrorLocator(sourceMap)(error)?.message).toBe("boom");
  });
});
