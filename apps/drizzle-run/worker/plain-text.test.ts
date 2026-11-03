import type { PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { readListedSnapshot } from "./listed-snapshot";
import { hasControlCharacter, removeControlCharacters, truncateCharacters } from "./plain-text";
import { toSnapshotSummaryJson } from "./snapshot-summary";

function makeNamedSnapshot(name: string): PlaygroundSnapshot {
  return {
    snapshotVersion: 1,
    name,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      files: { "schema.ts": "", "query.ts": "" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
    },
  };
}

describe("plain text", () => {
  it("should find and drop C0 control characters and DEL, and keep every other character", () => {
    expect(hasControlCharacter("Soft deletes, 🌱 é")).toBe(false);
    expect(hasControlCharacter("\u0000abc")).toBe(true);
    expect(hasControlCharacter("a\u007fb")).toBe(true);
    expect(removeControlCharacters("\u0000Soft\u0007 deletes\u007f")).toBe("Soft deletes");
  });

  it("should turn a tab or a line break into a space", () => {
    expect(removeControlCharacters("Users\tposts\r\nand\ncomments")).toBe("Users posts  and comments");
  });

  it("should cut text by characters, keeping an emoji whole", () => {
    expect(truncateCharacters("ab🌱cd", 3)).toBe("ab🌱");
    expect("ab🌱cd".slice(0, 3)).not.toBe("ab🌱");
  });

  it("should list a snapshot whose name holds a control character under its name without it", async () => {
    const listed = readListedSnapshot(await toSnapshotSummaryJson(makeNamedSnapshot("\u0000Soft deletes")));

    expect(listed.title).toBe("Soft deletes");
  });

  it("should keep a listed title's words apart and its last emoji whole at the length limit", async () => {
    const listed = readListedSnapshot(
      await toSnapshotSummaryJson(makeNamedSnapshot(`Users\tposts ${"a".repeat(147)}🌱🌱`)),
    );

    expect(listed.title).toBe(`Users posts ${"a".repeat(147)}🌱`);
  });
});
