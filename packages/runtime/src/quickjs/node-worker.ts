import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";

import * as z from "zod/mini";

import { createExecutionDatabase } from "./database-client.ts";
import { toExecutionError } from "./errors.ts";
import { loadNodeAssets } from "./node-assets.ts";
import { selectGuest } from "./selection.ts";
import { SnapshotSchema, WorkerRequestSchema } from "./worker-contract.ts";
import { executeWorkerRun } from "./worker-run.ts";

const NodeRequestSchema = z.object({
  ...WorkerRequestSchema.shape,
  assets: z.optional(WorkerRequestSchema.shape.assets),
  template: z.optional(z.omit(SnapshotSchema, { memory: true })),
  templatePath: z.string(),
  directory: z.url(),
});

// The browser esbuild implementation runs in this process without a compiler subprocess.
Object.defineProperty(globalThis, "self", { value: globalThis });

process.once("message", (message: unknown) => {
  void executeRequest(message).catch((cause: unknown) => {
    process.send?.({
      type: "result",
      result: { status: "error", error: toExecutionError({ cause, phase: "supervision" }) },
    });
  });
});

async function executeRequest(inputMessage: unknown) {
  const input = NodeRequestSchema.parse(inputMessage);
  const assets = await loadNodeAssets({ directory: new URL(input.directory), selection: selectGuest(input.manifest) });
  const template = input.template ? { ...input.template, memory: await readFile(input.templatePath) } : undefined;
  const result = await executeWorkerRun({
    request: {
      manifest: input.manifest,
      mode: input.mode,
      debug: input.debug,
      queryPlans: input.queryPlans,
      assets,
      template,
    },
    send(workerMessage) {
      if (workerMessage.type === "template") {
        // Publish only after the file is complete, so cancellation cannot retain a partial template.
        writeFileSync(input.templatePath, workerMessage.template.memory);
      }

      process.send?.(workerMessage);
    },
    createDatabase(dialect, databaseTemplate) {
      const worker = new Worker(new URL("./node-database-worker.js", import.meta.url));

      return createExecutionDatabase({
        dialect,
        template: databaseTemplate,
        transport: {
          postMessage: (message) => worker.postMessage(message),
          async terminate() {
            await worker.terminate();
          },
          subscribe(onMessage, onError) {
            worker.on("message", onMessage);
            worker.on("error", onError);
            worker.on("messageerror", onError);
          },
        },
      });
    },
  });
  process.send?.({ type: "result", result });
}
