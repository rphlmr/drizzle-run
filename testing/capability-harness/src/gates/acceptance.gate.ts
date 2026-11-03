import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunTransaction, Runtime } from "../../../../packages/core/src/contracts/index.ts";
import { listSupportedTuples } from "../../../../packages/core/src/registry/selectors.ts";
import { createNodeRuntime } from "../../../../packages/runtime/dist/node/index.js";
import { createGuestPackageLocator } from "../../../../scripts/guests/guest-installs.ts";
import { getHarnessPair, type Dialect, type GateRun, type HarnessPair } from "./contract.ts";
import { createAcceptanceManifest, getGuestPin } from "./fixtures.ts";
import {
  assertOrmExportCoverage,
  assertOrmMethodCoverage,
  createOrmCorpusManifest,
  getExpectedOrmCaseIds,
  readOrmCaseResults,
} from "./orm-corpus.ts";
import { assertOrmCaseResults } from "./orm-expectations.ts";
import { runProject, withCleanup } from "./sdk-run.ts";

/** The acceptance project's committed transfer with a savepoint that throws, then a transaction that throws. */
function assertTransactionContract(run: GateRun, label: string) {
  const transactions = run.report.transactions ?? [];
  const statements = new Map(
    run.events.filter((event) => event.type === "sql").map((event) => [event.payload.sequence, event.payload.sql]),
  );
  const sqlOf = (transaction: RunTransaction, index: number) => {
    const statement = transaction.statements.at(index);

    return statement ? (statements.get(statement.sequence) ?? "") : "";
  };
  const committed = transactions.find(
    (transaction) =>
      transaction.parent === void 0 &&
      transaction.outcome === "committed" &&
      transactions.some((nested) => nested.parent === transaction.id),
  );
  assert.ok(committed, `${label} reports the committed transaction that holds a savepoint`);
  const savepoint = transactions.find((nested) => nested.parent === committed.id);
  assert.ok(savepoint, `${label} reports the nested savepoint`);
  const rolledBack = transactions.find((transaction) => transaction.error?.message === "transaction rollback");
  assert.ok(rolledBack, `${label} reports the transaction that threw`);
  assert.deepEqual(
    [
      savepoint.outcome,
      savepoint.reason,
      savepoint.error?.message,
      rolledBack.outcome,
      rolledBack.reason,
      rolledBack.parent,
    ],
    ["rolled_back", "error", "savepoint rollback", "rolled_back", "error", void 0],
    `${label} transaction outcomes`,
  );
  assert.match(sqlOf(committed, 0), /^begin\b/i, `${label} transaction begins`);
  assert.match(sqlOf(committed, -1), /^commit$/i, `${label} transaction commits`);
  assert.match(sqlOf(savepoint, 0), /^savepoint /i, `${label} savepoint opens`);
  assert.match(sqlOf(savepoint, -1), /^rollback to savepoint /i, `${label} savepoint rolls back`);
  assert.match(sqlOf(rolledBack, -1), /^rollback$/i, `${label} transaction rolls back`);
  assert.deepEqual(
    committed.statements.map(({ role }) => role),
    ["begin", "write", "commit"],
    `${label} statement command tags classify the public transaction roles`,
  );
  const rowCountOf = new Map(
    run.events.filter((event) => event.type === "sql").map((event) => [event.payload.sequence, event.payload.rowCount]),
  );
  const committedCounts = committed.statements.map(
    ({ sequence }) => [statements.get(sequence) ?? "", rowCountOf.get(sequence)] as const,
  );
  assert.ok(
    committedCounts.some(
      ([sql, count]) => /^insert\b/i.test(sql) && typeof count === "number" && Number.isSafeInteger(count) && count > 0,
    ),
    `${label} the committed insert reports its row count`,
  );
  assert.ok(
    committedCounts.filter(([sql]) => /^(begin|commit)\b/i.test(sql)).every(([, count]) => count === void 0),
    `${label} begin and commit report no row count`,
  );
}

