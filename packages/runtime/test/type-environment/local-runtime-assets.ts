import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { vi } from "vitest";

// What `pnpm runtime-assets` stages for R2, which the local Worker serves under /runtime-assets/.
const runtimeAssetDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.cache/runtime-assets/r2");
const routePrefix = "/runtime-assets/";

/**
 * Serve the runtime assets from the local build, as the Worker serves them from R2
 *
 * Stubs `fetch` so a `/runtime-assets/<digest>/<name>` request reads `.cache/runtime-assets/r2/<digest>/<name>`, and
 * answers 404 when that file is missing. Other requests go to the real `fetch`. Undo it with `vi.unstubAllGlobals()`.
 */
export function serveLocalRuntimeAssets(): void {
  const realFetch = globalThis.fetch;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, "https://drizzle.run/");

    if (!pathname.startsWith(routePrefix)) {
      return realFetch(input, init);
    }

    try {
      return new Response(await readFile(join(runtimeAssetDir, ...pathname.slice(routePrefix.length).split("/"))));
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
