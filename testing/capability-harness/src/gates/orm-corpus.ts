import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import * as z from "zod";

import { parseRunManifest } from "../../../../packages/core/src/manifest/index.ts";
import type { OrmCaseResult } from "../orm-corpus/types.ts";
import type { Dialect, GateRun, HarnessPair } from "./contract.ts";

const corpusDirectory = new URL("../orm-corpus/", import.meta.url);

const corpora = {
  v0: {
    postgresql: { schema: "legacy-postgresql.schema.ts", cases: "legacy-postgresql.ts" },
    sqlite: { schema: "legacy-sqlite.schema.ts", cases: "legacy-sqlite.ts" },
  },
  v1: {
    postgresql: { schema: "next-postgresql.schema.ts", cases: "next-postgresql.ts" },
    sqlite: { schema: "next-sqlite.schema.ts", cases: "next-sqlite.ts" },
  },
};

const sharedFiles = ["run-cases.ts", "types.ts"];
const expectedCaseIds = z
  .record(z.string(), z.array(z.string()))
  .parse(JSON.parse(readFileSync(new URL("case-ids.json", corpusDirectory), "utf8")));
const OrmCaseResultsSchema: z.ZodType<OrmCaseResult[]> = z.array(
  z.discriminatedUnion("ok", [
    z.object({ id: z.string(), ok: z.literal(true), value: z.unknown() }),
    z.object({ id: z.string(), ok: z.literal(false), error: z.unknown() }),
  ]),
);

const runSource = `import { db } from "@drizzle-run/runtime/context";
import { cases } from "./cases.ts";
import { runOrmCases } from "./run-cases.ts";

export default await runOrmCases(db, cases);
`;

/**
 * The entrypoints whose function exports the corpus must call
 *
 * Each export is user API unless `uncoveredExports` names it with the reason it is not.
 */
const coveredEntrypoints = {
  postgresql: { "drizzle-orm": "orm", "drizzle-orm/pg-core": "pg" },
  sqlite: { "drizzle-orm": "orm", "drizzle-orm/sqlite-core": "sqlite" },
};

const undeclared = "runtime export without a type declaration, so user code cannot import it";
const dialectInternal = "dialect and driver internal, run by every query the corpus executes";
const relationsInternal = "relational query internal, run by every db.query call the corpus executes";
const codecInternal = "column codec internal, run by every value the corpus writes and reads";
const cacheInternal = "query cache internal; the playground runs no cache";

