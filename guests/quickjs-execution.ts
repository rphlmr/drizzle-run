import type { RunManifest } from "../packages/core/src/manifest/index.ts";
import { configureProjectFiles } from "../packages/runtime/scripts/quickjs/filesystem.ts";
import { createPlaygroundTools, createRandomGenerator } from "../packages/runtime/src/determinism/tools.ts";
import type { SerializedValue } from "../packages/runtime/src/quickjs/contract.ts";
import { encodeResult } from "./quickjs-client.ts";
import { createRunObservation } from "./quickjs-observation.ts";

/** Initialize per-run globals only after the dependency snapshot has been captured or restored. */
export function initializeExecution(manifest: RunManifest, seed: number): void {
  const observation = createRunObservation();
  const console = Object.fromEntries(
    (["log", "warn", "error", "debug", "info"] as const).map((level) => [
      level,
      (...values: unknown[]) => observation.log(level, values),
    ]),
  );
  Object.assign(globalThis, { __observation: observation, console });
  Object.assign(globalThis, { __runManifest: manifest });
  configureProjectFiles(manifest.files);
  Math.random = createRandomGenerator(seed);
  const displays: { label: string; values: SerializedValue }[] = [];
  const tools = createPlaygroundTools({
    seed,
    display(label, values) {
      displays.push({ label, values: encodeResult(values) });
      observation.display(label, values);
    },
  });
  Object.assign(globalThis, { __displays: displays, $: tools });
}

/** Apply PostgreSQL migration statements atomically using the run's guest client. */
export async function applyPostgresBootstrap({
  client,
  statements,
}: {
  client: { query: (sql: string) => Promise<unknown> };
  statements: readonly string[];
}): Promise<void> {
  await client.query("BEGIN");

  try {
    for (const statement of statements) {
      await client.query(statement);
    }

    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  }
}
