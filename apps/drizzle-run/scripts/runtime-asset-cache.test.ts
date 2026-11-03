import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as z from "zod/mini";

const TurboRunSchema = z.object({
  tasks: z.array(
    z.object({
      taskId: z.string(),
      inputs: z.record(z.string(), z.string()),
      outputs: z.nullish(z.array(z.string())),
    }),
  ),
});

describe("runtime asset cache", () => {
  it("should cache immutable runtime assets and SDK output in one task", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const output = execFileSync(
      `${root}node_modules/.bin/turbo`,
      ["run", "build", "--filter=@drizzle-run/runtime", "--dry=json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    const run = TurboRunSchema.parse(JSON.parse(output));
    const task = run.tasks.find((task) => task.taskId === "@drizzle-run/runtime#build");

    expect(task?.inputs["scripts/build-quickjs.ts"]).toEqual(expect.any(String));
    expect(task?.outputs).toEqual(
      expect.arrayContaining([
        "dist/**",
        "src/assets/*.generated.ts",
        "../../.cache/runtime-assets/r2/**",
        "../../.cache/runtime-assets/quickjs/**",
      ]),
    );
  });
});
