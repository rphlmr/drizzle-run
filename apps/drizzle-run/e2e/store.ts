import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import type { StoreOperationName, StoreOperations, StoreRequest, StoreResponse } from "../src/store/service";

const builtAssets = fileURLToPath(new URL("../dist/client/assets/", import.meta.url));
let storeWorkerPath: string | undefined;

/** The built store worker's path on the e2e server, such as `/assets/store.worker-a1b2c3.js`. */
export function getStoreWorkerPath(): string {
  if (storeWorkerPath !== undefined) {
    return storeWorkerPath;
  }

  const file = readdirSync(builtAssets).find((name) => /^store\.worker-[\w-]+\.js$/.test(name));

  if (file === undefined) {
    throw new Error(`Expected a built store worker (store.worker-*.js) in ${builtAssets}. Run \`pnpm run build\`.`);
  }

  storeWorkerPath = `/assets/${file}`;

  return storeWorkerPath;
}

/**
 * Call one operation of the app's local store, as the app would
 *
 * It starts a fresh instance of the built store worker in the page's origin, so the call takes the same cross-tab
 * lock and runs the same migrations as the app. A page that is not on the app's origin yet first opens the worker
 * script itself, which loads no app code.
 */
export async function callStore<Name extends StoreOperationName>(
  page: Page,
  operation: Name,
  ...args: Parameters<StoreOperations[Name]>
): Promise<Awaited<ReturnType<StoreOperations[Name]>>> {
  const workerPath = getStoreWorkerPath();

  if (!page.url().startsWith("http")) {
    await page.goto(workerPath);
  }

  const request = { id: 1, operation, args } as StoreRequest;
  const result = await page.evaluate(
    ({ path, message }) =>
      new Promise<unknown>((resolve, reject) => {
        const worker = new Worker(path, { type: "module", name: "drizzle-run" });

        worker.addEventListener("message", (event: MessageEvent<StoreResponse>) => {
          worker.terminate();

          if (event.data.ok) {
            resolve(event.data.result);
          } else {
            reject(new Error(`Store ${message.operation} failed: ${event.data.error.message}`));
          }
        });
        worker.addEventListener("error", () => {
          worker.terminate();
          reject(new Error(`The store worker ${path} did not start.`));
        });
        worker.postMessage(message);
      }),
    { path: workerPath, message: request },
  );

  return result as Awaited<ReturnType<StoreOperations[Name]>>;
}

/** One operation for `callStoreInOneWorker`: its name and arguments. */
export type StoreCall = {
  [Name in StoreOperationName]: [Name, ...Parameters<StoreOperations[Name]>];
}[StoreOperationName];

/**
 * Call several operations of the app's local store in order, through one store worker
 *
 * Reuse one worker for multi-operation setup instead of repeatedly starting and terminating workers.
 * The store releases its OPFS handles after each request.
 */
export async function callStoreInOneWorker(page: Page, calls: readonly StoreCall[]): Promise<void> {
  const workerPath = getStoreWorkerPath();

  if (!page.url().startsWith("http")) {
    await page.goto(workerPath);
  }

  const requests = calls.map(([operation, ...args], index) => ({ id: index + 1, operation, args }) as StoreRequest);

  await page.evaluate(
    ({ path, messages }) =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(path, { type: "module", name: "drizzle-run" });
        let next = 0;

        worker.addEventListener("message", (event: MessageEvent<StoreResponse>) => {
          if (!event.data.ok) {
            worker.terminate();
            reject(new Error(`Store ${messages[next]?.operation} failed: ${event.data.error.message}`));
            return;
          }

          next += 1;

          if (next === messages.length) {
            worker.terminate();
            resolve();
          } else {
            worker.postMessage(messages[next]);
          }
        });
        worker.addEventListener("error", () => {
          worker.terminate();
          reject(new Error(`The store worker ${path} did not start.`));
        });
        worker.postMessage(messages[0]);
      }),
    { path: workerPath, messages: requests },
  );
}
