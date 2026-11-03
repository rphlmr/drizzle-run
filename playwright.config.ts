import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

import { resolveDrizzleRunPorts, toLocalOrigin } from "./scripts/drizzle-run-ports";

// Firefox reads ~/Library/Application Support/Firefox before it switches to Playwright's temp profile.
// macOS 27 locks that folder to an installed Firefox, so the test browser gets its own home there.
const firefoxHome = resolve(".cache/playwright-firefox-home");
const firefoxEnv = process.platform === "darwin" ? { ...process.env, CFFIXED_USER_HOME: firefoxHome } : undefined;

if (firefoxEnv) {
  mkdirSync(firefoxHome, { recursive: true });
}

// Pinned in the environment, so the web server and every test worker of this run use the same pair.
const ports = resolveDrizzleRunPorts();
const appOrigin = toLocalOrigin(ports.app);

process.env.DRIZZLE_RUN_PORT = String(ports.app);
process.env.DRIZZLE_RUN_FIXTURE_PORT = String(ports.fixture);

export default defineConfig({
  testDir: "./apps/drizzle-run/e2e",
  testMatch: "**/*.e2e.ts",
  // A file's tests spread over all workers, so a long file (shell, connect) no longer finishes alone; the side-by-side
  // files opt out. Each test starts in a fresh browser context. The e2e Wrangler environment lifts the publish limit
  // that once forced a single worker.
  fullyParallel: true,
  // Each test boots wasm guests, so workers compete for CPU: in Chromium, 8 workers made each test 64% slower for
  // 20% more throughput. 6 matches a 6 performance core Mac. GitHub's runners have 4 vCPUs for a public repository
  // but 2 for a private one, where 4 workers ran out of memory and the runner shut down.
  workers: process.env.CI ? Math.min(4, availableParallelism()) : 6,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 15_000,
    baseURL: appOrigin,
    bypassCSP: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Tests run with reduced motion, which theme.css turns into no transitions at all: a closing dialog
  // or menu leaves the page at once instead of lingering through its exit, so locators never see two.
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", reducedMotion: "reduce", launchOptions: { chromiumSandbox: true } },
    },
    {
      name: "firefox",
      use: { browserName: "firefox", reducedMotion: "reduce", launchOptions: { env: firefoxEnv } },
    },
    { name: "webkit", use: { browserName: "webkit", reducedMotion: "reduce" } },
  ],
  // Every run builds first and starts on emptied local storage (serve-drizzle-run.ts --e2e), so a restarted run never
  // tests an earlier build or sees the users, shares and assets an earlier run left. Each test's browser context
  // starts with an empty HTTP cache and storage.
  webServer: {
    command: "pnpm run build && node --experimental-strip-types apps/drizzle-run/scripts/serve-drizzle-run.ts --e2e",
    url: appOrigin,
    reuseExistingServer: false,
    // The build takes about 35 s and the server about 15 s on a warm machine.
    timeout: 240_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
