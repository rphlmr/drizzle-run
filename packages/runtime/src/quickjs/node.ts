import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runComparison } from "./comparison.ts";
import type { ComparisonOptions, ComparisonSide, ExecutionMode, QuickjsRunner } from "./contract.ts";
import { QuickjsManifestSchema } from "./contract.ts";
import { loadNodeAssets } from "./node-assets.ts";
import { createRunner } from "./runner.ts";
import { selectGuest, type GuestSelection } from "./selection.ts";

export interface NodeRunnerOptions {
  directory?: URL;
  mode?: ExecutionMode;
  signal?: AbortSignal;
  selection?: GuestSelection;
  verifyAsset?: (name: string, bytes: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Own a disposable process per execution and a private snapshot until close.
 * Uses packaged assets by default; `directory` may point to a custom asset directory.
 */
export async function createNodeRunner({
  directory = new URL("./", import.meta.url),
  mode,
  signal,
  selection,
  verifyAsset,
}: NodeRunnerOptions = {}): Promise<QuickjsRunner> {
  const assets = await loadNodeAssets({ directory, signal, selection, verifyAsset });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "drizzle-run-quickjs-"));
  const templatePath = join(temporaryDirectory, "snapshot.bin");

  try {
    const runner = createRunner({
      assets,
      mode,
      createWorker() {
        const sourceArguments = new Set(["--input-type", "--eval", "-e", "--print", "-p"]);
        const execArgv = process.execArgv.filter(
          (argument, index, args) =>
            !sourceArguments.has(argument) &&
            !/^(?:--input-type|--eval|--print)=/.test(argument) &&
            !sourceArguments.has(args[index - 1]),
        );
        const executionProcess = fork(new URL("node-worker.js", directory), [], {
          execArgv,
          serialization: "advanced",
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        const stopped = new Promise<void>((resolve) => executionProcess.once("close", () => resolve()));

        return {
          listen(receive, fail) {
            executionProcess.on("message", receive);
            executionProcess.on("error", fail);
            executionProcess.once("exit", (code, exitSignal) =>
              fail(new Error(`QuickJS execution process exited (${exitSignal ?? code})`)),
            );
          },
          send({ assets: _assets, template, ...request }) {
            executionProcess.send(
              {
                ...request,
                directory: directory.href,
                templatePath,
                template: template ? { ...template, memory: undefined } : undefined,
              },
              (cause) => {
                if (cause) {
                  executionProcess.emit("error", cause);
                }
              },
            );
          },
          async terminate() {
            if (executionProcess.exitCode === null && executionProcess.signalCode === null) {
              executionProcess.kill("SIGKILL");
            }

            await stopped;
          },
        };
      },
    });

    async function close() {
      runner.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }

    return { run: runner.run, close };
  } catch (cause) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw cause;
  }
}

/** Execute two catalog-supported runs selected by their manifests and deliver each after teardown. */
export function runNodeComparison(
  manifests: Record<ComparisonSide, unknown>,
  { directory, ...options }: ComparisonOptions & Pick<NodeRunnerOptions, "directory"> = {},
) {
  return runComparison({
    createChild: (manifest, signal) =>
      createNodeRunner({ directory, signal, selection: selectGuest(QuickjsManifestSchema.parse(manifest)) }),
    manifests,
    options,
  });
}
