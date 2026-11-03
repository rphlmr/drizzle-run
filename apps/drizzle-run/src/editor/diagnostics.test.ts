import { expect, it } from "vitest";

import { resolveDiagnosticFile } from "./diagnostics";

it("should keep runtime locations and select nested files before matching basenames", () => {
  const files = ["query.ts", "helpers/query.ts"];

  expect(resolveDiagnosticFile("helpers/query.ts", files)).toBe("helpers/query.ts");
  expect(resolveDiagnosticFile("drizzle-run-project:helpers/query.ts", files)).toBe("helpers/query.ts");
  expect(resolveDiagnosticFile("file:///project/helpers/query.ts", files)).toBe("helpers/query.ts");
  expect(resolveDiagnosticFile("external.ts", files)).toBeUndefined();
});
