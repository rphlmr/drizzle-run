import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

/**
 * Memory stress tests, run on demand with `pnpm test:stress`, such as when a browser reports running out of memory
 *
 * WebKit only, since it caps WebAssembly memory per process. One worker, so no other test competes for that memory.
 */
export default defineConfig({
  ...base,
  testMatch: "**/*.stress.ts",
  workers: 1,
  reporter: [["list"]],
  projects: [{ name: "webkit", use: { browserName: "webkit", reducedMotion: "reduce" } }],
});
