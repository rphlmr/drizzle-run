# Internal testing

This directory contains private, source-only workspaces used to validate Drizzle Run. Production packages live
under `packages/`; test consumers declare these helpers in `devDependencies`.

| Workspace                                          | Purpose                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [machine-paths](machine-paths/README.md)           | Generate and replay XState transition paths. Depends on XState, independently of the SDK. |
| [test-fixtures](test-fixtures/README.md)           | Shared run and comparison fixtures built from the core contracts and release catalog.     |
| [capability-harness](capability-harness/README.md) | Runtime capability, native Kit parity, cancellation, and corpus checks.                   |

These remain separate workspaces because core's tests depend on `machine-paths`, while `test-fixtures` depends on
core. A single workspace would create a dependency cycle. The existing package names and exports keep this
dependency direction explicit and let checks run independently.

Run `pnpm test:runtime` from the repository root for the capability gates. The normal workspace typecheck and
test commands include these workspaces. Fixtures and corpus projects are test inputs, not supported SDK exports.
