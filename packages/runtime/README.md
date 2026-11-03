# Drizzle Run runtime

This ESM SDK supplies browser and Node execution through QuickJS-WASI. Manifests, the composition catalog,
and result contracts come from `@drizzle-run/core`. The SDK owns compilation, sandbox execution, the temporary
database, observations, cancellation, and cleanup. XState stays internal; React and history are optional consumers.

The package includes QuickJS, the exact cataloged ORM/Kit pair bundles, workers, compiler/database binaries,
and declaration assets. A CLI or AI plugin can use the Node SDK without copying execution code from this repository.

## Node API

```ts
import { createNodeRuntime } from "@drizzle-run/runtime/node";

await using runtime = createNodeRuntime();
const run = runtime.createRun(manifest);
run.start();
const result = await run.result;
```

The Node SDK reads its packaged assets and creates a disposable child process for execution. PostgreSQL uses
PGlite; SQLite uses the official SQLite Wasm package in memory in both hosts. Project JavaScript, Drizzle Kit, and Drizzle ORM execute
inside QuickJS, never in the consumer's Node realm. Completion follows execution-host teardown.

## Browser API

Copy the SDK asset tree into your application's static directory during its build:

```ts
import { copyRuntimeAssets } from "@drizzle-run/runtime/assets";
await copyRuntimeAssets("public/runtime-assets");
```

Create the runtime in your browser application:

```ts
import { createBrowserRuntime } from "@drizzle-run/runtime/browser";

const runtime = createBrowserRuntime({ assetBaseUrl: "/runtime-assets/" });
const run = runtime.createRun(manifest);
run.start();
const result = await run.result;
await runtime.dispose();
```

Serve copied paths unchanged. The content-addressed directory contains the execution worker, database worker,
WASM binaries, and per-image dependency bundles. Serve `.wasm` as `application/wasm`, JavaScript as
`application/javascript`, and `.gz` as literal gzip payloads without transparent HTTP decompression.
Use HTTPS or localhost with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Runtime worker bundles are already packaged.
SQLite uses temporary memory-backed files with persistent VFS implementations disabled. It does not require
Origin Private File System access. Execution teardown releases the database and its WebAssembly memory.

Both factories return the same `Runtime` contract. `checkCapabilities()` reports host requirements;
`prepare(manifest, { signal })` loads the selected composition; `createRun` captures a manifest revision;
`getSnapshot()` and `subscribe()` expose lifecycle state. Run handles provide `start`, `cancel`, `result`,
`subscribe`, and `subscribeEvent`. `dispose()` cancels active work and releases owned resources.

The runtime also owns comparisons, including their independent child runtimes:

```ts
const comparison = runtime.createComparison({ a: manifestA, b: manifestB }, { execution: "sequential" });
comparison.sides.a.result.then(showA);
comparison.sides.b.result.then(showB);
comparison.start();
const results = await comparison.result;
```

Parallel execution is the default. Each side publishes after its execution host is released; aggregate completion
waits for both. Sequential execution releases A before starting B. Cancelling or disposing the runtime cancels
active children and prevents pending children from allocating an execution host.

## Execution and types

The pinned catalog admits Legacy and rc.5 ORM/Kit images, including the Effect flavor, for PostgreSQL and SQLite.
Each execution owns a fresh QuickJS realm and temporary database. Schema, Kit, ORM, seed, and query share module
identity inside that realm. The compiler binds approved imports to the selected image's dependency instances.

PostgreSQL bridges the guest's real `pg` client to PGlite's binary protocol. SQLite preserves the guest's
libSQL-compatible driver interface over SQLite Wasm. Structured observations include SQL, console output, display values,
mapped errors, inspection, query plans, and timings through public SDK contracts.

`/type-environment` supplies editor declaration closures from the same exact package pins. Gzip artifacts carry
stored and decompressed size/SHA-256 metadata. SDK preparation verifies the engine, compiler, template, extensions,
selected dependency bundle, and catalog against the package inventory. Worker scripts and database binaries load
from the same content-addressed directory through the host's module and database loaders.

## Direct QuickJS execution

The lower-level `/quickjs/node` and `/quickjs/browser` entries expose `createNodeRunner`, `createBrowserRunner`,
`runNodeComparison`, and `runBrowserComparison`. `/quickjs` exports the structured result codec and contracts.
These APIs expose direct QuickJS outcomes rather than the public SDK's run observations.

A runner admits one execution at a time. Dependency-only snapshots can be retained by the runner and restored
into fresh VMs; `mode: "fresh"` disables reuse. Closing releases snapshots and refuses subsequent runs.
Comparison children settle independently after teardown. Sequential mode releases A before allocating B.

Direct browser runners accept a `baseUrl` pointing to the complete packaged `dist/quickjs/` directory.
Direct Node runners accept an optional `directory` URL. Consumers choosing custom assets can provide a
`verifyAsset(name, bytes)` callback; the main SDK factories supply the package's integrity verifier.

## Build and verification

From the repository root:

```bash
pnpm exec turbo run build --filter=@drizzle-run/runtime
pnpm --filter @drizzle-run/runtime typecheck
pnpm --filter @drizzle-run/runtime test:quickjs
pnpm --filter @drizzle-run/runtime test:quickjs:acceptance
pnpm --filter @drizzle-run/runtime test:pack
pnpm --filter @drizzle-run/runtime test:sdk
```

The build installs locked guest trees, bundles each image/dialect, generates immutable asset inventories,
emits TypeScript declarations, and stages the package. Acceptance exercises Node, Chromium, and WebKit;
the SDK consumer audit installs packed packages outside the checkout and disables network access during execution.
The TypeScript build and audit scripts use Node's native type stripping. The runtime typecheck covers
these scripts and SDK fixtures; a separate Node-only check verifies the consumer declarations without DOM libraries.
See [the architecture](../../docs/architecture.md) for ownership and verification boundaries.