const uncoveredExports: Record<HarnessPair["ormApi"], Record<string, Readonly<Record<string, string>>>> = {
  v0: {
    "drizzle-orm": {
      applyMixins: undeclared,
      getColumnNameAndConfig: undeclared,
      getTableLikeName: undeclared,
      mapResultRow: undeclared,
      mapUpdateSet: undeclared,
      orderSelectedFields: undeclared,
      mapColumnsInAliasedSQLToAlias: dialectInternal,
      mapColumnsInSQLToAlias: dialectInternal,
      isDriverValueEncoder: dialectInternal,
      createMany: relationsInternal,
      createOne: relationsInternal,
      extractTablesRelationalConfig: relationsInternal,
      mapRelationalRow: relationsInternal,
      normalizeRelation: relationsInternal,
      aliasedRelation: relationsInternal,
    },
    "drizzle-orm/pg-core": {
      pgEnumObjectWithSchema: undeclared,
      pgEnumWithSchema: undeclared,
      pgMaterializedViewWithSchema: undeclared,
      pgSequenceWithSchema: undeclared,
      pgTableWithSchema: undeclared,
      pgViewWithSchema: undeclared,
    },
    "drizzle-orm/sqlite-core": {},
  },
  v1: {
    "drizzle-orm": {
      applyMixins: undeclared,
      fieldSelectionToSQL: undeclared,
      getColumnNameAndConfig: undeclared,
      getTableLikeName: undeclared,
      jitCompatCheck: undeclared,
      mapUpdateSet: undeclared,
      orderSelectedFields: undeclared,
      collectChunksUsedTables: undeclared,
      getLegacyTableUniqueName: undeclared,
      relationalQueryCacheConfig: undeclared,
      relationalQueryCacheMetadata: undeclared,
      relationalQueryUsedTablesInit: undeclared,
      relationalQueryWhereToSQL: undeclared,
      resolveNullableObjectPaths: undeclared,
      unqualifyColumns: undeclared,
      mapColumnsInAliasedSQLToAlias: dialectInternal,
      mapColumnsInSQLToAlias: dialectInternal,
      isDriverValueEncoder: dialectInternal,
      make$ReturningResponseMapper: dialectInternal,
      makeDefaultQueryMapper: dialectInternal,
      makeJitQueryMapper: dialectInternal,
      aliasedTableSQL: dialectInternal,
      chunkKindOf: dialectInternal,
      entityKindsOf: dialectInternal,
      isChunk: dialectInternal,
      memoizeEscape: dialectInternal,
      pgHexToUint8Array: codecInternal,
      getCacheKey: cacheInternal,
      mapRelationalRowFromArrays: relationsInternal,
      makeDefaultRqbMapper: relationsInternal,
      makeJitRqbMapper: relationsInternal,
      buildRelations: relationsInternal,
      buildRelationsParts: relationsInternal,
      createRelationsHelper: relationsInternal,
      extractTablesFromSchema: relationsInternal,
      getTableAsAliasSQL: relationsInternal,
      mapRelationalRow: relationsInternal,
      processRelations: relationsInternal,
      relationExtrasToSQL: relationsInternal,
      relationToSQL: relationsInternal,
      relationsFilterToSQL: relationsInternal,
      relationsOrderToSQL: relationsInternal,
      aliasedRelation: relationsInternal,
      buildRqbColumn: relationsInternal,
      buildRqbColumns: relationsInternal,
      collectSubqueryAndUsedTables: relationsInternal,
      parseRelationsOrderValue: relationsInternal,
      relationsOrderEntriesToSQL: relationsInternal,
    },
    "drizzle-orm/pg-core": {
      pgEnumObjectWithSchema: undeclared,
      pgEnumWithSchema: undeclared,
      pgMaterializedViewWithCasing: undeclared,
      pgMaterializedViewWithSchema: undeclared,
      pgSequenceWithSchema: undeclared,
      pgTableWithCasing: undeclared,
      pgTableWithSchema: undeclared,
      pgViewWithCasing: undeclared,
      pgViewWithSchema: undeclared,
      migrate: "the node-postgres migrator wraps it; the acceptance project runs that migrator",
      arrayCompatCast: codecInternal,
      arrayCompatNormalize: codecInternal,
      arrayCompatNormalizeInput: codecInternal,
      byteaFromPgHex: codecInternal,
      castToText: codecInternal,
      castToTextArr: codecInternal,
      makeBoxArray: codecInternal,
      makeGeometryArray: codecInternal,
      parseGeometryArrayAndNormalize: codecInternal,
      parseGeometryTuple: codecInternal,
      parseGeometryXY: codecInternal,
      parseLineABC: codecInternal,
      parseLineTuple: codecInternal,
      parsePgArrayAndNormalize: codecInternal,
      parsePgVector: codecInternal,
      parsePointTuple: codecInternal,
      parsePointXY: codecInternal,
      refineGenericPgCodecs: codecInternal,
      resolvePgTypeAlias: codecInternal,
      textToDate: codecInternal,
      textToDateWithTz: codecInternal,
    },
    "drizzle-orm/sqlite-core": {
      sqliteTableBase: undeclared,
      sqliteTableWithCasing: undeclared,
      sqliteViewWithCasing: undeclared,
      migrateAsync: "the libsql migrator wraps it; the acceptance project runs that migrator",
      migrateSync: "synchronous drivers only; the playground's libsql client is asynchronous",
      booleanFromInteger: codecInternal,
      bufferFromBinary: codecInternal,
      bufferFromBinaryIfAvailable: codecInternal,
      bufferFromBytes: codecInternal,
      bufferFromBytesIfAvailable: codecInternal,
      bufferFromHex: codecInternal,
      bytesFromUtf8: codecInternal,
      castToHex: codecInternal,
      castToText: codecInternal,
      dateFromMilliseconds: codecInternal,
      dateFromSeconds: codecInternal,
      dateFromStoredMilliseconds: codecInternal,
      dateFromStoredSeconds: codecInternal,
      refineSqliteCodecs: codecInternal,
      resolveSQLiteTypeAlias: codecInternal,
      resolveUnionType: codecInternal,
    },
  },
};

function readCorpusFile(name: string) {
  return readFileSync(new URL(name, corpusDirectory), "utf8");
}

/**
 * Create the playground project that runs one release's ORM API corpus
 *
 * The corpus files import the real specifiers and are typechecked against each guest's own install
 * (`scripts/typecheck-corpus.ts`), so the guest compiles them exactly like user code and resolves every package
 * through its deps bundle.
 */
