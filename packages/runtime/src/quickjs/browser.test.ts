import { afterEach, describe, expect, it, vi } from "vitest";

import { makeExecutionManifest } from "../../test/quickjs/execution-fixture.ts";
import { createBrowserRunner, runBrowserComparison } from "./browser.ts";
import { defaultGuestSelection } from "./selection.ts";

vi.mock("./runner.ts", () => ({ createRunner: () => ({ run: vi.fn(), close: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

describe("createBrowserRunner storage preparation", () => {
  it("should abort every pending asset fetch when a direct comparison is cancelled", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      (_url: URL, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options.signal;

          if (!signal) {
            throw new Error("Asset request did not receive a cancellation signal");
          }

          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started.resolve();
        }),
    );
    const manifest = makeExecutionManifest();
    const execution = runBrowserComparison(
      { a: manifest, b: manifest },
      { signal: controller.signal, mode: "sequential" },
    );
    await started.promise;
    controller.abort();

    expect(await execution).toMatchObject({ a: { status: "cancelled" }, b: { status: "cancelled" } });
    expect(signals).toHaveLength(7);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each(["postgresql", "sqlite"] as const)(
    "should prepare %s without accessing browser file storage",
    async (dialect) => {
      const selection = { ...defaultGuestSelection, dialect };
      const getDirectory = vi.fn(async () => {
        throw new Error("Browser file storage is unavailable");
      });
      vi.stubGlobal("navigator", { storage: { getDirectory } });
      vi.stubGlobal("fetch", async (url: URL) => {
        if (url.pathname.endsWith("catalog.json")) {
          return Response.json({ selection, approved: {}, exports: {} });
        }

        return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {
          headers: { "Content-Type": "application/wasm" },
        });
      });

      const runner = await createBrowserRunner({ selection });
      await runner.close();

      expect(getDirectory).not.toHaveBeenCalled();
    },
  );
});