function getEmittedFeatureNames(run: GateRun) {
  const value = run.report.value;

  if (value.type !== "object") {
    return [];
  }

  const featureValue = value.value.features;

  if (featureValue?.type !== "array") {
    return [];
  }

  return featureValue.value.flatMap((item) =>
    item.type === "primitive" && typeof item.value === "string" ? [item.value] : [],
  );
}

function assertGuestLogContract({
  run,
  pair,
  dialect,
  featureCount,
}: {
  run: GateRun;
  pair: HarnessPair;
  dialect: Dialect;
  featureCount: number;
}) {
  const logs = run.events.filter((event) => event.type === "log");
  const seedVersion = getGuestPin(pair, "drizzle-seed");
  const serializedLog = (marker: string) => [
    { type: "primitive", value: `acceptance ${marker} log` },
    {
      type: "object",
      value: {
        dialect: { type: "primitive", value: dialect },
        marker: { type: "primitive", value: marker },
      },
    },
    { type: "undefined" },
  ];

  assert.equal(logs.length, 3, `${dialect} must emit schema, seed, and run logs`);

  const sequences = logs.map((event) => event.payload.sequence);
  assert.ok(sequences.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0));
  assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]));
  assert.deepEqual(
    logs.map((event) => event.payload.phase),
    ["schema", "seed", "run"],
  );
  assert.deepEqual(
    logs.map((event) => event.payload.level),
    ["log", "log", "log"],
  );
  assert.deepEqual(
    logs.map((event) => event.payload.source),
    ["schema.ts", "seed.ts", "run.ts"],
    `${dialect} logs must map their call sites to project files`,
  );
  assert.ok(
    logs.every(
      (event) =>
        typeof event.payload.line === "number" && Number.isInteger(event.payload.line) && event.payload.line > 0,
    ),
    `${dialect} logs must carry project line numbers`,
  );
  assert.deepEqual(
    logs.map((event) => event.payload.values),
    [
      serializedLog("schema"),
      [
        { type: "primitive", value: "seeded acceptance rows" },
        { type: "primitive", value: seedVersion },
      ],
      [
        { type: "primitive", value: "runtime acceptance" },
        {
          type: "object",
          value: {
            dialect: { type: "primitive", value: dialect },
            features: { type: "primitive", value: featureCount },
            marker: { type: "primitive", value: "run" },
          },
        },
        { type: "undefined" },
      ],
    ],
  );
}

const validatorInventoryByApi = {
  v0: (pair: HarnessPair) =>
    ["drizzle-zod", "drizzle-valibot", "drizzle-typebox", "drizzle-arktype"].map(
      (packageName) => `${packageName}@${getGuestPin(pair, packageName)}`,
    ),
  v1: () => ["drizzle-orm/{zod,valibot,arktype,typebox-legacy,typebox}"],
};

function getSourcePackageInventory(pair: HarnessPair) {
  const validatorInventory = validatorInventoryByApi[pair.ormApi];

  if (validatorInventory === undefined) {
    throw new Error(
      `No validator inventory is registered for ORM API ${pair.ormApi} (guest ${pair.id}); expected one of ${Object.keys(validatorInventoryByApi).join(", ")}`,
    );
  }

  return [
    `drizzle-orm@${pair.ormVersion}`,
    `drizzle-kit@${pair.kitVersion}`,
    `drizzle-seed@${getGuestPin(pair, "drizzle-seed")}`,
    ...validatorInventory(pair),
  ];
}

