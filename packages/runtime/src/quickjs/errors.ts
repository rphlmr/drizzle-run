import * as z from "zod/mini";

import type { ExecutionError } from "./contract.ts";
import { DiagnosticSchema } from "./contract.ts";

const ErrorDetailsSchema = z.object({
  message: z.optional(z.string()),
  code: z.optional(z.string()),
  diagnostics: z.optional(z.array(DiagnosticSchema)),
});

/** A QuickJS interrupt caused by the execution deadline, including during VM initialization. */
export class QuickjsTimeoutError extends Error {
  readonly code = "run_timeout";

  constructor(cause: unknown) {
    super("Run exceeded the QuickJS execution time limit", { cause });
    this.name = "QuickjsTimeoutError";
  }
}

/** Normalize cross-realm failures without discarding database codes or compiler locations. */
export function toExecutionError({ cause, phase }: { cause: unknown; phase: ExecutionError["phase"] }): ExecutionError {
  const details = ErrorDetailsSchema.safeParse(cause);

  return details.success
    ? { ...details.data, phase, message: details.data.message ?? String(cause) }
    : { phase, message: String(cause) };
}

/** Observer failures cannot change ownership or prevent terminal delivery. */
export function notifyObserver<Args extends unknown[]>(observer: ((...args: Args) => void) | undefined, ...args: Args) {
  try {
    observer?.(...args);
  } catch (cause) {
    console.warn("QuickJS observer failed", cause);
  }
}
