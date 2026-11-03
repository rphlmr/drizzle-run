import { createExecutionDatabase } from "./database-client.ts";
import { toExecutionError } from "./errors.ts";
import { WorkerRequestSchema } from "./worker-contract.ts";
import { executeWorkerRun } from "./worker-run.ts";

globalThis.addEventListener(
  "message",
  (event: MessageEvent<unknown>) => {
    void executeRequest(event.data).catch((cause: unknown) => {
      postMessage({
        type: "result",
        result: { status: "error", error: toExecutionError({ cause, phase: "supervision" }) },
      });
    });
  },
  { once: true },
);

async function executeRequest(inputMessage: unknown) {
  const request = WorkerRequestSchema.parse(inputMessage);
  const result = await executeWorkerRun({
    request,
    send: (reply, transfer = []) => postMessage(reply, { transfer }),
    createDatabase(dialect, template) {
      const workerUrl = new URL("./database-worker.js", import.meta.url);

      const worker = new Worker(workerUrl, { type: "module" });

      return createExecutionDatabase({
        dialect,
        template,
        transport: {
          postMessage: (message) => worker.postMessage(message),
          terminate: () => worker.terminate(),
          subscribe(onMessage, onError) {
            worker.addEventListener("message", (event: MessageEvent<unknown>) => onMessage(event.data));
            worker.addEventListener("error", (event) => onError(new Error(event.message)));
            worker.addEventListener("messageerror", () =>
              onError(new Error("Database worker message could not be decoded")),
            );
          },
        },
      });
    },
  });
  postMessage({ type: "result", result });
}
