# React bindings

`@drizzle-run/react` provides hooks and context providers over the SDK's plain controllers.
React 19.2 or later is the only peer dependency. Consumers do not need XState.
The package ships no visual components or styles.

## Own a controller in a component

```tsx
import type { Executor } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { useRunController, useControllerState } from "@drizzle-run/react";

export function RunButton({ runtime, manifest }: { runtime: Executor; manifest: RunManifest }) {
  const runs = useRunController({ runtime });
  const state = useControllerState(runs);
  const busy = state.status === "running" || state.status === "disposing";

  async function run() {
    try {
      await runs.submit({ manifest, revision: 1, debug: false });
    } catch (cause) {
      console.error("The submission could not start.", cause);
    }
  }

  return (
    <button type="button" disabled={busy} onClick={run}>
      {busy ? state.progress : "Run"}
    </button>
  );
}
```

The hook owns the controller and disposes it after unmount, cancelling active work and waiting for settlement.
React StrictMode's immediate effect reconnect preserves it. Hiding a React Activity cancels active work while
retaining the controller and its history; showing it reconnects subscriptions to the same controller.
Ownership uses React's insertion-effect lifetime, which Activity retains until actual unmount.
Options are read once; mount with a new key when
replacing the controller, or supply a runtime per submission. The caller owns the runtime's disposal.

## Share a controller with children

`RunProvider` takes a `controller` created by a hook or by `createRunController`.
The provider borrows it: unmounting a provider does not dispose a caller-owned controller.
Nested providers isolate their histories, including the two sides of a comparison.

| Hook                                                    | Purpose                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `useRunActions()`                                       | Access `submit`, `cancel`, `replay` and `selectHistoryEntry` |
| `useRunState()`                                         | Read the closest controller's plain state                    |
| `useRunSelector(selector, compare?)`                    | Subscribe to a selected value                                |
| `useRunInProgress()`                                    | Read whether execution or disposal is in progress            |
| `useRunSettled(callback)`                               | Observe completed submissions using the latest callback      |
| `useControllerState(controller)`                        | Read an explicit controller without a provider               |
| `useControllerSelector(controller, selector, compare?)` | Select from an explicit controller                           |

`useComparisonController(options)`, `ComparisonProvider`, `useComparisonState()`,
`useComparisonActions()` and `useComparisonSettled(callback)` provide the same integration for comparisons.
Comparison options and callbacks are read once when creating the controller.

## Guides

`GuideProvider` accepts a guide manifest, a runtime or a `services.run` callback, optional progress storage,
and callbacks for step changes, completed runs, errors, leaving and finishing.
The runtime must support both `createRun` and `createComparison`, as the browser and Node SDK factories do.
Pair steps use sequential SDK comparisons, wait for both sides' cleanup, and cancel the comparison when the step is left.

- `useGuideStep()` exposes the step, files, editor lock and allowed actions.
- `useGuideActions()` provides `run`, `cancel`, `next`, `back`, `goToStep`, `leave`, `resume` and `restart`.
- `useRunOutput()` exposes the step's result, error and comparison.
- `useGuideLastRun()` exposes the last completed run across step changes.
- `useGuideSelector(selector, compare?)` selects from the plain guide view.
- `useGuideDebug(enabled)` logs guide transitions for development.

A missing provider throws an error naming the required provider. Guide services and callbacks use their latest
rendered values. Manifest and starting step are read once; use a new provider key to open another guide.
Failed or timed-out progress loading disables saving for that visit to avoid overwriting stored progress.

## Checks

`pnpm --filter @drizzle-run/react test` checks behavior, coverage and package contents.
`pnpm --filter @drizzle-run/react test:pack` checks package exports and declarations.
After building the SDK packages, `node scripts/audit-sdk-api.ts` checks that their consumer declarations
do not expose XState.
