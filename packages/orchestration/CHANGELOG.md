# @drizzle-run/orchestration

## 0.2.0

### Minor Changes

- f782ec1: First release of the Drizzle Run packages: run Drizzle ORM and Drizzle Kit projects in the browser, on PostgreSQL (PGlite) and SQLite (SQLite WASM), one version at a time or two side by side.

  **@drizzle-run/core**

  Pure TypeScript shared by every host, with zod and es-toolkit as its only dependencies, and `xstate` 5.28 or later as an optional peer dependency that only `./connect` needs. It validates and computes, and never runs user code.

  - `./manifest`: run manifests (`defineRunManifest`, `parseRunManifest`, `safeParseRunManifest`). A manifest pins exact `drizzle-orm` and `drizzle-kit` versions, an optional `guestFlavor`, virtual files, and schema, seed and run entrypoints. Companion libraries such as zod or effect come from the release pair's guest and are never pinned. `listProjectImports`, `findUnavailableImports` and `assertImportsAvailable` check a project's imports against a guest.
  - `./pair`: side-by-side manifests (`createPairManifest`, `parsePairManifest`, `changePairSide`, `sharePairFile`, `addPairFile`, `renamePairSide`, `pairSideLabels`). Each side picks its release and its database, so two sides can compare releases, two ways to write the code, or PostgreSQL and SQLite. Shared files follow the sides: across Legacy and Next only the seed is shared, and across two databases each side keeps its own schema. A side may have a name.
  - `./catalog`: the supported release pairs (Legacy on Drizzle ORM 0.45.4 and Kit 0.31.11, Next on 1.0.0-rc.5 with an Effect 4 flavor), `listSupportedTuples`, `resolveSupportedTuple`, `listCompanionLibraries`, and `DIALECTS`, which describes each database once. A manifest on a release Drizzle Run no longer ships opens with an offer to move it.
  - `./contracts`: `RunResult`, run events, value serialization, playground snapshots, recorded runs, and the official example or guide version a project was forked from.
  - `./registry`: the modules a guest may import, the `@drizzle-run/runtime/context` specifier, and the guest images.
  - `./guide`: guide manifests (`defineGuideManifest`, `safeParseGuideManifest`, `resolveStep`, `applyEdits`, `diffRunResults`). A walkthrough step can edit files, focus a file, and `split` a one-version project into two sides or `merge` it back. A host can add its own step kinds.
  - `./checks`: `evaluateChecks` over a `RunResult` and the files the learner ran.
  - `./connect`: the end-to-end encrypted AI chat link shared by the tab and `@drizzle-run/connect`, and its tool catalog.
  - `./hash`: SHA-256.

  **@drizzle-run/runtime**

  The browser and Node runtime uses QuickJS-WASI. Its tarball includes the engine, exact ORM/Kit dependency bundles,
  workers, compiler/database binaries, and declaration assets. XState is an internal dependency.

  - `./browser`: `createBrowserRuntime()` checks what the page can do (`checkCapabilities`), loads the selected guest assets (`prepare`), and runs a manifest (`createRun`) with SQL, console, display and timing events. Every run gets a fresh guest, module graph and database. Runs are cancellable through `cancel()` or an `AbortSignal`, and the runtime is `AsyncDisposable`.
  - `./node`: `createNodeRuntime()` provides the same execution contract using packaged assets and disposable child processes. `createComparison()` owns independent sides, their scheduling, cancellation, and cleanup in both hosts.
  - `./context`: what project code imports: `db`, `env`, `schema`, `target`, and on PostgreSQL `postgresConnection`, so a client such as `@effect/sql-pg` can open connections of its own. PostgreSQL runs a real `pg` client over PGlite's wire protocol, and SQLite runs the official SQLite WASM engine behind libSQL's client interface.
  - `./type-environment`: Monaco declarations built from a project's exact pins, fetched as digest-checked runtime assets and loaded on a library's first import.
  - `./machines`: reusable XState flows for readiness, guides, release switches and the AI chat link. Run and comparison handles use the shared runtime contract, with optional history supplied by orchestration controllers.
  - `./query-plans`: the planning phase after a run (`planQueries`), which reads the PostgreSQL or SQLite plan of each query, and helpers that read those plans.
  - A manifest's optional `seedGeneratorVersion` makes `drizzle-seed` produce the same rows on both sides of a side by side across Legacy and Next.

  **@drizzle-run/react**

  React providers and hooks over the runtime, with React 19.2 or later as a peer dependency. XState and its React bindings are internal dependencies. `GuideProvider`, `useGuideStep` and `useRunOutput` drive a guide, and the provider's `callback` observes step changes and settled runs. `useRunController` and `useRuntimeComparisonController` own playground history, with `RunProvider`, `ComparisonProvider` and selector hooks sharing their state. The package ships no components or styles.

  **@drizzle-run/orchestration**

  Optional host-independent controllers retain run history and consume SDK comparison handles. Node execution requires only core and runtime, so CLI and AI-plugin consumers can omit orchestration and React.

  **@drizzle-run/connect**

  `npx @drizzle-run/connect <code>` links your Drizzle Run tabs to your own Claude Code, Codex or Grok CLI. The agent gets the Drizzle Run tools and nothing else: it reads, edits and runs the project open in your browser, and each edit waits for Keep or Undo. Messages are end-to-end encrypted through a relay room. `--mcp` serves the same tools to a terminal agent. Node 22.4 or later.

### Patch Changes

- Updated dependencies [f782ec1]
  - @drizzle-run/core@0.2.0
