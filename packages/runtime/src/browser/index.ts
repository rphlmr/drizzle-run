import type { Runtime } from "@drizzle-run/core/contracts";

import { quickjsAssetDirectory } from "../assets/configuration.generated.ts";
import { verifyQuickjsAsset } from "../assets/quickjs.ts";
import { createQuickjsRuntime } from "../quickjs/runtime.ts";
import { checkRuntimeCapabilities } from "./capabilities.ts";
import type { RuntimePreparation } from "./preparation.ts";

export type BrowserRuntime = Runtime;

/** Asset location and preparation policy for the browser host. */
export interface BrowserRuntimeOptions {
  preparation?: RuntimePreparation;
  /** Public directory populated by `copyRuntimeAssets`; defaults to `/runtime-assets/`. */
  assetBaseUrl?: string;
}

/** Create a browser runtime over the packaged runtime assets. */
export function createBrowserRuntime(options: BrowserRuntimeOptions = {}): BrowserRuntime {
  return createQuickjsRuntime({
    preparation: options.preparation,
    checkCapabilities: checkRuntimeCapabilities,
    async createRunner(selection, signal) {
      const { createBrowserRunner } = await import("../quickjs/browser.ts");
      const assetBaseUrl = options.assetBaseUrl ?? "/runtime-assets/";
      const base = new URL(assetBaseUrl.endsWith("/") ? assetBaseUrl : `${assetBaseUrl}/`, globalThis.location?.href);
      const baseUrl = new URL(quickjsAssetDirectory, base);

      return createBrowserRunner({ baseUrl, selection, signal, verifyAsset: verifyQuickjsAsset });
    },
  });
}

export { BrowserRuntimeError } from "./errors.ts";
export { PLANNING_ABANDONED_CLEANUP_REASON } from "@drizzle-run/core/contracts";
export type { BrowserRuntimeErrorCode, BrowserRuntimeErrorOptions } from "./errors.ts";
export type { PrepareOptions, RuntimePreparation } from "./preparation.ts";
export type { RunHandle as BrowserRun, CreateRunOptions } from "@drizzle-run/core/contracts";
