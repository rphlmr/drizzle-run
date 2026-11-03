import { formatCapabilityReasons } from "@drizzle-run/core/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkRuntimeCapabilities } from "./capabilities.ts";

afterEach(() => vi.unstubAllGlobals());

const supportedFeatures = () => {
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("WebAssembly", { validate: () => true });
  vi.stubGlobal("DecompressionStream", vi.fn());
  vi.stubGlobal("crypto", { subtle: {} });
  vi.stubGlobal("SharedArrayBuffer", vi.fn());
  vi.stubGlobal("Atomics", {});
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("isSecureContext", true);
};

describe("checkRuntimeCapabilities", () => {
  it("should report insecure embedding ancestors as a context limitation before hidden secure APIs", async () => {
    supportedFeatures();
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("window", { parent: {} });

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities).toMatchObject({ status: "embedding_context_unsupported" });
    expect(capabilities.reasons.map((reason) => reason.code)).toEqual(["insecure_context"]);
  });

  it("should report a configuration failure on an insecure standalone page", async () => {
    supportedFeatures();
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("window", undefined);

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities).toMatchObject({ status: "configuration_error" });
    expect(capabilities.reasons.map((reason) => reason.code)).toEqual(["insecure_context"]);
  });

  it("should report missing verification on a secure page as a browser incompatibility", async () => {
    supportedFeatures();
    vi.stubGlobal("crypto", {});

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities).toMatchObject({ status: "browser_unsupported" });
    expect(capabilities.reasons.map((reason) => reason.code)).toEqual(["no_asset_verification"]);
  });

  it("should report missing intrinsic Wasm features as an incompatibility in an insecure embed", async () => {
    supportedFeatures();
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("WebAssembly", { validate: () => false });
    vi.stubGlobal("window", { parent: {} });

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities).toMatchObject({ status: "browser_unsupported" });
    expect(capabilities.reasons.map((reason) => reason.code)).toEqual([
      "no_wasm_threads",
      "no_wasm_exception_handling",
      "no_wasm_simd",
    ]);
  });

  it("should report missing shared memory with its code", async () => {
    supportedFeatures();
    vi.stubGlobal("SharedArrayBuffer", undefined);

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities).toMatchObject({ status: "browser_unsupported" });
    expect(capabilities.reasons).toEqual([
      { code: "no_shared_memory", message: "This browser cannot provide shared memory required by Drizzle Run." },
    ]);
  });

  it("should report missing isolation headers on a standalone page", async () => {
    supportedFeatures();
    vi.stubGlobal("crossOriginIsolated", false);
    vi.stubGlobal("window", undefined);

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities).toMatchObject({ status: "configuration_error" });
    expect(capabilities.reasons.map((reason) => reason.code)).toEqual(["missing_isolation_headers"]);
  });

  it("should report embedding isolation inside a frame", async () => {
    supportedFeatures();
    vi.stubGlobal("crossOriginIsolated", false);
    vi.stubGlobal("window", { parent: {} });

    const capabilities = await checkRuntimeCapabilities();

    expect(capabilities.reasons.map((reason) => reason.code)).toEqual(["embedding_isolation"]);
  });
});

describe("formatCapabilityReasons", () => {
  it("should join the reason messages in order", () => {
    expect(
      formatCapabilityReasons({
        status: "browser_unsupported",
        reasons: [
          { code: "no_dedicated_worker", message: "First." },
          { code: "no_decompression", message: "Second." },
        ],
      }),
    ).toBe("First. Second.");
  });
});
