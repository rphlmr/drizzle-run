import type { Runtime } from "@drizzle-run/core/contracts";

import { verifyQuickjsAsset } from "../assets/quickjs.ts";
import { createNodeRunner } from "../quickjs/node.ts";
import { createQuickjsRuntime } from "../quickjs/runtime.ts";

export type NodeRuntime = Runtime;

/** Create a local executor with one disposable process and fresh database per execution. */
export function createNodeRuntime(): NodeRuntime {
  return createQuickjsRuntime({
    preparation: "on_demand",
    async checkCapabilities() {
      return { status: "available", reasons: [] };
    },
    createRunner: (selection, signal) =>
      createNodeRunner({
        directory: new URL("../quickjs/", import.meta.url),
        selection,
        signal,
        verifyAsset: verifyQuickjsAsset,
      }),
  });
}

export type { CreateRunOptions, RunHandle } from "@drizzle-run/core/contracts";
