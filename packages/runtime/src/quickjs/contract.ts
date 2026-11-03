import type { QueryPlansSettings } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { RunManifestSchema } from "@drizzle-run/core/manifest";
import * as z from "zod/mini";

import type { RuntimeWorkerMessage } from "../browser/protocol.ts";
import { selectGuest } from "./selection.ts";

/** Validate the registered release and project limits before allocating an execution host. */
export const QuickjsManifestSchema: z.ZodMiniType<RunManifest> = RunManifestSchema.check(
  z.superRefine((manifest, context) => {
    try {
      selectGuest(manifest);
    } catch (cause) {
      context.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }),
);

export type QuickjsManifest = z.output<typeof QuickjsManifestSchema>;

export const executionPhases = [
  "compile",
  "setup",
  "schema",
  "sql",
  "database",
  "seed",
  "run",
  "inspect",
  "plan",
  "cleanup",
] as const;
export const ExecutionPhaseSchema = z.enum(executionPhases);
export type ExecutionPhase = z.output<typeof ExecutionPhaseSchema>;

/** Tagged values preserve types across the guest's JSON boundary. */
export type SerializedValue =
  | { type: "undefined" }
  | { type: "primitive"; value: string | number | boolean | null }
  | { type: "bigint" | "date"; value: string }
  | { type: "bytes"; value: number[] }
  | { type: "circular"; path: string }
  | { type: "unsupported"; valueType: string; description?: string }
  | { type: "array"; value: SerializedValue[] }
  | { type: "object"; value: [string, SerializedValue][] };

export const SerializedValueSchema: z.ZodMiniType<SerializedValue> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("undefined") }),
    z.strictObject({ type: z.literal("primitive"), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.strictObject({ type: z.literal("bigint"), value: z.string().check(z.regex(/^-?\d+$/)) }),
    z.strictObject({ type: z.literal("date"), value: z.iso.datetime() }),
    z.strictObject({ type: z.literal("bytes"), value: z.array(z.int().check(z.minimum(0), z.maximum(255))) }),
    z.strictObject({ type: z.literal("circular"), path: z.string() }),
    z.strictObject({ type: z.literal("unsupported"), valueType: z.string(), description: z.optional(z.string()) }),
    z.strictObject({ type: z.literal("array"), value: z.array(SerializedValueSchema) }),
    z.strictObject({ type: z.literal("object"), value: z.array(z.tuple([z.string(), SerializedValueSchema])) }),
  ]),
);

export const DiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  source: z.optional(z.string()),
  line: z.optional(z.number()),
  column: z.optional(z.number()),
});
export type Diagnostic = z.output<typeof DiagnosticSchema>;

export const ExecutionErrorSchema = z.object({
  phase: z.enum([...executionPhases, "validation", "admission", "supervision"]),
  message: z.string(),
  code: z.optional(z.string()),
  diagnostics: z.optional(z.array(DiagnosticSchema)),
});
export type ExecutionError = z.output<typeof ExecutionErrorSchema>;

export const DisplaysSchema = z.array(z.object({ label: z.string(), values: SerializedValueSchema }));

const ExecutionEvidenceSchema = z.object({
  cleanup: z.optional(
    z.object({
      guest: z.object({ mode: z.enum(["graceful", "forced"]), reason: z.optional(z.string()) }),
      database: z.object({ mode: z.enum(["graceful", "forced"]), reason: z.optional(z.string()) }),
    }),
  ),
  sql: z.optional(z.array(z.string())),
  value: z.optional(SerializedValueSchema),
  displays: z.optional(DisplaysSchema),
  logs: z.optional(z.array(z.array(z.json()))),
  warnings: z.optional(z.array(DiagnosticSchema)),
  timings: z.optional(z.record(z.string(), z.number())),
  memory: z.optional(z.record(z.string(), z.union([z.number(), z.boolean()]))),
  cleanupDiagnostics: z.optional(z.array(z.string())),
  workerTerminated: z.optional(z.literal(true)),
  totalMs: z.optional(z.number()),
  retainedTemplateBytes: z.optional(z.number()),
});

/** Execution outcomes carry either a complete value or an attributed failure. */
export const ExecutionResultSchema = z.discriminatedUnion("status", [
  z.extend(ExecutionEvidenceSchema, {
    status: z.literal("success"),
    error: z.optional(z.never()),
    sql: z.array(z.string()),
    value: SerializedValueSchema,
    displays: DisplaysSchema,
  }),
  z.extend(ExecutionEvidenceSchema, { status: z.literal("error"), error: ExecutionErrorSchema }),
  z.extend(ExecutionEvidenceSchema, { status: z.literal("cancelled"), error: ExecutionErrorSchema }),
]);
export type ExecutionResult = z.output<typeof ExecutionResultSchema>;

/** Select dependency capture and restore, or a fresh dependency initialization per run. */
export type ExecutionMode = "snapshot" | "fresh";

export interface RunOptions {
  queryPlans?: QueryPlansSettings;
  onMessage?: (message: RuntimeWorkerMessage) => void;
  signal?: AbortSignal;
  debug?: boolean;
  /**
   * Execution timeout in milliseconds; defaults to 30,000. Must be finite, greater than zero, and at most 120,000.
   * Increasing it does not extend the VM's separate 20-second interrupt budget.
   */
  timeoutMs?: number;
  onPhase?: (phase: ExecutionPhase) => void;
}

/** One owner retains immutable artifacts, never a live execution, between requests. */
export interface QuickjsRunner {
  run: (manifest: unknown, options?: RunOptions) => Promise<ExecutionResult>;
  /** Close after the active run settles; to cancel first, abort its signal and await settlement. */
  close: () => void | Promise<void>;
}

export type ComparisonSide = "a" | "b";
export type ComparisonResults = Record<ComparisonSide, ExecutionResult>;
export interface ComparisonOptions extends Omit<RunOptions, "onPhase"> {
  mode?: "parallel" | "sequential";
  onSide?: (side: ComparisonSide, result: ExecutionResult) => void;
  onPhase?: (side: ComparisonSide, phase: ExecutionPhase) => void;
}

/** Validate and decode a guest result. Objects preserve special keys as ordinary own properties. */
export function decodeResult(value: unknown): unknown {
  return decodeValue(SerializedValueSchema.parse(value));
}

function decodeValue(value: SerializedValue): unknown {
  switch (value.type) {
    case "undefined":
      return undefined;
    case "primitive":
      return value.value;
    case "bigint":
      return BigInt(value.value);
    case "date":
      return new Date(value.value);
    case "bytes":
      return Uint8Array.from(value.value);
    case "circular":
    case "unsupported":
      return value;
    case "array":
      return value.value.map(decodeValue);
    case "object":
      return Object.fromEntries(value.value.map(([key, item]) => [key, decodeValue(item)]));
  }
}
