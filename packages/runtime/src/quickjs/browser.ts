import { runComparison } from "./comparison.ts";
import type { ComparisonOptions, ComparisonSide, ExecutionMode, QuickjsRunner } from "./contract.ts";
import { QuickjsManifestSchema } from "./contract.ts";
import { createRunner } from "./runner.ts";
import { defaultGuestSelection, guestAssetPrefix, selectGuest, type GuestSelection } from "./selection.ts";
import { CatalogSchema } from "./worker-contract.ts";

export interface BrowserRunnerOptions {
  baseUrl?: URL;
  mode?: ExecutionMode;
  signal?: AbortSignal;
  selection?: GuestSelection;
  verifyAsset?: (name: string, bytes: Uint8Array) => Promise<Uint8Array>;
}

/** Load the generated QuickJS asset directory and own a fresh module worker per execution. */
export async function createBrowserRunner({
  baseUrl = new URL("./", import.meta.url),
  mode,
  signal,
  selection = defaultGuestSelection,
  verifyAsset,
}: BrowserRunnerOptions = {}): Promise<QuickjsRunner> {
  signal?.throwIfAborted();

  async function loadAsset(name: string) {
    const response = await fetch(new URL(name, baseUrl), { signal });

    if (!response.ok) {
      throw new Error(`Cannot load QuickJS asset ${name}: HTTP ${response.status}`);
    }

    if (!verifyAsset) {
      return response;
    }

    const bytes = await verifyAsset(name, new Uint8Array(await response.arrayBuffer()));

    return new Response(new Uint8Array(bytes), { headers: response.headers });
  }

  const [bundle, wasmBytes, encoding, url, databaseTemplate, compilerModule, catalog] = await Promise.all([
    loadAsset(`${guestAssetPrefix(selection)}/execution.guest.js`).then((response) => response.text()),
    loadAsset("quickjs.wasm").then(async (response) => new Uint8Array(await response.arrayBuffer())),
    loadAsset("encoding.so").then(async (response) => new Uint8Array(await response.arrayBuffer())),
    loadAsset("url.so").then(async (response) => new Uint8Array(await response.arrayBuffer())),
    loadAsset("postgres-template.tar.gz").then((response) => response.blob()),
    loadAsset("esbuild.wasm").then((response) => WebAssembly.compileStreaming(response)),
    loadAsset(`${guestAssetPrefix(selection)}/catalog.json`).then(async (response) =>
      CatalogSchema.parse(await response.json()),
    ),
  ]);
  const runner = createRunner({
    mode,
    assets: {
      bundle,
      wasmBytes,
      compilerModule,
      databaseTemplate,
      catalog,
      extensionBytes: [
        { name: "encoding", bytes: encoding },
        { name: "url", bytes: url },
      ],
    },
    createWorker() {
      const executionWorker = new Worker(new URL("execution-worker.js", baseUrl), { type: "module" });
      const listeners = new AbortController();

      return {
        listen(receive, fail) {
          executionWorker.addEventListener("message", (event: MessageEvent<unknown>) => receive(event.data), {
            signal: listeners.signal,
          });
          executionWorker.addEventListener("error", (event) => fail(new Error(event.message)), {
            signal: listeners.signal,
          });
        },
        send(request) {
          executionWorker.postMessage(request);
        },
        async terminate() {
          listeners.abort();
          executionWorker.terminate();
        },
      };
    },
  });

  function close() {
    runner.close();

    for (const bytes of [wasmBytes, encoding, url]) {
      if (bytes.byteLength > 0) {
        bytes.buffer.transfer(0);
      }
    }
  }

  return { run: runner.run, close };
}

/** Run two independent browser children; sequential mode waits for release before allocating B. */
export function runBrowserComparison(
  manifests: Record<ComparisonSide, unknown>,
  { baseUrl, ...options }: ComparisonOptions & Pick<BrowserRunnerOptions, "baseUrl"> = {},
) {
  return runComparison({
    createChild: (manifest, signal) =>
      createBrowserRunner({ baseUrl, signal, selection: selectGuest(QuickjsManifestSchema.parse(manifest)) }),
    manifests,
    options,
  });
}
