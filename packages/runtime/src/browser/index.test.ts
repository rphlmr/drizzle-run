import { afterEach, describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";

describe("browser runtime entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("should report missing WebAssembly before loading execution resources", async () => {
    vi.stubGlobal("WebAssembly", undefined);
    vi.stubGlobal("Worker", vi.fn());
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { createBrowserRuntime } = await import("./index.ts");
    const runtime = createBrowserRuntime();

    try {
      await expect(runtime.checkCapabilities()).resolves.toMatchObject({
        status: "browser_unsupported",
        reasons: [{ code: "no_webassembly", message: "This browser does not support WebAssembly." }],
      });
      await expect(runtime.prepare(makeExecutionManifest())).rejects.toMatchObject({
        code: "capability_unsupported",
        message: "This browser does not support WebAssembly.",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(Worker).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
