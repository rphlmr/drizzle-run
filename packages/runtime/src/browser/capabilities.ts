import type { CapabilityReason, CapabilityReasonCode, RuntimeCapabilities } from "@drizzle-run/core/contracts";
import { formatCapabilityReasons } from "@drizzle-run/core/contracts";

import { BrowserRuntimeError } from "./errors.ts";

const wasmModuleHeader = [0, 97, 115, 109, 1, 0, 0, 0];
const wasmFeatureProbes: { code: CapabilityReasonCode; name: string; bytes: number[] }[] = [
  { code: "no_wasm_threads", name: "WebAssembly threads", bytes: [...wasmModuleHeader, 5, 4, 1, 3, 1, 1] },
  {
    code: "no_wasm_exception_handling",
    name: "WebAssembly exception handling",
    bytes: [...wasmModuleHeader, 1, 4, 1, 96, 0, 0, 13, 3, 1, 0, 0],
  },
  {
    code: "no_wasm_simd",
    name: "WebAssembly SIMD",
    bytes: [
      ...wasmModuleHeader,
      1,
      5,
      1,
      96,
      0,
      1,
      123,
      3,
      2,
      1,
      0,
      10,
      22,
      1,
      20,
      0,
      253,
      12,
      ...Array<number>(16).fill(0),
      11,
    ],
  },
];

/**
 * Check whether this browser and page can run Drizzle Run
 *
 * Reports every missing browser feature at once; otherwise reports the first page-level problem (insecure
 * context, missing isolation, no shared memory). Embedded pages get `embedding_context_unsupported` for
 * problems their host page must fix.
 */
export async function checkRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  const reasons: CapabilityReason[] = [];

  if (typeof Worker !== "function") {
    reasons.push({ code: "no_dedicated_worker", message: "This browser does not support dedicated workers." });
  }

  if (typeof WebAssembly !== "object") {
    reasons.push({ code: "no_webassembly", message: "This browser does not support WebAssembly." });
  } else {
    for (const { code, name, bytes } of wasmFeatureProbes) {
      if (!WebAssembly.validate(Uint8Array.from(bytes))) {
        reasons.push({ code, message: `This browser does not support ${name}.` });
      }
    }
  }

  if (typeof DecompressionStream !== "function") {
    reasons.push({
      code: "no_decompression",
      message: "This browser lacks the asset decompression features Drizzle Run requires.",
    });
  }

  if (reasons.length > 0) {
    return { status: "browser_unsupported", reasons };
  }

  const isEmbedded = typeof window !== "undefined" && window.parent !== window;

  if (!globalThis.isSecureContext) {
    return {
      status: isEmbedded ? "embedding_context_unsupported" : "configuration_error",
      reasons: [
        {
          code: "insecure_context",
          message: "Drizzle Run requires a secure page context. Open it over HTTPS to continue.",
        },
      ],
    };
  }

  if (globalThis.crypto?.subtle === undefined) {
    return {
      status: "browser_unsupported",
      reasons: [
        {
          code: "no_asset_verification",
          message: "This browser lacks secure asset verification required by Drizzle Run.",
        },
      ],
    };
  }

  if (!globalThis.crossOriginIsolated) {
    return {
      status: isEmbedded ? "embedding_context_unsupported" : "configuration_error",
      reasons: [
        isEmbedded
          ? {
              code: "embedding_isolation",
              message: "This embedding context cannot provide the browser isolation required by Drizzle Run.",
            }
          : {
              code: "missing_isolation_headers",
              message: "This page is missing the isolation headers required by Drizzle Run.",
            },
      ],
    };
  }

  if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") {
    return {
      status: "browser_unsupported",
      reasons: [
        {
          code: "no_shared_memory",
          message: "This browser cannot provide shared memory required by Drizzle Run.",
        },
      ],
    };
  }

  return { status: "available", reasons: [] };
}

/** Throw a `capability_unsupported` error, with the capability status, unless the browser can run guests. */
export function assertCapabilitiesAvailable(capabilities: RuntimeCapabilities): void {
  if (capabilities.status !== "available") {
    throw new BrowserRuntimeError(
      "capability_unsupported",
      formatCapabilityReasons(capabilities) || "Drizzle Run cannot run in this browser context.",
      { status: capabilities.status },
    );
  }
}
