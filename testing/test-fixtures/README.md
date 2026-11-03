# @drizzle-run/test-fixtures

Test data shared by the tests of the Drizzle Run app (`apps/drizzle-run`), `@drizzle-run/runtime` and
`@drizzle-run/react`. It is private and source only: those packages list it in `devDependencies` and import it from
tests, never from shipped code.

| Entry   | Fixtures                                                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`     | `projectManifest(dialect, { releaseLine, seed })`, a small valid project, with a `seed.ts` when `seed` is on; `fakeRunResult(outcome, options)`, a complete `RunResult` with its tuple read from the catalog; `legacyGuest()`, the Legacy recorded guest |
| `/pair` | `pairManifest(targets, { seed })`, a side-by-side project with the Legacy pair on the first target and the Next pair on the second; its `seed.ts`, when `seed` is on, stays shared                                                                       |

Fixtures default to PostgreSQL on the Legacy pair and read versions from the release catalog, so a release bump needs no
edit here.

Their own tests (`src/*.test.ts`) check each option, such as `releaseLine` and `targets`, against the catalog.

A new fixture goes here once the tests of two of these packages need it, in the entry file of its subject (`src/run.ts`
for runs and projects, `src/pair.ts` for side-by-side projects), with an export entry in `package.json` for a new
file. A fixture only one package's tests use stays in that package's own `test/` folder.
