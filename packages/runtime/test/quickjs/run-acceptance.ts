import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { chromium, webkit, type Browser } from "@playwright/test";
import { build } from "esbuild";

import { createNodeRunner, runNodeComparison } from "../../src/quickjs/node.ts";
import type { AcceptanceReport } from "./execution-checks.ts";
import { checkExecution } from "./execution-checks.ts";
import { checkGuestMatrix } from "./matrix-checks.ts";

const assetDirectory = new URL("../../dist/quickjs/", import.meta.url);
const reportDirectory = new URL("../../../../test-results/quickjs/", import.meta.url);
const reports: Record<string, AcceptanceReport> = {};
const lifetime = new AbortController();
const deadline = setTimeout(() => {
  console.error("QuickJS acceptance exceeded its 5 minute deadline");
  process.exitCode = 1;
  lifetime.abort(new Error("Acceptance deadline exceeded"));
  void closeResources().catch(console.error);
}, 5 * 60_000);
let browser: Browser | undefined;
const server = createServer((request, response) => {
  void serve(new URL(request.url ?? "/", "http://localhost").pathname, response);
});

async function serve(path: string, response: ServerResponse) {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  if (path === "/") {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><title>QuickJS acceptance</title><script type="module" src="/browser-checks.js"></script>',
    );

    return;
  }

  if (!/^\/[a-zA-Z0-9_+./-]+$/.test(path) || path.split("/").includes("..")) {
    response.writeHead(404).end();

    return;
  }

  try {
    const bytes = await readFile(new URL(path.slice(1), assetDirectory));
    response.setHeader(
      "content-type",
      path.endsWith(".wasm")
        ? "application/wasm"
        : path.endsWith(".js")
          ? "text/javascript"
          : "application/octet-stream",
    );
    response.end(bytes);
  } catch (cause) {
    response.writeHead(404).end(String(cause));
  }
}

async function closeBrowser() {
  const activeBrowser = browser;
  browser = undefined;
  await activeBrowser?.close();
}

async function closeResources() {
  try {
    await closeBrowser();
  } finally {
    server.closeAllConnections();

    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

try {
  const matrix = await checkGuestMatrix((selection) =>
    createNodeRunner({ directory: assetDirectory, selection, signal: lifetime.signal }),
  );
  console.log(`Node: ${matrix.length} guest/dialect combinations passed fresh and restored, including Effect`);
  reports.node = await checkExecution({
    async createRunner(options) {
      const runner = await createNodeRunner({ ...options, directory: assetDirectory, signal: lifetime.signal });

      return {
        run(manifest, runOptions) {
          const signal = runOptions?.signal ? AbortSignal.any([runOptions.signal, lifetime.signal]) : lifetime.signal;

          return runner.run(manifest, { ...runOptions, signal });
        },
        close: runner.close,
      };
    },
    compare(manifests, options) {
      const signal = options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;

      return runNodeComparison(manifests, { ...options, directory: assetDirectory, signal });
    },
  });
  lifetime.signal.throwIfAborted();
  console.log(`Node: ${reports.node.assertions} assertions passed`);
  await build({
    entryPoints: [fileURLToPath(new URL("browser-checks.ts", import.meta.url))],
    outfile: fileURLToPath(new URL("browser-checks.js", assetDirectory)),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2025",
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("QuickJS acceptance server did not bind a TCP port");
  }

  for (const [name, browserType] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    lifetime.signal.throwIfAborted();
    browser = await browserType.launch({ headless: true });
    const page = await browser.newPage();
    page.on("pageerror", (cause) => console.error(`${name}:`, cause));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction("typeof window.runQuickjsAcceptance === 'function'");
    await page.evaluate("window.runQuickjsMatrix()");
    console.log(`${name}: guest/dialect matrix passed fresh and restored, including Effect`);
    reports[name] = await page.evaluate<AcceptanceReport>("window.runQuickjsAcceptance()");
    console.log(`${name}: ${reports[name].assertions} assertions passed`);
    await closeBrowser();
  }

  await mkdir(reportDirectory, { recursive: true });
  await writeFile(new URL("execution-results.json", reportDirectory), JSON.stringify(reports, null, 2));
} finally {
  clearTimeout(deadline);
  await closeResources();
  await rm(new URL("browser-checks.js", assetDirectory), { force: true });
}
