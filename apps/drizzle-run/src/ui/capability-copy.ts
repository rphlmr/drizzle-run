import type { CapabilityReasonCode, RuntimeCapabilities } from "@drizzle-run/core/contracts";

/** The surface presenting a runtime capability message. */
export type CapabilitySurface = "app" | "phone" | "embed";

/** The recovery a capability message offers. */
export type CapabilityAction = "copy_link_and_export" | "open_new_tab" | "retry" | "none";

/** The words of a capability message and the action it offers. */
export interface CapabilityCopy {
  title: string;
  lines: string[];
  action: CapabilityAction;
}

/**
 * Codes are typed, but a newer runtime can report codes this app does not know
 * yet, so reasons are read as plain strings and unknown ones show their message.
 */
export interface CapabilityReport {
  status: RuntimeCapabilities["status"];
  reasons: readonly { code: string; message: string }[];
}

/** The codes that name a missing browser feature, not how the page is served or framed. */
type MissingFeatureCode = Exclude<
  CapabilityReasonCode,
  "embedding_isolation" | "missing_isolation_headers" | "unsupported_host"
>;

const featureNames: Record<string, string> = {
  no_shared_memory: "Shared memory between the page and its workers",
  no_asset_verification: "Secure verification of downloaded runtime files",
  no_dedicated_worker: "Background workers",
  no_webassembly: "WebAssembly",
  no_decompression: "Built-in decompression of downloaded files",
  no_wasm_threads: "WebAssembly threads",
  no_wasm_exception_handling: "WebAssembly exception handling",
  no_wasm_simd: "WebAssembly SIMD",
  insecure_context: "A secure (HTTPS) connection",
} satisfies Record<MissingFeatureCode, string>;

function formatReasonLine({ code, message }: { code: string; message: string }): string {
  const known = featureNames[code];

  if (known) {
    return known;
  }

  return message;
}

/** The same features as nouns inside a sentence, for the embed's one-line reason. */
const featureNouns: Record<string, string> = {
  no_shared_memory: "shared memory",
  no_asset_verification: "secure file verification",
  no_dedicated_worker: "background workers",
  no_webassembly: "WebAssembly",
  no_decompression: "built-in decompression",
  no_wasm_threads: "WebAssembly threads",
  no_wasm_exception_handling: "WebAssembly exception handling",
  no_wasm_simd: "WebAssembly SIMD",
  insecure_context: "a secure (HTTPS) connection",
} satisfies Record<MissingFeatureCode, string>;

function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function listMissingNouns(reasons: CapabilityReport["reasons"]): string {
  return joinWords(reasons.map((reason) => featureNouns[reason.code] ?? formatReasonLine(reason)));
}

function describeMissing(reasons: CapabilityReport["reasons"]): string {
  const missing = reasons.length ? `It's missing ${listMissingNouns(reasons)}, which Drizzle Run needs. ` : "";

  return `${missing}Try a current version of Chrome or Firefox, or Safari 26 or later.`;
}

/** A phone names what is missing in one sentence; in-app browsers are the usual reason shared memory is off. */
function describeMissingForPhone(reasons: CapabilityReport["reasons"]): string {
  const missing = reasons.length
    ? `It's missing ${listMissingNouns(reasons)}, which isolated runs need.`
    : "It's missing features that isolated runs need.";

  return reasons.some((reason) => reason.code === "no_shared_memory")
    ? `${missing} In-app browsers often turn it off.`
    : missing;
}

function listBrowserLines(reasons: CapabilityReport["reasons"], surface: CapabilitySurface): string[] {
  switch (surface) {
    case "app":
      return reasons.map(formatReasonLine);
    case "phone":
      return [describeMissingForPhone(reasons)];
    case "embed":
      return [describeMissing(reasons)];
  }
}

/** Words a capability report for the surface that shows it; unknown reason codes fall back to their own message. */
export function getCapabilityCopy(capabilities: CapabilityReport, surface: CapabilitySurface): CapabilityCopy {
  switch (capabilities.status) {
    case "browser_unsupported":
      return {
        title: surface === "embed" ? "This browser can't run the playground" : "Drizzle Run can't run in this browser",
        lines: listBrowserLines(capabilities.reasons, surface),
        action: surface === "embed" ? "none" : "copy_link_and_export",
      };
    case "embedding_context_unsupported":
      return {
        title: "Open this playground in a new tab",
        lines: [
          "This website doesn't give embedded playgrounds the isolation they need. Your browser is fine, so it will run in its own tab.",
        ],
        action: "open_new_tab",
      };
    case "configuration_error":
      return {
        title: "Something's wrong on our end",
        lines: capabilities.reasons.length
          ? capabilities.reasons.map((reason) => reason.message)
          : ["Drizzle Run couldn't set up its isolated runtime on this page."],
        action: "retry",
      };
    case "available":
      return { title: "", lines: [], action: "none" };
  }
}
