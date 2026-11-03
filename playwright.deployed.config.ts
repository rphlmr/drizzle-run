import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

const deployedOrigin = process.env.DRIZZLE_RUN_DEPLOYED_URL;
const searchIndexingSetting = process.env.DRIZZLE_RUN_DEPLOYED_SEARCH_INDEXING ?? "on";

if (deployedOrigin === undefined || !deployedOrigin.startsWith("https://")) {
  throw new Error(
    `Set DRIZZLE_RUN_DEPLOYED_URL to the deployed https origin, such as https://pr-1.drizzle-run-preview.workers.dev, but got ${deployedOrigin}`,
  );
}

if (searchIndexingSetting !== "on" && searchIndexingSetting !== "off") {
  throw new Error(
    `Set DRIZZLE_RUN_DEPLOYED_SEARCH_INDEXING to the deploy's SEARCH_INDEXING, on or off (previews and next), but got ${searchIndexingSetting}`,
  );
}

/** The deployed Worker's SEARCH_INDEXING: off for previews and next (scripts/deploy-environment.ts), on for production. */
export const deployedSearchIndexing: "on" | "off" = searchIndexingSetting;

/**
 * Checks a deployed Worker in a real browser: Cloudflare, R2 and the response headers, which the local e2e server
 * cannot show. `pnpm test:deployed` runs it after a release, from the checkout that release built: the store worker the
 * fixtures start is found in that build (e2e/store.ts).
 */
export default defineConfig({
  ...base,
  testMatch: "**/*.deployed.ts",
  webServer: undefined,
  workers: 1,
  reporter: [["list"]],
  use: { ...base.use, baseURL: deployedOrigin },
  projects: base.projects?.filter((project) => project.name === "chromium"),
});
