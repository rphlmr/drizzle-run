# Orchestration

`@drizzle-run/orchestration` provides run history and comparison scheduling over an injected executor.
Consumers use methods, promises and plain state. XState is an internal dependency; consumers do not install it,
import actors, send machine events or inspect machine snapshots.

The package depends on core and receives its runtime through the executor contract, which both browser and Node
runtimes implement.

## Run controller

```ts
import { createRunController } from "@drizzle-run/orchestration/run";
import { createNodeRuntime } from "@drizzle-run/runtime/node";

const runtime = createNodeRuntime();
const runs = createRunController({ runtime });

try {
  const outcome = await runs.submit({ manifest, revision: 1, debug: false });
  console.log(outcome.result);
  console.log(runs.getState().history);
} finally {
  try {
    await runs.dispose();
  } finally {
    await runtime.dispose();
  }
}
```

Use `createBrowserRuntime` from `@drizzle-run/runtime/browser` in a browser. All controller operations stay the same.

- `submit(submission, options?)` returns that submission's outcome. Concurrent requests reject with
  `RunRefusedError`. Execution failures resolve with a failed outcome.
- `options.signal` cancels only that request. Already aborted signals reject before execution starts.
- `options.prepare` can format the submission before execution. Cancellation aborts preparation.
- `cancel()` requests cancellation and waits for the workflow to settle.
- `getState()` returns plain state with `status`, `progress`, `result`, `history` and `selectedHistoryEntry`.
- `subscribe(listener)` observes subsequent state changes; `onSettled(listener)` observes completed submissions.
  Both return an object with `unsubscribe()`.
- `selectHistoryEntry(number)` selects a retained run; `replay({ submission, result })` displays a recorded run.
- `dispose()` closes admission, cancels active work and waits for settlement. The caller still owns the runtime.

A controller retains the last 20 runs. Each execution gets a fresh guest and one fresh database.
The runtime owns actual termination and cleanup evidence. The internal execution watchdog can settle a failed
workflow while the runtime continues cleanup and keeps its admission slot closed.

## Comparisons

```ts
import { createComparisonController } from "@drizzle-run/orchestration/comparison";

const comparison = createComparisonController({
  execution: "sequential",
  runSide: ({ side, manifest, signal }) => executeSide({ side, manifest, signal }),
});

try {
  const outcome = await comparison.submit();
  console.log(outcome.runs);
} finally {
  await comparison.dispose();
}
```

The host supplies `runSide`, returning a side outcome or a result with its outcome. Cancellation aborts each
active side's signal and waits for settlement. Sequential scheduling skips a side that has not started after
cancellation. Parallel scheduling is the default. `getManifest` supplies the current comparison for shared-seed
validation; `submit({ manifest })` can supply another.

`createRuntimeComparisonController` from the package root uses the runtime's `createComparison` to own both
executions. Its `runSide` callback attaches optional history to the supplied execution port and receives the same
captured pair that the SDK executes. Each side's history remains available independently. The comparison controller
waits for SDK aggregate cleanup before settling; an aggregate cleanup failure closes admission, appears in state,
and rejects pending submissions, cancellation and disposal. The caller still owns the runtime.

## React

`@drizzle-run/react` supplies `useRunController`, `useComparisonController`, state selectors and context providers
over these same contracts. It adds no execution lifecycle of its own.

## Checks

`pnpm --filter @drizzle-run/orchestration test` covers controller behavior and internal transition paths.
`pnpm --filter @drizzle-run/orchestration test:pack` installs core and orchestration outside the repository and
compiles and executes a Node consumer without DOM libraries or a direct XState dependency.
`node scripts/audit-sdk-api.ts` checks the built SDK declaration graph for exposed XState types and required peers.
