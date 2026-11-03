import type { ComparisonHandle, ComparisonResult, Runtime, RunHandle } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { createNodeRuntime } from "@drizzle-run/runtime/node";

async function execute(manifest: RunManifest) {
  await using runtime: Runtime = createNodeRuntime();
  const run: RunHandle = runtime.createRun(manifest);
  run.start();
  return await run.result;
}

async function compare(a: RunManifest, b: RunManifest): Promise<ComparisonResult> {
  await using runtime: Runtime = createNodeRuntime();
  const comparison: ComparisonHandle = runtime.createComparison({ a, b }, { execution: "sequential" });
  comparison.sides.a.subscribe((snapshot) => void snapshot.phase);
  comparison.start();

  return await comparison.result;
}

void execute;
void compare;
