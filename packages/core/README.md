# Drizzle Run core

Pure TypeScript for Drizzle Run: manifests, contracts, guides, and checks. Its only dependencies are zod and es-toolkit. `./connect` also needs xstate 5.28 or later, an optional peer that runs the AI chat link's handshake. Core never touches QuickJS, databases, React, storage, or the network, so the app, the runtime, a server, or another host can share it. Core never executes user code; `@drizzle-run/runtime` does.

## Subpaths

| Subpath       | Holds                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./manifest`  | `defineRunManifest`, `parseRunManifest`, `safeParseRunManifest`, retired-pair moves                                                                                                                                   |
| `./pair`      | Side-by-side manifests: `createPairManifest`, `parsePairManifest`, `changePairSide`, `sharePairFile`, `pairSideLabels`, `isCrossDatabasePair`, `listManifestTargets`                                                  |
| `./catalog`   | Supported release pairs and their selection: `listSupportedTuples`, `resolveSupportedTuple`, `selectFromPairs`, guest flavors, companion libraries                                                                    |
| `./contracts` | `RunResult`, run events, serialization, playground snapshots, the official version a project was forked from                                                                                                          |
| `./registry`  | What a runtime loads a guest with: approved modules, context specifiers, guest images                                                                                                                                 |
| `./hash`      | SHA-256                                                                                                                                                                                                               |
| `./guide`     | Guide manifests: define, parse, resolve steps, apply edits, diff run results, rich text, and the parser pieces a host adds its own step kinds with                                                                    |
| `./checks`    | Check specs and `evaluateChecks` over a `RunResult` and the files the learner ran                                                                                                                                     |
| `./connect`   | The AI chat link shared by the tab and `@drizzle-run/connect`: pairing secrets, key derivation and sealing (WebCrypto), relay frames, sealed messages and their channel, the Drizzle Run tool catalog, and file edits |

Import from the corresponding `@drizzle-run/core/*` subpath; `@drizzle-run/runtime` does not re-export them.

```ts
import { defineRunManifest } from "@drizzle-run/core/manifest";
```

## Guides

A guide manifest is a starting project (`project`, one version or side by side) plus ordered steps. Author it with `defineGuideManifest`, which keeps literal types and checks that edits, focus and split files name real files. Read untrusted input with `safeParseGuideManifest`; it returns typed issues with paths instead of throwing.

- `resolveStep(manifest, index)` replays every split, merge and edit up to that step and returns its project, of either shape.
- `applyEdits(files, edits)` writes a file or replaces an anchor that must match exactly once.
- `diffRunResults(previous, current)` reports added, removed, and changed display rows.
- A guide pinned to an older Legacy release, in its project or a split side, opens on the current Legacy pair, as projects and shared links do.

Today the only step kind is `walkthrough`: optional edits and focus, a `run` policy (`none`, `optional`, `required`), and highlighted displays. Bodies use a small rich-text format: paragraphs, `` `code` ``, `**bold**`, and `[label](https or /path)`.

A walkthrough step can change the project's shape before its edits apply, at any step and as often as needed:

- `split: { sides: [{ name?, target?, dependencies?, guestFlavor? }, { ... }], files }` opens two sides from a one-version project. Listed files get a copy per side; the rest, and always the seed, stay shared. A side runs the project's database and release unless it names its own, so a step can compare two ways to write the code, two releases, or PostgreSQL and SQLite. Sides on two databases split the schema entrypoint, since each writes its tables for its own database.
- `merge: { keep }` returns to one version: the shared files plus side `keep`'s files and release.

Between a split and a merge, edits and focus name the `side` whose copy of a per-side file they mean, as in a side-by-side guide.

A host can add its own step kinds without changing core: `createGuideManifestParser([...STEP_KINDS, myKind])` builds a parser, where each `StepKindDefinition` reads its fields with `readStepBase` and replays its project changes with `replayEdits`. `resolveStep` reads any kind through the same optional `split`, `merge` and `edits` fields; a kind without them leaves the files as they are.

## Checks

`evaluateChecks(result, checks, { expected, files })` reports whether a run passed each check: `noError`, `table`, `foreignKey`, `index`, `display`, `matchesSolution` against the solution's recorded displays in `expected`, `sqlExecuted`, and `fileContains`, which reads the learner's code in `files`. Text matches in code are case sensitive.

## Compatibility rules

- A newer `manifestVersion` yields only `UNSUPPORTED_VERSION`. Hosts show "update needed" instead of guessing.
- An unknown step kind yields `UNSUPPORTED_STEP_KIND`, so later kinds arrive as additions, not breaking changes. `safeParseCheckSpec` reports an unknown check type as `UNSUPPORTED_CHECK`; no shipped step kind holds checks yet, so a guide never reports it today.
- Unknown fields yield `UNKNOWN_FIELD`. Consumer data belongs in `meta` on the guide or a step; core checks that it is a plain object and returns it untouched.

## Limits

Core validates and computes; it does not run code, persist progress, or fetch guides. Progress, routing, and execution belong to the host and to `@drizzle-run/runtime/machines`.

## Development checks

From the repository root:

```bash
pnpm --filter @drizzle-run/core test
pnpm --filter @drizzle-run/core test:pack
```

The pack audit installs the tarball alone and imports every subpath in Node.