export function createOrmCorpusManifest(pair: HarnessPair, dialect: Dialect) {
  const corpus = corpora[pair.ormApi];
  const files = corpus[dialect];
  const cases = readCorpusFile(files.cases).replaceAll(`"./${files.schema}"`, '"./schema.ts"');

  return parseRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect },
    guestFlavor: pair.guestFlavor,
    dependencies: {
      "drizzle-orm": pair.ormVersion,
      "drizzle-kit": pair.kitVersion,
    },
    files: {
      "schema.ts": readCorpusFile(files.schema),
      "cases.ts": cases,
      ...Object.fromEntries(sharedFiles.map((name) => [name, readCorpusFile(name)])),
      "run.ts": runSource,
    },
    entrypoints: { schema: "schema.ts", run: "run.ts" },
  });
}

/**
 * Get the scenario ids one release's corpus must run, in order, from the committed `case-ids.json`
 *
 * The coverage checks only scan the source, so a scenario dropped by mistake would otherwise shrink the gate.
 */
export function getExpectedOrmCaseIds(pair: HarnessPair, dialect: Dialect) {
  const corpusName = corpora[pair.ormApi][dialect].cases.replace(/\.ts$/, "");
  const caseIds = expectedCaseIds[corpusName];
  assert.ok(Array.isArray(caseIds), `orm-corpus/case-ids.json has no scenario ids for ${corpusName}`);

  return caseIds;
}

/** Read the per-scenario outcomes an ORM corpus run reported as JSON text. */
export function readOrmCaseResults(run: GateRun): OrmCaseResult[] {
  const value = run.report.value;
  assert.ok(
    value.type === "primitive" && typeof value.value === "string",
    "The ORM corpus run must return its JSON report",
  );

  return OrmCaseResultsSchema.parse(JSON.parse(value.value));
}

function readCorpusSource(pair: HarnessPair, dialect: Dialect) {
  const files = corpora[pair.ormApi][dialect];

  return [files.schema, files.cases].map((name) => readFileSync(new URL(name, corpusDirectory), "utf8")).join("\n");
}

/**
 * Check that the corpus calls every user-facing function export of the guest's packages
 *
 * Reads the exports from the guest's own node_modules, so a release bump that adds an API fails here until the
 * corpus covers it or `uncoveredExports` records why it is not user API.
 */
