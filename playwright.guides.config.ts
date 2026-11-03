import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

/**
 * Content generators that run the built app on Chromium only: `pnpm replay:guides` replays every guide, and
 * `pnpm record:official` records the run of every official embed.
 */
export default defineConfig({
  ...base,
  testMatch: "**/*.generate.ts",
  // Replays boot Wasm guests; CI shards provide parallelism without sharing a runner's CPU between guides.
  workers: 1,
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium", launchOptions: { chromiumSandbox: true } } }],
});
