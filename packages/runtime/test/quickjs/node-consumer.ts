import type { RunManifest } from "@drizzle-run/core/manifest";
import type { ExecutionResult } from "@drizzle-run/runtime/quickjs";
import { decodeResult } from "@drizzle-run/runtime/quickjs";
import { createNodeRunner, runNodeComparison } from "@drizzle-run/runtime/quickjs/node";

/** Compile the distributed public API with Node libraries only. */
export async function executeManifest(manifest: RunManifest): Promise<ExecutionResult> {
  const runner = await createNodeRunner();

  try {
    const result = await runner.run(manifest, { signal: AbortSignal.timeout(10_000) });

    if (result.status === "success") {
      decodeResult(result.value);
    } else {
      result.error.message.toUpperCase();
    }

    return result;
  } finally {
    await runner.close();
  }
}

/** A Node consumer can compare manifests without importing machine or browser types. */
export function compareManifests(manifest: RunManifest) {
  return runNodeComparison({ a: manifest, b: manifest }, { mode: "sequential" });
}
