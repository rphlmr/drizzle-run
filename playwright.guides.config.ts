import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

/**
 * Content generators that run the built app on Chromium only: `pnpm replay:guides` replays every guide, and
 * `pnpm record:official` records the run of every official embed.
 */
export default defineConfig({
  ...base,
  testMatch: "**/*.generate.ts",
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium", launchOptions: { chromiumSandbox: true } } }],
});