async function runMatrix() {
  const rows = [];

  console.log("Drizzle Run runtime acceptance matrix");

  const tuples = listSupportedTuples();
  const locator = await createGuestPackageLocator(fileURLToPath(new URL("../../../../guests", import.meta.url)));

  for (const asset of locator.guests) {
    const id = asset.id;

    if (process.env.DRIZZLE_RUN_ACCEPTANCE_PAIR && process.env.DRIZZLE_RUN_ACCEPTANCE_PAIR !== id) {
      continue;
    }

    const pair = getHarnessPair(asset);
    const guestDir = dirname(dirname(locator.locate("drizzle-orm", asset.ormVersion)));
    const runtime = createNodeRuntime();

    await withCleanup({
      work: async () => {
        const dialects = process.env.DRIZZLE_RUN_ACCEPTANCE_DIALECT
          ? [process.env.DRIZZLE_RUN_ACCEPTANCE_DIALECT]
          : ["postgresql", "sqlite"];

        for (const dialect of dialects) {
          assert.ok(dialect === "postgresql" || dialect === "sqlite", `Unsupported acceptance dialect: ${dialect}`);
          assert.ok(
            tuples.some(
              (tuple) =>
                tuple.target.dialect === dialect &&
                tuple.ormVersion === pair.ormVersion &&
                tuple.kitVersion === pair.kitVersion,
            ),
            `Release tuple ${id} is not admitted for ${dialect}`,
          );
          const fullManifest = createAcceptanceManifest({ pair, dialect, kind: "full" });
          const sdkFull = await runProject({ runtime, manifest: fullManifest });
          assert.equal(
            sdkFull.report.outcome,
            "succeeded",
            `${id} ${dialect} SDK: ${JSON.stringify(sdkFull.report.error ?? "unknown failure")}`,
          );
          const expectedFeatures = [
            "top-level-await",
            "multi-file-import-cycle",
            "module-evaluates-once",
            "seed-integration",
            "upsert-and-returning",
            "aliases",
            "aggregation-and-grouping",
            "cte",
            "subquery",
            "set-operations",
            "dynamic-query",
            "prepared-query",
            "relational-query-api",
            "relational-results",
            "views",
            "implicit-column-name",
            "defaults-and-generated-columns",
            "custom-type-and-json",
            "bigint-and-binary",
          ];

          if (dialect === "postgresql") {
            expectedFeatures.push("postgres-arrays", "pgvector-insert-query", "read-only-transaction");
          }

          expectedFeatures.push("commit-explicit-rollback-nested-savepoint", "project-owned-migrations");

          if (dialect === "sqlite") {
            expectedFeatures.push(
              "sqlite-batch-is-atomic",
              "sqlite-client-batch-forms",
              "sqlite-client-batch-rejection",
              "sqlite-transaction-closed-state",
            );
          }

          expectedFeatures.push(
            "raw-sql",
            dialect === "postgresql" ? "sequence" : "auto-increment",
            "validators",
            "deterministic-tools",
          );
          const fullResult = sdkFull;
          assertGuestLogContract({ run: sdkFull, pair, dialect, featureCount: expectedFeatures.length });
          assert.deepEqual(
            getEmittedFeatureNames(fullResult),
            expectedFeatures,
            `${id} ${dialect} completed feature inventory`,
          );
          assertTransactionContract(fullResult, `${id} ${dialect}`);
          const sqlEvents = fullResult.events.filter((event) => event.type === "sql");
          assert.ok(sqlEvents.length >= 20, `${id} ${dialect} must capture generated and executed SQL`);

          if (dialect === "sqlite") {
            for (const result of [sdkFull]) {
              const statements = result.events.filter((event) => event.type === "sql").map((event) => event.payload);
              assert.ok(
                statements.some(
                  (event) =>
                    event.sql === "SELECT ? AS tuple_value" &&
                    event.outcome === "succeeded" &&
                    JSON.stringify(event.parameters) === JSON.stringify([{ type: "primitive", value: 41 }]),
                ),
                `${id} SQLite tuple batch must preserve SQL and positional parameters`,
              );
              assert.ok(
                statements.some(
                  (event) =>
                    event.sql === "INSERT INTO missing_acceptance_table (value) VALUES (?)" &&
                    event.outcome === "failed" &&
                    JSON.stringify(event.parameters) ===
                      JSON.stringify([{ type: "primitive", value: "tuple failure" }]),
                ),
                `${id} SQLite rejected tuple batch must preserve SQL, parameters and failure`,
              );
            }
          }

          if (dialect === "postgresql") {
            assert.ok(
              sqlEvents.some((event) => JSON.stringify(event.payload).includes("acceptance_users_read")),
              "PostgreSQL policy SQL was captured",
            );
            assert.ok(
              fullResult.events.some(
                (event) => event.type === "diagnostic" && event.payload.code === "RLS_NOT_ENFORCED",
              ),
              "RLS is explicitly reported as unenforced",
            );
          }

          const failureManifest = createAcceptanceManifest({ pair, dialect, kind: "failure" });
          const sdkFailure = await runProject({ runtime, manifest: failureManifest });
          assert.equal(sdkFailure.report.outcome, "failed");
          const failureResult = sdkFailure;
          assert.match(failureResult.report.error?.message ?? "", /intentional acceptance failure/);
          assert.equal(failureResult.report.error?.phase, "run");
          const failedQueryManifest = createAcceptanceManifest({ pair, dialect, kind: "failed_query" });
          const failedQueryResult = await runProject({ runtime, manifest: failedQueryManifest });
          assert.equal(failedQueryResult.report.outcome, "failed");
          assert.match(
            failedQueryResult.report.error?.message ?? "",
            /^Failed query: insert into .*\nparams: 1,Grace$/,
            `${id} ${dialect} failed query keeps its params`,
          );
          const recoveryManifest = createAcceptanceManifest({ pair, dialect, kind: "recovery" });
          const sdkRecovery = await runProject({ runtime, manifest: recoveryManifest });
          assert.equal(sdkRecovery.report.outcome, "succeeded");
          const ormManifest = createOrmCorpusManifest(pair, dialect);
          const sdkOrm = await runProject({ runtime, manifest: ormManifest });
          assert.equal(
            sdkOrm.report.outcome,
            "succeeded",
            `${id} ${dialect} SDK ORM corpus: ${JSON.stringify(sdkOrm.report.error ?? "unknown failure")}`,
          );
          const sdkOrmCases = readOrmCaseResults(sdkOrm);
          assert.deepEqual(
            sdkOrmCases.map((result) => result.id),
            getExpectedOrmCaseIds(pair, dialect),
            `${id} ${dialect} ORM corpus must run the scenarios listed in orm-corpus/case-ids.json, in order`,
          );
          const failedOrmCases = sdkOrmCases.filter((result) => !result.ok);
          assert.deepEqual(failedOrmCases, [], `${id} ${dialect} SDK ORM corpus scenarios must succeed`);
          assertOrmCaseResults({ pair, dialect, results: sdkOrmCases });
          const ormCoverage = assertOrmExportCoverage({ pair, dialect, guestDir });
          const ormMethodCoverage = assertOrmMethodCoverage({ pair, dialect, guestDir });
          const ormSummary = `${sdkOrmCases.length} ORM API scenarios over ${sdkOrm.events.filter((event) => event.type === "sql").length} SQL events; ${ormCoverage.covered} exports and ${ormMethodCoverage.covered} builder methods called, ${ormCoverage.excluded + ormMethodCoverage.excluded} internal`;
          const outsideManifest = createAcceptanceManifest({ pair, dialect, kind: "package_outside_schema" });
          const outsideResult = await runProject({ runtime, manifest: outsideManifest });
          assert.equal(
            outsideResult.report.outcome,
            "succeeded",
            `${id} ${dialect} package import outside schema: ${outsideResult.report.error?.message ?? "unknown failure"}`,
          );
          assert.match(JSON.stringify(outsideResult.report.value), /loaded outside schema/);
          const plansManifest = createAcceptanceManifest({ pair, dialect, kind: "query_plans" });
          const plansResult = await runProject({
            runtime,
            manifest: plansManifest,
            queryPlans: { size: "100k", measureRealTime: true } as const,
          });
          assertQueryPlans(plansResult, `${id} ${dialect}`);
          const effectSummary =
            asset.guestFlavor === "effect" ? `; ${await assertEffectScenario({ runtime, pair, dialect })}` : "";
          const row = `PASS ${id} / ${dialect}: ${getSourcePackageInventory(pair).join(", ")}; ${expectedFeatures.length} runtime feature assertions; production QuickJS SDK; ${ormSummary}; failure and recovery; query plans${effectSummary}`;
          rows.push(row);
          console.log(row);
        }
      },
      cleanup: () => runtime.dispose(),
    });
  }

  // A misspelled filter would otherwise pass without running anything.
  assert.ok(
    rows.length > 0,
    `No guest matched DRIZZLE_RUN_ACCEPTANCE_PAIR=${process.env.DRIZZLE_RUN_ACCEPTANCE_PAIR ?? ""} and DRIZZLE_RUN_ACCEPTANCE_DIALECT=${process.env.DRIZZLE_RUN_ACCEPTANCE_DIALECT ?? ""}`,
  );
}

