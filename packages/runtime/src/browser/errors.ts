import type { RuntimeCapabilities } from "@drizzle-run/core/contracts";

/** Why the browser runtime refused a manifest, a preparation or a run. */
export type BrowserRuntimeErrorCode =
  | "asset_configuration"
  | "capability_unsupported"
  | "runtime_disposed"
  | "unsupported_tuple";

/** Options of `BrowserRuntimeError`: what caused it, and the capability `status` when the browser cannot run. */
export interface BrowserRuntimeErrorOptions extends ErrorOptions {
  status?: RuntimeCapabilities["status"];
}

/** A runtime failure with a stable `code`, and the capability `status` when the browser cannot run. */
export class BrowserRuntimeError extends Error {
  readonly code: BrowserRuntimeErrorCode;
  readonly status?: RuntimeCapabilities["status"];

  constructor(code: BrowserRuntimeErrorCode, message: string, options: BrowserRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.status = options.status;
  }
}

/** Report a listener that threw; the runtime drops it and carries on. */
export function reportObserverFailure(cause: unknown): void {
  console.error("Drizzle Run observer threw", cause);
}
