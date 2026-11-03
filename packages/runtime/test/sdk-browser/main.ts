import { createBrowserRuntime } from "@drizzle-run/runtime/browser";

import { makeSdkManifest, toSemanticResult } from "../sdk-corpus.ts";

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing SDK acceptance element: ${id}`);
  }

  return element;
}

const status = getElement("status");
const output = getElement("results");
getElement("run").addEventListener("click", () => {
  void runCorpus();
});
async function runCorpus() {
  const runtime = createBrowserRuntime({ assetBaseUrl: "/sdk-assets/", preparation: "on_demand" });
  const results: {
    dialect: "postgresql" | "sqlite";
    release: "legacy" | "next";
    result: ReturnType<typeof toSemanticResult>;
  }[] = [];
  try {
    for (const dialect of ["postgresql", "sqlite"] as const) {
      for (const release of ["legacy", "next"] as const) {
        status.textContent = `Running ${dialect} ${release}`;
        const run = runtime.createRun(makeSdkManifest({ dialect, releaseLine: release }), {
          signal: AbortSignal.timeout(90_000),
        });
        run.start();
        const result = await run.result;
        results.push({ dialect, release, result: toSemanticResult(result) });
        output.textContent = JSON.stringify(results, null, 2);
        if (!result.ok) {
          throw new Error(JSON.stringify(result.error));
        }
      }
    }
    status.textContent = "PASS: four browser SDK runs completed";
  } catch (cause) {
    status.textContent = `FAIL: ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    await runtime.dispose();
  }
}
