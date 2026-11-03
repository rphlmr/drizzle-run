import * as z from "zod/mini";

import { QueryPlansSettingsSchema } from "../query-plans/sizes.ts";
import type { ExecutionMode } from "./contract.ts";
import { ExecutionPhaseSchema, ExecutionResultSchema, QuickjsManifestSchema } from "./contract.ts";
import { GuestSelectionSchema } from "./selection.ts";

/** Build-generated import inventory from the same pinned installation as the guest bundle. */
export const CatalogSchema = z.object({
  selection: GuestSelectionSchema,
  approved: z.record(z.string(), z.array(z.string())),
  exports: z.record(z.string(), z.array(z.string())),
});
export type Catalog = z.output<typeof CatalogSchema>;

export const SnapshotSchema = z.object({
  memory: z.instanceof(Uint8Array),
  stackPointer: z.number(),
  runtimePtr: z.number(),
  contextPtr: z.number(),
  extensions: z.array(
    z.object({ name: z.string(), memoryBase: z.number(), tableBase: z.number(), initFn: z.string() }),
  ),
});

export const ExecutionAssetsSchema = z.object({
  bundle: z.string(),
  wasmBytes: z.instanceof(Uint8Array),
  extensionBytes: z.array(z.object({ name: z.string(), bytes: z.instanceof(Uint8Array) })),
  compilerBytes: z.optional(z.instanceof(Uint8Array)),
  compilerModule: z.optional(z.instanceof(WebAssembly.Module)),
  databaseTemplate: z.optional(z.instanceof(Blob)),
  catalog: CatalogSchema,
});
export type ExecutionAssets = z.output<typeof ExecutionAssetsSchema>;

export const WorkerRequestSchema = z.object({
  manifest: QuickjsManifestSchema,
  assets: ExecutionAssetsSchema,
  template: z.optional(SnapshotSchema),
  mode: z.enum(["snapshot", "fresh"]),
  debug: z.boolean(),
  queryPlans: z.optional(QueryPlansSettingsSchema),
});
export type WorkerRequest = z.output<typeof WorkerRequestSchema>;

export const WorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("template"), template: SnapshotSchema }),
  z.object({ type: z.literal("phase"), phase: ExecutionPhaseSchema }),
  z.object({ type: z.literal("result"), result: ExecutionResultSchema }),
  z.object({ type: z.literal("message"), message: z.unknown() }),
]);
export type WorkerMessage = z.output<typeof WorkerMessageSchema>;

/** Internal host port. Termination fulfills only after the execution host can no longer run. */
export interface ExecutionWorker {
  listen: (receive: (message: unknown) => void, fail: (cause: Error) => void) => void;
  send: (request: WorkerRequest) => void;
  terminate: () => void | Promise<void>;
}

export interface RunnerDependencies {
  assets: ExecutionAssets;
  createWorker: () => ExecutionWorker;
  mode?: ExecutionMode;
}

export type DependencyTemplate = z.output<typeof SnapshotSchema>;
