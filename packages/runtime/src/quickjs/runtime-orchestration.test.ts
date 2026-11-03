import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

function runScenario(source: string) {
  const build = buildSync({
    stdin: { contents: source, resolveDir: fileURLToPath(new URL("../../", import.meta.url)) },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
  });

  return spawnSync(process.execPath, ["--input-type=module", "--eval", build.outputFiles[0].text], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("comparison cancellation bridge", () => {
  it("should propagate actual SDK aggregate cleanup failure through the history controller", () => {
    const runtimeUrl = fileURLToPath(new URL("./runtime.ts", import.meta.url));
    const controllerUrl = fileURLToPath(
      new URL("../../../orchestration/src/runtime-comparison-controller.ts", import.meta.url),
    );
    const historyUrl = fileURLToPath(new URL("../../../orchestration/src/run-controller.ts", import.meta.url));
    const pairUrl = fileURLToPath(new URL("../../../core/src/pair/operations.ts", import.meta.url));
    const source = `
      import assert from "node:assert/strict";
      import { createQuickjsRuntime } from ${JSON.stringify(runtimeUrl)};
      import { createRuntimeComparisonController } from ${JSON.stringify(controllerUrl)};
      import { createRunController } from ${JSON.stringify(historyUrl)};
      import { pairSide } from ${JSON.stringify(pairUrl)};

      let next = 0;
      const runtime = createQuickjsRuntime({
        checkCapabilities: async () => ({ status: "available", reasons: [] }),
        createRunner: async () => {
          const side = next++;

          return {
            async run(_manifest, options) {
              options.onMessage({ kind: "report", outcome: "succeeded", value: { type: "undefined" } });

              return { status: "success", sql: [], value: { type: "undefined" }, displays: [] };
            },
            close() {
              if (side === 0) {
                throw new Error("Expected comparison cleanup failure");
              }
            },
          };
        },
      });
      const manifest = {
        kind: "drizzle-run-pair",
        manifestVersion: 1,
        entrypoints: { schema: "schema.ts" },
        files: { "schema.ts": "export {};" },
        sides: [0, 1].map(() => ({
          target: { dialect: "sqlite" },
          dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
          files: {},
        })),
      };
      const histories = [createRunController(), createRunController()];
      const controller = createRuntimeComparisonController({
        getRuntime: () => runtime,
        getManifest: () => manifest,
        runSide: ({ side, runtime, signal, manifest }) => histories[side].submit(
          { manifest: pairSide(manifest, side), revision: 1, debug: false },
          { runtime, signal },
        ),
      });

      await assert.rejects(controller.submit(), /Expected comparison cleanup failure/);
      assert.equal(controller.getState().status, "failed");
      assert.match(controller.getState().error, /Expected comparison cleanup failure/);
      assert.deepEqual(histories.map((history) => history.getState().history.length), [1, 1]);
      await assert.rejects(controller.dispose(), /Expected comparison cleanup failure/);
      await assert.rejects(runtime.dispose(), /Expected comparison cleanup failure/);
      await Promise.all(histories.map((history) => history.dispose()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      console.log("History controller retained SDK cleanup failure");
    `;

    const result = runScenario(source);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("History controller retained SDK cleanup failure");
  });

  it("should retain cleanup rejection on the aggregate without an unhandled abort rejection", () => {
    const runtimeUrl = fileURLToPath(new URL("./runtime.ts", import.meta.url));
    const source = `
      import assert from "node:assert/strict";
      import { createQuickjsRuntime } from ${JSON.stringify(runtimeUrl)};

      const executing = Promise.withResolvers();
      let active = 0;
      const runtime = createQuickjsRuntime({
        checkCapabilities: async () => ({ status: "available", reasons: [] }),
        createRunner: async () => ({
          async run(_manifest, options) {
            active++;

            if (active === 2) {
              executing.resolve();
            }

            await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));

            return { status: "cancelled", error: { phase: "run", message: "Cancelled" }, workerTerminated: true };
          },
          close() {
            throw new Error("Expected comparison cleanup failure");
          },
        }),
      });
      const manifest = {
        kind: "drizzle-run",
        manifestVersion: 1,
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
        files: { "schema.ts": "export {};" },
        entrypoints: { schema: "schema.ts" },
      };
      const cancellation = new AbortController();
      const comparison = runtime.createComparison({ a: manifest, b: manifest }, { signal: cancellation.signal });
      const result = comparison.result.catch((cause) => cause);
      comparison.start();
      await executing.promise;

      cancellation.abort();
      assert.ok(await result instanceof Error);
      await assert.rejects(runtime.dispose());
      await new Promise((resolve) => setTimeout(resolve, 0));
      console.log("Comparison cleanup rejection was handled");
    `;

    const result = runScenario(source);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Comparison cleanup rejection was handled");
  });
});
