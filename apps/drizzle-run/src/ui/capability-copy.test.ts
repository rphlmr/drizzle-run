import { describe, expect, it } from "vitest";

import { getCapabilityCopy } from "./capability-copy";

const noSharedMemory = { code: "no_shared_memory", message: "SharedArrayBuffer is unavailable." };

describe("getCapabilityCopy", () => {
  it("should explain an unsupported browser in the app with recovery actions", () => {
    expect(getCapabilityCopy({ status: "browser_unsupported", reasons: [noSharedMemory] }, "app")).toEqual({
      title: "Drizzle Run can't run in this browser",
      lines: ["Shared memory between the page and its workers"],
      action: "copy_link_and_export",
    });
  });

  it("should name the missing features in one sentence in the embed", () => {
    const noWebAssembly = { code: "no_webassembly", message: "WebAssembly is unavailable." };

    expect(getCapabilityCopy({ status: "browser_unsupported", reasons: [noSharedMemory] }, "embed").lines).toEqual([
      "It's missing shared memory, which Drizzle Run needs. Try a current version of Chrome or Firefox, or Safari 26 or later.",
    ]);
    expect(
      getCapabilityCopy({ status: "browser_unsupported", reasons: [noWebAssembly, noSharedMemory] }, "embed").lines,
    ).toEqual([
      "It's missing WebAssembly and shared memory, which Drizzle Run needs. Try a current version of Chrome or Firefox, or Safari 26 or later.",
    ]);
  });

  it("should name each missing WebAssembly feature instead of its runtime message", () => {
    const reasons = [
      { code: "no_wasm_threads", message: "This browser does not support WebAssembly threads." },
      { code: "no_wasm_exception_handling", message: "This browser does not support WebAssembly exceptions." },
      { code: "no_wasm_simd", message: "This browser does not support WebAssembly SIMD." },
    ];

    expect(getCapabilityCopy({ status: "browser_unsupported", reasons }, "embed").lines).toEqual([
      "It's missing WebAssembly threads, WebAssembly exception handling and WebAssembly SIMD, which Drizzle Run needs. Try a current version of Chrome or Firefox, or Safari 26 or later.",
    ]);
  });

  it("should name the missing features in one sentence on a phone, with the in-app browser hint for shared memory", () => {
    const noWebAssembly = { code: "no_webassembly", message: "WebAssembly is unavailable." };

    expect(getCapabilityCopy({ status: "browser_unsupported", reasons: [noSharedMemory] }, "phone")).toEqual({
      title: "Drizzle Run can't run in this browser",
      lines: ["It's missing shared memory, which isolated runs need. In-app browsers often turn it off."],
      action: "copy_link_and_export",
    });
    expect(getCapabilityCopy({ status: "browser_unsupported", reasons: [noWebAssembly] }, "phone").lines).toEqual([
      "It's missing WebAssembly, which isolated runs need.",
    ]);
  });

  it("should offer a new tab only when the embedding page is the problem", () => {
    const embedding = getCapabilityCopy(
      { status: "embedding_context_unsupported", reasons: [{ code: "embedding_isolation", message: "No isolation." }] },
      "embed",
    );

    expect(embedding.title).toBe("Open this playground in a new tab");
    expect(embedding.action).toBe("open_new_tab");

    for (const surface of ["app", "phone", "embed"] as const) {
      for (const status of ["browser_unsupported", "configuration_error"] as const) {
        expect(getCapabilityCopy({ status, reasons: [noSharedMemory] }, surface).action).not.toBe("open_new_tab");
      }
    }
  });

  it("should ask to retry a configuration error", () => {
    const copy = getCapabilityCopy({ status: "configuration_error", reasons: [] }, "app");

    expect(copy.title).toBe("Something's wrong on our end");
    expect(copy.action).toBe("retry");
  });

  it("should fall back to each reason's message, in order, for unknown codes", () => {
    const copy = getCapabilityCopy(
      {
        status: "browser_unsupported",
        reasons: [
          { code: "no-future-api", message: "The future API is missing." },
          { code: "no-other-thing", message: "Another thing is missing." },
        ],
      },
      "app",
    );

    expect(copy.lines).toEqual(["The future API is missing.", "Another thing is missing."]);
  });
});
