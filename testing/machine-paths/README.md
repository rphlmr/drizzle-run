# @drizzle-run/machine-paths

Path tests for XState machines. It is private and source only: packages list it in `devDependencies` and import it from
tests, never from shipped code.

`createTestModel` from `xstate/graph` refuses machines that invoke actors or wait on delays, which most machines here do.
This package walks the real machine with `getShortestPaths` and `getAdjacencyMap` from `xstate/graph` instead, then
replays each path on a running actor whose actors are fakes.

| Export                                                      | What it does                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `getMachinePaths(machine, { events, toModelState, input })` | One path per transition: the shortest path to its source state, then its event, so every guard branch gets one |
| `getSettleEvents(snapshot, outcomes)`                       | The done and error events of the actors a state runs, from the outcomes keyed by actor `src`                   |
| `createActorSettler()`                                      | `fromOutcome(outcome)` fakes a promise actor that waits until a replayed path settles it                       |
| `replayMachinePath(path, { actor, settler, toModelState })` | Sends each step to the running actor and throws on the first step whose model state differs                    |
| `toTransitionTable(paths)`                                  | One line per transition, for a snapshot that shows a changed guard or target as a diff                         |

`toModelState` picks what tells two states apart: the state value and the context the guards read. Every distinct value
is a node of the graph, so keep it small. `packages/runtime/src/machines/release-switch.paths.test.ts` shows the whole
pattern.
