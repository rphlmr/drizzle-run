# Drizzle Run capability harness

Internal, private validation of the pinned Drizzle releases. Nothing outside this repository should import it.

The ORM and Kit corpora live in `src/orm-corpus/` and `src/kit-corpus/`. Gates use the installed guest packages in
`guests/` and the built runtime under `packages/runtime/dist/`. Build the runtime before running them.

## Checks

`pnpm --filter @drizzle-run/capability-harness typecheck` checks the TypeScript gates and scripts, then the corpus against each guest's exact ORM declarations.
The script writes generated tsconfigs into `.cache/harness-corpus/`; pass guest image ids to narrow it.

`pnpm test:runtime` runs three gates:

| Gate                 | Checks                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance.gate.ts` | Public Node SDK execution for every guest/dialect: feature inventory, ORM scenarios, exported API coverage, logs, transactions, failure/recovery, query plans, and Effect integrations. Every run must report clean resource teardown.                                          |
| `kit-parity.gate.ts` | All 42 schema scenarios per guest generate byte-identical SQL using native pinned packages and the shipped QuickJS-WASI dependency bundle.                                                                                                                                      |
| `ownership.gate.ts`  | Legacy SQLite cancellation before start, during compile/run, and after entering a user loop or long SQL operation. Recovery sees a fresh database after each cancellation. Disposal leaves no child process or temporary database/snapshot directory. Uses `ps` on macOS/Linux. |

Acceptance exercises production QuickJS execution. It does not establish complete native-versus-QuickJS
SQL/result/event parity for ORM runs. Kit generation retains that independent native comparison.

Narrow acceptance with `DRIZZLE_RUN_ACCEPTANCE_PAIR=<image id>` and
`DRIZZLE_RUN_ACCEPTANCE_DIALECT=postgresql|sqlite`. Narrow Kit parity with
`DRIZZLE_RUN_KIT_PARITY_PAIR=<image id>`. Acceptance's per-run deadline defaults to 180,000 ms and can be changed with
`DRIZZLE_RUN_ACCEPTANCE_TIMEOUT_MS`.

`pnpm --filter @drizzle-run/capability-harness test` tests the gate's SDK execution and cleanup checks.
