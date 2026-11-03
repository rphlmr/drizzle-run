import type { Page } from "@playwright/test";

/** A runtime worker identified by its script URL, and whether it was terminated. */
export interface LifecycleWorkerRecord {
  name: string;
  scriptUrl: string;
  terminated: boolean;
}

/** The page's window with what `installLifecycleInstrumentation` records */
export interface LifecycleWindow extends Window {
  __drizzleRunLifecycleWorkers?: LifecycleWorkerRecord[];
  __drizzleRunLifecycleDownload?: string;
}

/**
 * Record the page's runtime workers and report downloads
 *
 * Runs before each page load, so it covers every navigation, and starts over on each full load.
 */
export async function installLifecycleInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const instrumentedWindow = window as LifecycleWindow;
    const records: LifecycleWorkerRecord[] = [];
    const recordsByWorker = new WeakMap<Worker, LifecycleWorkerRecord>();
    const NativeWorker = window.Worker;
    const createObjectURL = URL.createObjectURL.bind(URL);

    instrumentedWindow.__drizzleRunLifecycleWorkers = records;
    URL.createObjectURL = (object: Blob) => {
      if (object.type === "application/json") {
        void object.text().then((text) => {
          instrumentedWindow.__drizzleRunLifecycleDownload = text;
        });
      }

      return createObjectURL(object);
    };

    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class extends NativeWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options);

          const scriptUrl = new URL(scriptURL, window.location.href);

          if (scriptUrl.pathname.endsWith("/execution-worker.js")) {
            const record = { name: "drizzle-run-execution", scriptUrl: scriptUrl.href, terminated: false };
            records.push(record);
            recordsByWorker.set(this, record);
          }
        }

        terminate(): void {
          const record = recordsByWorker.get(this);

          if (record !== undefined) {
            record.terminated = true;
          }

          super.terminate();
        }
      },
    });
  });
}

/** Count the app's workers of this name that were not terminated. */
export function countLiveWorkers(page: Page, name: "drizzle-run-execution" | "drizzle-run-database"): Promise<number> {
  return page.evaluate(
    (workerName) =>
      ((window as LifecycleWindow).__drizzleRunLifecycleWorkers ?? []).filter(
        (worker) => worker.name === workerName && !worker.terminated,
      ).length,
    name,
  );
}
