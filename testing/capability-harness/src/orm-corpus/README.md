# ORM API corpus

Four version-specific corpora run the Drizzle ORM API as playground user code:

| Corpus                 | ORM          | Dialect                            | Scenarios |
| ---------------------- | ------------ | ---------------------------------- | --------- |
| `next-postgresql.ts`   | `1.0.0-rc.5` | PostgreSQL (PGlite, node-postgres) | 45        |
| `next-sqlite.ts`       | `1.0.0-rc.5` | SQLite (libsql)                    | 41        |
| `legacy-postgresql.ts` | `0.45.4`     | PostgreSQL (PGlite, node-postgres) | 45        |
| `legacy-sqlite.ts`     | `0.45.4`     | SQLite (libsql)                    | 41        |

Each corpus has a schema file (`*.schema.ts`) that becomes the project's schema entrypoint, so Kit generates its DDL
like any playground. Scenarios share one database, run in order, and roll back their writes, so each one sees the
rows `baseline-seed` inserted. Writes that cannot roll back (sequences, committed transactions) stay deterministic
because scenarios execute the same statements in the same order.

## Gate

`testing/capability-harness/src/gates/acceptance.gate.ts` turns each corpus into a playground project and
runs it through the public Node SDK, which executes the shipped QuickJS-WASI dependency bundle in a disposable
process with a fresh database. Every committed scenario must execute in order and pass its assertions.
Export and builder-method coverage still reads the pinned native package installation.

`gates/orm-expectations.ts` checks every scenario's returned fields against expectations derived from the seed,
schema, SQL predicates, and pinned driver behavior. SQL-only cases check statement structure and parameters;
database failures require the expected database code and error detail. Engine metadata, timezone formatting,
and floating point distances use semantic checks. Result fixtures are not generated from a passing runtime run.

The acceptance gate does not compare complete run output against native Node. Native-versus-QuickJS SQL generation
parity is covered separately by the Kit gate. Results are converted by `toComparable` in `run-cases.ts`: dates, bigints, bytes, and `undefined` keep
tagged forms, and errors keep their name, message, database code, and cause chain (stacks are engine positions).

## Coverage rules

Both checks read the guest's own packages from its `node_modules`, so a release bump that adds an export or a builder
method fails the gate until the corpus calls it or a list records why it is not user API. A listed name that the
corpus starts calling, or that the release removes, also fails.

### Exports

`assertOrmExportCoverage` in `gates/orm-corpus.ts` reads the function exports of `drizzle-orm` and
`drizzle-orm/pg-core` or `drizzle-orm/sqlite-core` from the guest's own packages. Every export must be called by the
corpus (as `orm.name`, `pg.name`, or `sqlite.name`) or be listed in `uncoveredExports` with one of these reasons:

- runtime export without a type declaration, so user code cannot import it;
- dialect, driver, or relational query internal, run by every query the corpus executes;
- reached through a public API the corpus calls (`pgSchema(...)`, the driver migrators).

Classes (`PgDialect`, `SQL`, `DrizzleError`) and non-function exports are not enumerated; the corpus reaches them
through the builders.

### Builder methods

`assertOrmMethodCoverage` creates a mock database with the guest's driver (`drizzle-orm/node-postgres` or
`drizzle-orm/libsql/web`) and lists the methods user code reaches from it:

- the database and its transaction class;
- select, insert, update, and delete builders, before and after `from`, `values`, and `set`;
- relational query builders (`db.query.<table>` and the query `findMany` returns);
- `refreshMaterializedView` (PostgreSQL);
- every column builder class the dialect package exports, plus a column builder instance.

Methods come from instances and their prototype chains, because joins, set operators, `$with`, and `$default` are
instance properties. Each method name must appear in the corpus source as `.name(` or `.name<`, or be listed in
`uncoveredMethods` (per release: `shared`, `postgresql`, `sqlite`) with one of these reasons:

- Promise protocol (`then`, `catch`, `finally`), run by every awaited query;
- underscore-prefixed internal;
- absent from, or protected in, the type declarations;
- an internal step that only leaks into some declarations (column `build`), or a driver-only API (`setToken`).

The match is by name across builders, so `.where(` on a select also counts for update and delete. The failure lists
each missing method with the builders that have it.

## Scenario areas

Both dialects, both releases, unless noted:

- **Select:** all and partial columns, nested selections, `getTableColumns`, SQL fields with `.as()` and
  `.mapWith()`, `selectDistinct`, `selectDistinctOn` (PostgreSQL), `.all()/.get()/.values()` (SQLite), `$withCache`
  without a configured cache.
- **Filters:** every comparison, logical, null, set, range, pattern, and `exists` operator; array operators
  (PostgreSQL; SQL text only on SQLite); `ilike` (SQL text only on SQLite).
- **Shaping:** ordering, `nulls last`, limit and offset, aggregates with `groupBy` and `having`.
- **Joins:** left, right, inner, full, cross, lateral (PostgreSQL), aliases and self joins.
- **Composition:** subqueries, scalar subqueries, CTEs (with data-modifying CTEs), every set operation as function
  and method, `$dynamic`, `$count`, row locking (PostgreSQL).
- **Statements:** prepared statements with placeholders, `sql` helpers (`join`, `raw`, `identifier`, `empty`,
  `param`, `fromList`, `append`, `inlineParams`), `toSQL`, a builder's `getSQL` embedded in raw SQL, SQL comments
  (1.0 PostgreSQL).
- **Writes:** insert (single, many, select, callback select, SQL values), every `onConflict` form, update (with
  `from` and expressions), delete, `RETURNING`, SQLite `batch`.
- **Transactions:** commit, `tx.rollback()`, thrown errors, nested savepoints, isolation and access modes and
  `tx.setTransaction` (PostgreSQL), SQLite behaviors; database errors with their codes.
- **Relational queries:** `findMany`, `findFirst`, columns, nested `with`, many-to-many, self relations, aliased
  relations, extras, filters (1.0 object filters, 0.45 callbacks), prepared relational queries.
- **Schema features:** every column type and mode the engine supports, round tripped; PostGIS `geometry` as SQL text
  only (PGlite has no PostGIS); vector distances; identity, generated, and `$default/$onUpdate` columns; database
  defaults (`defaultNow`, `defaultRandom`), checked by predicate because their values differ per run; constraints
  and their violations; views, SQL views, and materialized views with refresh (`withNoData`, `concurrently`); enums,
  schemas, sequences, table creators, RLS; `withReplicas`.
- **Metadata helpers:** `getTableConfig`, `getViewConfig`, `is`, entity predicates, PostgreSQL array helpers.

## Maintenance

Add a scenario to every corpus whose release and dialect support it, and add its id to that corpus's list in
`case-ids.json`, in run order: the gate fails when a corpus runs other scenarios than the list. Describe a release-only
API explicitly instead of dropping it. A value the database generates per run (current time, random UUID) is returned as a predicate or a
fixed part, never as the value. Do not normalize away a native and browser difference to turn the gate green: a mismatch is a
potential Drizzle Run defect until a minimal case shows otherwise.