export function assertOrmExportCoverage({
  pair,
  dialect,
  guestDir,
}: {
  pair: HarnessPair;
  dialect: Dialect;
  guestDir: string;
}) {
  const source = readCorpusSource(pair, dialect);
  const guestRequire = createRequire(join(guestDir, "package.json"));
  const missing = [];
  let covered = 0;
  let excluded = 0;

  for (const [specifier, namespace] of Object.entries(coveredEntrypoints[dialect])) {
    const exports = z.record(z.string(), z.unknown()).parse(guestRequire(specifier));
    const reasons = uncoveredExports[pair.ormApi][specifier];
    const used = new Set(
      [...source.matchAll(new RegExp(`\\b${namespace}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))].map((match) => match[1]),
    );

    for (const name of Object.keys(exports).toSorted()) {
      if (typeof exports[name] !== "function" || /^[A-Z]/.test(name)) {
        continue;
      }

      if (used.has(name)) {
        covered += 1;
      } else if (reasons[name] !== undefined) {
        excluded += 1;
      } else {
        missing.push(`${specifier}#${name}`);
      }
    }

    for (const name of Object.keys(reasons)) {
      assert.ok(name in exports, `${pair.id} ${specifier} no longer exports ${name}; remove it from uncoveredExports`);
      assert.ok(
        !used.has(name),
        `${pair.id} ${dialect} corpus calls ${specifier}#${name}; remove it from uncoveredExports`,
      );
    }
  }

  assert.deepEqual(
    missing,
    [],
    `${pair.id} ${dialect} ORM corpus must call these exports or record why they are not user API`,
  );

  return { covered, excluded };
}

const dialectPackages = {
  postgresql: {
    core: "drizzle-orm/pg-core",
    driver: "drizzle-orm/node-postgres",
    columnBuilder: "PgColumnBuilder",
    transaction: { v0: "PgTransaction", v1: "PgAsyncTransaction" },
  },
  sqlite: {
    core: "drizzle-orm/sqlite-core",
    driver: "drizzle-orm/libsql/web",
    columnBuilder: "SQLiteColumnBuilder",
    transaction: { v0: "SQLiteTransaction", v1: "SQLiteAsyncTransaction" },
  },
};

const underscored = "underscore-prefixed internal";
const notDeclared = "runtime method without a type declaration, so user code cannot call it";
const protectedMember = "protected in the type declarations";
const columnBuild = "a table builds its columns; only some SQLite integer builders leak it into their declarations";
const neonToken = "Neon HTTP auth token, used only by the neon-http driver";

// The Promise protocol every awaited query runs; kept out of `uncoveredMethods` so no object there is thenable.
const promiseProtocolMethods = new Set(["then", "catch", "finally"]);

/**
 * Builder methods the corpus does not call, with the reason each one is not user API
 *
 * `shared` names must exist in both dialects; a dialect entry only in that dialect.
 */
const uncoveredMethods: Record<HarnessPair["ormApi"], Record<"shared" | Dialect, Readonly<Record<string, string>>>> = {
  v0: {
    shared: {
      _prepare: underscored,
      _toSQL: underscored,
      addSetOperators: notDeclared,
      buildForeignKeys: notDeclared,
      getSelectedFields: notDeclared,
      getUsedTables: notDeclared,
      setName: notDeclared,
      createJoin: protectedMember,
      createSetOperator: protectedMember,
      build: columnBuild,
    },
    postgresql: {
      _getQuery: underscored,
      buildExtraConfigColumn: notDeclared,
      getTransactionConfigSQL: notDeclared,
      getTableLikeFields: protectedMember,
      setToken: neonToken,
    },
    sqlite: {
      executeRaw: notDeclared,
    },
  },
  v1: {
    shared: {
      _prepare: underscored,
      _getQuery: underscored,
      _toSQL: underscored,
      addSetOperators: notDeclared,
      buildForeignKeys: notDeclared,
      getSelectedFields: notDeclared,
      getUsedTables: notDeclared,
      setName: notDeclared,
      builder: protectedMember,
      createJoin: protectedMember,
      createSetOperator: protectedMember,
      build: columnBuild,
    },
    postgresql: {
      _resolveSelection: underscored,
      buildExtraConfigColumn: notDeclared,
      getTransactionConfigChunks: notDeclared,
      getTransactionConfigSQL: notDeclared,
      setTransactionSnapshotSQL: notDeclared,
      getTableLikeFields: protectedMember,
    },
    sqlite: {},
  },
};

/** List the function-valued properties of an object and its prototype chain, without running getters. */
function listMethodNames(target: unknown) {
  const names = new Set<string>();

  for (let object = target; object !== null && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) {
      if (name !== "constructor" && typeof Object.getOwnPropertyDescriptor(object, name)?.value === "function") {
        names.add(name);
      }
    }
  }

  return names;
}

function getProperty(target: unknown, name: string): unknown {
  assert.ok(
    (typeof target === "object" && target !== null) || typeof target === "function",
    `Expected an object with property ${name}`,
  );

  return Reflect.get(target, name);
}

function callMethod({ target, name, args = [] }: { target: unknown; name: string; args?: unknown[] }): unknown {
  const method = getProperty(target, name);
  assert.ok(typeof method === "function", `Expected method ${name}`);

  return Reflect.apply(method, target, args);
}

/**
 * Create one of each builder user code reaches from `db`, from a mock database of the guest's own packages
 *
 * Joins, set operators, `$with`, and column builder aliases (`$default`) are instance properties, so they come from
 * instances; transactions and column builder subclasses come from their prototypes.
 */
function createUserBuilders({
  pair,
  dialect,
  guestRequire,
}: {
  pair: HarnessPair;
  dialect: Dialect;
  guestRequire: NodeJS.Require;
}) {
  const packages = dialectPackages[dialect];
  const orm: unknown = guestRequire("drizzle-orm");
  const core = z.record(z.string(), z.unknown()).parse(guestRequire(packages.core));
  const drizzle = getProperty(guestRequire(packages.driver), "drizzle");
  const id = callMethod({ target: callMethod({ target: core, name: "integer", args: ["id"] }), name: "primaryKey" });
  const table =
    dialect === "postgresql"
      ? callMethod({ target: core, name: "pgTable", args: ["coverage", { id }] })
      : callMethod({ target: core, name: "sqliteTable", args: ["coverage", { id }] });
  const db = callMethod({
    target: drizzle,
    name: "mock",
    args: [
      pair.ormApi === "v0"
        ? { schema: { table } }
        : { relations: callMethod({ target: orm, name: "defineRelations", args: [{ table }] }) },
    ],
  });
  const transaction = core[packages.transaction[pair.ormApi]];
  const columnBuilder = core[packages.columnBuilder];
  assert.ok(
    typeof transaction === "function",
    `${pair.id} ${packages.core} must export ${packages.transaction[pair.ormApi]}`,
  );
  assert.ok(typeof columnBuilder === "function", `${pair.id} ${packages.core} must export ${packages.columnBuilder}`);

  const builders: Record<string, unknown> = {
    database: db,
    transaction: getProperty(transaction, "prototype"),
    selectBuilder: callMethod({ target: db, name: "select" }),
    select: callMethod({ target: callMethod({ target: db, name: "select" }), name: "from", args: [table] }),
    insertBuilder: callMethod({ target: db, name: "insert", args: [table] }),
    insert: callMethod({
      target: callMethod({ target: db, name: "insert", args: [table] }),
      name: "values",
      args: [{ id: 1 }],
    }),
    updateBuilder: callMethod({ target: db, name: "update", args: [table] }),
    update: callMethod({
      target: callMethod({ target: db, name: "update", args: [table] }),
      name: "set",
      args: [{ id: 1 }],
    }),
    delete: callMethod({ target: db, name: "delete", args: [table] }),
    relationalQueryBuilder: getProperty(getProperty(db, "query"), "table"),
    relationalQuery: callMethod({ target: getProperty(getProperty(db, "query"), "table"), name: "findMany" }),
    columnBuilder: callMethod({ target: core, name: "integer" }),
  };

  if (dialect === "postgresql") {
    const view = callMethod({
      target: callMethod({ target: core, name: "pgMaterializedView", args: ["coverage_view"] }),
      name: "as",
      args: [
        (qb: unknown) =>
          callMethod({ target: callMethod({ target: qb, name: "select" }), name: "from", args: [table] }),
      ],
    });
    builders.refreshMaterializedView = callMethod({ target: db, name: "refreshMaterializedView", args: [view] });
  }

  for (const [name, value] of Object.entries(core)) {
    if (
      typeof value === "function" &&
      (value === columnBuilder || getProperty(value, "prototype") instanceof columnBuilder)
    ) {
      builders[name] = getProperty(value, "prototype");
    }
  }

  return builders;
}

function escapeRegExp(text: string) {
  return text.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&");
}

/**
 * Check that the corpus calls every public method of the builders user code reaches
 *
 * Lists the methods of the database, transaction, select, insert, update, delete, relational query, refresh
 * (PostgreSQL), and column builders of the guest's own packages. Each one must appear in the corpus as `.name(` or
 * `.name<`, or be listed in `uncoveredMethods` with the reason it is not user API, so a release that adds a builder
 * method fails here until the corpus covers it.
 */
export function assertOrmMethodCoverage({
  pair,
  dialect,
  guestDir,
}: {
  pair: HarnessPair;
  dialect: Dialect;
  guestDir: string;
}) {
  const source = readCorpusSource(pair, dialect);
  const guestRequire = createRequire(join(guestDir, "package.json"));
  const reasons = { ...uncoveredMethods[pair.ormApi].shared, ...uncoveredMethods[pair.ormApi][dialect] };
  const owners = new Map<string, string[]>();

  for (const [builder, target] of Object.entries(createUserBuilders({ pair, dialect, guestRequire }))) {
    for (const name of listMethodNames(target)) {
      owners.set(name, [...(owners.get(name) ?? []), builder]);
    }
  }

  const isCalled = (name: string) => new RegExp(`\\.\\s*${escapeRegExp(name)}\\s*[(<]`).test(source);
  const missing = [];
  let covered = 0;
  let excluded = 0;

  for (const [name, builders] of [...owners.entries()].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (promiseProtocolMethods.has(name)) {
      continue;
    }

    if (isCalled(name)) {
      covered += 1;
    } else if (reasons[name] !== undefined) {
      excluded += 1;
    } else {
      missing.push(`${name} (${builders.join(", ")})`);
    }
  }

  for (const name of Object.keys(reasons)) {
    assert.ok(
      owners.has(name),
      `${pair.id} ${dialect} builders no longer have ${name}; remove it from uncoveredMethods`,
    );
    assert.ok(!isCalled(name), `${pair.id} ${dialect} corpus calls .${name}(; remove it from uncoveredMethods`);
  }

  assert.deepEqual(
    missing,
    [],
    `${pair.id} ${dialect} ORM corpus must call these builder methods or record why they are not user API`,
  );

  return { covered, excluded };
}