async function assertEffectScenario({
  runtime,
  pair,
  dialect,
}: {
  runtime: Runtime;
  pair: HarnessPair;
  dialect: Dialect;
}) {
  const run = await runProject({ runtime, manifest: createAcceptanceManifest({ pair, dialect, kind: "effect" }) });
  assert.equal(run.report.outcome, "succeeded", JSON.stringify(run.report.error));
  const value = JSON.stringify(run.report.value);
  assert.match(value, /Ada/);
  assert.doesNotMatch(value, /Linus/);
  assert.match(value, /Failure/);
  assert.ok(run.events.some((event) => event.type === "sql" && JSON.stringify(event.payload).includes("effect_users")));
  return "Effect Schema and query API";
}

/** A real guest run planned at 100k: the run's result is untouched and the unindexed foreign key gets its index. */
function assertQueryPlans(run: GateRun, label: string) {
  assert.equal(
    run.report.outcome,
    "succeeded",
    `${label} query plans run: ${run.report.error?.message ?? "unknown failure"}`,
  );
  assert.match(JSON.stringify(run.report.value), /Hello/, `${label} query plans run keeps the run's own result`);
  const plans = run.report.queryPlans;
  assert.ok(plans !== undefined, `${label} reports query plans`);
  assert.equal(plans.error, undefined, `${label} planning failed: ${plans.error?.message}`);
  assert.deepEqual(
    plans.fills.map((fill) => fill.size),
    ["seed", "10k", "100k"],
    `${label} plans at seed, 10k and the chosen size`,
  );
  assert.deepEqual(
    plans.fills[0].tables
      .map((table) => [table.name, table.rows] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
    [
      ["posts", 2],
      ["users", 2],
    ],
    `${label} plans the seed's rows first`,
  );
  assert.equal(plans.queries.length, 2, `${label} plans both run queries and nothing from setup or seed`);
  const [byAuthor, byEmail] = plans.queries;
  assert.match(byAuthor.sql, /author_id/);
  assert.deepEqual(byAuthor.reading?.verdict, { kind: "grows", tables: ["posts"] }, `${label} posts by author grows`);
  assert.deepEqual(
    byAuthor.reading?.indexes.map((index) => index.drizzle),
    ['index("posts_author_idx").on(t.authorId)'],
    `${label} posts by author index`,
  );
  assert.deepEqual(byEmail.reading?.verdict, { kind: "stays_fast" }, `${label} user by email stays fast`);
  assert.deepEqual(byEmail.reading?.indexes, [], `${label} user by email needs no index`);
}

await runMatrix();
