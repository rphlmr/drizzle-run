/** Eager retains prepared assets between runs; on-demand releases them after each run to limit memory use. */
export type RuntimePreparation = "eager" | "on_demand";

export type { PrepareOptions } from "@drizzle-run/core/contracts";
