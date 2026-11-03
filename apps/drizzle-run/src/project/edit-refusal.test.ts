import { RunManifestValidationError } from "@drizzle-run/core/manifest";
import { describe, expect, it } from "vitest";

import { toEditRefusalText } from "./edit-refusal";

describe("toEditRefusalText", () => {
  it("should say the edit was not saved, with the manifest's issue messages and no field paths", () => {
    const cause = new RunManifestValidationError([
      {
        path: ["files"],
        code: "LIMIT_EXCEEDED",
        message: "Project source may contain at most 1048576 UTF-8 bytes in total.",
      },
    ]);

    expect(toEditRefusalText(cause)).toBe(
      "This edit was not saved, so the file is back to its saved text. Project source may contain at most 1048576 UTF-8 bytes in total.",
    );
  });

  it("should give any other error's text", () => {
    expect(toEditRefusalText(new Error("Storage is full."))).toBe(
      "This edit was not saved, so the file is back to its saved text. Storage is full.",
    );
  });
});
