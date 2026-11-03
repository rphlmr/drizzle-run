import assert from "node:assert/strict";

import * as z from "zod";

import type { OrmCaseResult } from "../orm-corpus/types.ts";
import type { Dialect, HarnessPair } from "./contract.ts";

type Expectation =
  | null
  | boolean
  | number
  | string
  | readonly Expectation[]
  | {
      readonly [key: string]: Expectation;
    }
  | ((value: unknown) => void);

const ObjectSchema = z.record(z.string(), z.unknown());
const undefinedValue = { $undefined: true };
const names = ["Ada", "Grace", "Linus", "Margaret"];
const groups = [
  { id: 1, name: "Pioneers" },
  { id: 2, name: "Writers" },
];
const posts = [
  { id: 1, authorId: 1, title: "Notes", published: true, views: 100 },
  { id: 2, authorId: 1, title: "Engines", published: false, views: 5 },
  { id: 3, authorId: 2, title: "Compilers", published: true, views: 50 },
  { id: 4, authorId: 3, title: "Kernels", published: true, views: 0 },
];
const categories = [
  { id: 1, parentId: null, name: "Root" },
  { id: 2, parentId: 1, name: "Child" },
  { id: 3, parentId: 2, name: "Grandchild" },
];
const operators = [
  "and",
  "arrayContained",
  "arrayContains",
  "arrayOverlaps",
  "between",
  "eq",
  "exists",
  "gt",
  "gte",
  "ilike",
  "inArray",
  "isNull",
  "isNotNull",
  "like",
  "lt",
  "lte",
  "ne",
  "not",
  "notBetween",
  "notExists",
  "notIlike",
  "notInArray",
  "notLike",
  "or",
  "sql",
].toSorted();
const legacyOperators = operators.filter(
  (name) => !["arrayContained", "arrayContains", "arrayOverlaps"].includes(name),
);

function idRows(...ids: number[]) {
  return ids.map((id) => ({ id }));
}

function nameRows(...values: string[]) {
  return values.map((name) => ({ name }));
}

function createUsers(dialect: Dialect) {
  const profiles = [
    { city: "London", languages: ["en"] },
    { city: "Arlington", languages: ["en", "cobol"] },
    null,
    null,
  ];
  const tags = [["math", "engines"], ["navy", "cobol"], ["kernel"], []];

  return names.map((name, index) => ({
    id: index + 1,
    name,
    email: `${name.toLowerCase()}@example.test`,
    role: ["admin", "writer", "reader", "writer"][index],
    age: [36, 45, 17, null][index],
    ...(dialect === "postgresql" ? { tags: tags[index] } : {}),
    profile: profiles[index],
    joinedAt: dialect === "sqlite" ? { $date: "2024-01-01T00:00:00.000Z" } : "2024-01-01 00:00:00",
  }));
}

function assertMatches(actual: unknown, { expected, path }: { expected: Expectation; path: string }): void {
  if (typeof expected === "function") {
    try {
      expected(actual);
    } catch (cause) {
      throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }

    return;
  }

  if (Array.isArray(expected)) {
    const entries = z.array(z.unknown()).parse(actual);
    assert.equal(entries.length, expected.length, `${path} row count`);

    for (const [index, entry] of expected.entries()) {
      assertMatches(entries[index], { expected: entry, path: `${path}[${index}]` });
    }

    return;
  }

  if (expected !== null && typeof expected === "object") {
    const record = ObjectSchema.parse(actual);
    assert.deepEqual(Object.keys(record).toSorted(), Object.keys(expected).toSorted(), `${path} fields`);

    for (const [key, entry] of Object.entries(expected)) {
      assertMatches(record[key], { expected: entry, path: `${path}.${key}` });
    }

    return;
  }

  assert.deepEqual(actual, expected, path);
}

function sqlQuery({ fragments, params }: { fragments: readonly string[]; params: Expectation }): Expectation {
  return (value) => {
    const query = ObjectSchema.parse(value);
    const sql = z.string().parse(query.sql);

    for (const fragment of fragments) {
      assert.ok(sql.toLowerCase().includes(fragment.toLowerCase()), `SQL must include ${fragment}: ${sql}`);
    }

    assertMatches(query.params, { expected: params, path: "SQL parameters" });
  };
}

function databaseError({
  dialect,
  code,
  message,
  rawCode,
  extendedCode,
}: {
  dialect: Dialect;
  code: string;
  message: RegExp;
  rawCode?: number;
  extendedCode?: string;
}): Expectation {
  return (value) => {
    const captured = ObjectSchema.parse(value);
    assert.deepEqual(Object.keys(captured), ["rejected"], "Expected a rejected database operation");
    let error = ObjectSchema.parse(captured.rejected);
    const chain = [error];

    while (error.cause !== undefined) {
      error = ObjectSchema.parse(error.cause);
      chain.push(error);
    }

    const databaseCause = chain.find((entry) => entry.code === code);
    assert.ok(databaseCause, `Expected ${dialect} database code ${code}, received ${JSON.stringify(chain)}`);
    assert.match(z.string().parse(databaseCause.message), message);
    if (rawCode !== undefined) {
      assert.equal(databaseCause.rawCode, rawCode, "Expected the SQLite extended result code");
    }

    if (extendedCode !== undefined) {
      assert.equal(databaseCause.extendedCode, extendedCode, "Expected the SQLite extended symbolic code");
    }
    assert.ok(chain.every((entry) => typeof entry.name === "string" && typeof entry.message === "string"));
  };
}

function capturedError(message: string): Expectation {
  return (value) => {
    const captured = ObjectSchema.parse(value);
    assert.deepEqual(Object.keys(captured), ["rejected"]);
    const error = ObjectSchema.parse(captured.rejected);
    assert.equal(error.message, message);
    assert.equal(typeof error.name, "string");
  };
}

function commandResult(command: string): Expectation {
  return (value) => {
    const result = ObjectSchema.parse(value);
    assert.equal(result.command, command);
    assert.deepEqual(result.rows, []);
    assert.ok(result.rowCount === null || result.rowCount === 0);
  };
}

function numeric(expected: number): Expectation {
  return (value) => {
    assert.ok(typeof value === "number" || typeof value === "string", `Expected numeric ${expected}`);
    assert.equal(Number(value), expected);
  };
}

function approximate(expected: number): Expectation {
  return (value) => {
    assert.equal(typeof value, "number");
    assert.ok(Math.abs(Number(value) - expected) < 1e-6, `Expected ${expected}, received ${String(value)}`);
  };
}

function createColumnTypeExpectation(dialect: Dialect): Expectation {
  const postgres = dialect === "postgresql";
  const bytes = { $bytes: "00017f80ff" };
  const json = { nested: { list: [1, "two", null] } };
  const decoded: Record<string, Expectation> = postgres
    ? {
        id: 1,
        small: 12,
        regular: 1_234,
        bigNumber: 9_007_199_254_740_991,
        bigExact: { $bigint: "9223372036854775807" },
        smallSerial: 1,
        bigSerial: 1,
        flag: true,
        label: "two",
        shortText: "short",
        fixed: "abc",
        exactString: "1234.50",
        exactNumber: 99.25,
        exactBigint: { $bigint: "123456789012345678901234567890" },
        decimalValue: "1.250",
        realValue: 1.5,
        doubleValue: Math.PI,
        jsonValue: json,
        jsonbValue: { a: 1, b: 2 },
        uuidValue: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        dateString: "2024-02-29",
        dateObject: { $date: "2024-03-01T00:00:00.000Z" },
        timeValue: "12:34:56.789",
        timestampDate: { $date: "2024-01-02T03:04:05.678Z" },
        timestampString: "2024-01-02 03:04:05",
        timestampZone: { $date: "2024-06-30T23:59:59.000Z" },
        intervalValue: "1 day 02:03:04",
        pointTuple: [1.5, -2],
        pointObject: { x: 3, y: 4 },
        lineTuple: [1, -1, 0],
        lineObject: { a: 2, b: 3, c: 4 },
        inetValue: "192.168.10.1/24",
        cidrValue: "10.0.0.0/8",
        macValue: "08:00:2b:01:02:03",
        mac8Value: "08:00:2b:01:02:03:04:05",
        bytes,
        bits: "1010",
        integerList: [3, 1, 2],
        textMatrix: [
          ["a", "b"],
          ["c", "d"],
        ],
        custom: "<mixed>",
      }
    : {
        id: 1,
        regular: 1_234,
        alias: -5,
        flag: true,
        seconds: { $date: "2024-01-02T03:04:05.000Z" },
        milliseconds: { $date: "2024-01-02T03:04:05.678Z" },
        realValue: Math.PI,
        numericString: "1234.5",
        numericNumber: 99.25,
        numericBigint: { $bigint: "9007199254740993" },
        label: "two",
        shortText: "short",
        jsonText: json,
        bytes,
        jsonBlob: { b: 2, a: 1 },
        bigBlob: { $bigint: "9223372036854775807" },
        custom: "<mixed>",
      };
  const raw: Record<string, Expectation> = postgres
    ? {
        ...decoded,
        bigNumber: "9007199254740991",
        bigExact: "9223372036854775807",
        bigSerial: "1",
        exactNumber: "99.25",
        exactBigint: "123456789012345678901234567890",
        dateObject: "2024-03-01",
        timestampDate: "2024-01-02 03:04:05.678",
        timestampZone: (value: unknown) => {
          const timestamp = z.string().parse(value);
          assert.equal(new Date(timestamp).toISOString(), "2024-06-30T23:59:59.000Z");
        },
        pointTuple: { x: 1.5, y: -2 },
        lineTuple: "{1,-1,0}",
        lineObject: "{2,3,4}",
        custom: "mixed",
      }
    : {
        id: 1,
        regular: 1_234,
        flag: 1,
        seconds: 1_704_164_645,
        milliseconds: 1_704_164_645_678,
        numericString: 1234.5,
        jsonText: '{"nested":{"list":[1,"two",null]}}',
        bytes: "00017F80FF",
      };
  const nulls = {
    ...Object.fromEntries(Object.keys(decoded).map((key) => [key, null])),
    id: 2,
    ...(postgres ? { smallSerial: 2, bigSerial: 2 } : {}),
  };

  return { returned: [decoded], selected: [decoded], raw: [raw], nulls: [nulls] };
}

function createGeneratedExpectation(dialect: Dialect): Expectation {
  return {
    generatedRows: [{ id: 1, firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace", nameLength: 3 }],
    inserted: [
      { id: 1, slug: "default-slug", counter: 7, revision: 0, touchedBy: "updater" },
      { id: 2, slug: "explicit", counter: 1, revision: 0, touchedBy: "updater" },
    ],
    updated: [{ id: 1, slug: "changed", counter: 7, revision: 1, touchedBy: "updater" }],
    ...(dialect === "postgresql"
      ? {
          identities: [
            { always: 10, byDefault: 1, note: "first" },
            { always: 15, byDefault: 99, note: "second" },
          ],
          overriding: [{ always: 1, byDefault: 2, note: "override" }],
          identityRejected: databaseError({ dialect, code: "428C9", message: /non-DEFAULT/ }),
        }
      : {}),
  };
}

function createMetadataExpectation(pair: Pick<HarnessPair, "ormApi">, dialect: Dialect): Expectation {
  const postgres = dialect === "postgresql";
  const next = pair.ormApi === "v1";
  const keys = {
    primaryKeys: ["id"],
    foreignKeys: ["corpus_posts_authorId_corpus_users_id_fk"],
    compositePrimaryKeys: ["corpus_users_to_groups_userId_groupId_pk"],
    tableForeignKeys: [["parentId"]],
  };

  return {
    tableName: "corpus_users",
    uniqueName: postgres ? "corpus_scope.items" : next ? "corpus_users" : "public.corpus_users",
    constrained: {
      name: "corpus_constrained",
      columns: [
        ["id", "integer", true],
        ["code", "text", true],
        ["region", "text", true],
        ["quantity", "integer", true],
      ],
      checks: ["corpus_constrained_quantity"],
      indexes: ["corpus_constrained_code_idx", "corpus_constrained_positive_idx"],
      uniqueConstraints: ["corpus_constrained_code_region"],
    },
    ...(postgres
      ? { users: keys, secured: { enableRLS: true, policies: ["corpus_secured_read"] }, scope: "corpus_scope" }
      : keys),
    uniqueKeyName: "corpus_users_email_unique",
    usedTables: ["corpus_users"],
    sameKeys: [true, false],
    isConfig: [true, false],
    ...(next
      ? {
          tableSchema: postgres ? ["corpus_scope", null] : null,
          columnTable: "corpus_posts",
          extended: postgres ? { type: "string", constraint: undefinedValue } : { type: "object", constraint: "json" },
          withEnum: [true, false],
          decoderColumn: "name",
          base64: [1, 2, 255],
        }
      : {}),
  };
}

/** Independent expectations derived from the corpus seed, SQL predicates, schema defaults, and driver contracts. */
export function getOrmExpectations(pair: Pick<HarnessPair, "ormApi">, dialect: Dialect): Record<string, Expectation> {
  const postgres = dialect === "postgresql";
  const next = pair.ormApi === "v1";
  const users = createUsers(dialect);
  const userNames = names.map((name, index) => ({ id: index + 1, name }));
  const unique = databaseError({
    dialect,
    code: postgres ? "23505" : "SQLITE_CONSTRAINT",
    message: /unique|UNIQUE/,
    ...(!postgres ? { rawCode: 2067, extendedCode: "SQLITE_CONSTRAINT_UNIQUE" } : {}),
  });
  const check = databaseError({
    dialect,
    code: postgres ? "23514" : "SQLITE_CONSTRAINT",
    message: /check|CHECK/,
    ...(!postgres ? { rawCode: 275, extendedCode: "SQLITE_CONSTRAINT_CHECK" } : {}),
  });
  const notNull = databaseError({
    dialect,
    code: postgres ? "23502" : "SQLITE_CONSTRAINT",
    message: /null|NULL/,
    ...(!postgres ? { rawCode: 1299, extendedCode: "SQLITE_CONSTRAINT_NOTNULL" } : {}),
  });
  const syntax = databaseError({
    dialect,
    code: postgres ? "42601" : "SQLITE_ERROR",
    message: /syntax/i,
    ...(!postgres ? { rawCode: 1, extendedCode: "SQLITE_ERROR" } : {}),
  });
  const missingTable = databaseError({
    dialect,
    code: postgres ? "42P01" : "SQLITE_ERROR",
    message: /missing_table/,
    ...(!postgres ? { rawCode: 1, extendedCode: "SQLITE_ERROR" } : {}),
  });
  const query = (fragments: string[], params: Expectation) => sqlQuery({ fragments, params });
  const expected: Record<string, Expectation> = {
    "column-type-round-trip": createColumnTypeExpectation(dialect),
    [postgres ? "identity-generated-and-hooks" : "generated-and-hooks"]: createGeneratedExpectation(dialect),
    "table-metadata": createMetadataExpectation(pair, dialect),
    "baseline-seed": users,
    "select-all-and-partial": {
      all: users,
      partial: users.toReversed().map(({ id, name, email, role }) => ({ id, name, nested: { email, role } })),
      spread: posts.map((post) => ({ ...post, authorName: names[post.authorId - 1] })),
      columns: groups,
    },
    "select-sql-fields": names.map((name, index) => ({
      id: index + 1,
      upper: name.toUpperCase(),
      length: name.length,
      literal: 2,
      ...(postgres ? { tagCount: [2, 2, 1, 0][index] } : {}),
    })),
    "select-distinct": postgres
      ? {
          distinct: [{ role: "reader" }, { role: "writer" }, { role: "admin" }],
          distinctOn: [
            { authorId: 1, title: "Notes" },
            { authorId: 2, title: "Compilers" },
            { authorId: 3, title: "Kernels" },
          ],
        }
      : [{ role: "admin" }, { role: "reader" }, { role: "writer" }],
    "where-comparison-operators": {
      eq: [2, 4],
      ne: [1, 3],
      gt: [2],
      gte: [1, 2],
      lt: [3],
      lte: [1, 3],
      columnToColumn: [1, 2, 3, 4],
    },
    "where-logical-null-and-sets": {
      and: [2],
      or: [1, 4],
      not: [1, 3],
      andWithUndefined: [1],
      isNull: [4],
      isNotNull: [1, 2, 3],
      inArray: [1, 3],
      notInArray: [2, 4],
      emptyInArray: [],
      emptyNotInArray: [1, 2, 3, 4],
      inSubquery: [1, 2, 3],
      between: [1, 3],
      notBetween: [2],
    },
    "where-pattern-and-exists": {
      like: [1, 2, 4],
      notLike: [3],
      ...(postgres ? { ilike: [1], notIlike: [2, 3, 4] } : {}),
      exists: [1, 2, 3],
      notExists: [4],
    },
    "order-limit-offset": {
      ordered: (postgres ? [3, 1, 0, 2] : [1, 0, 2, 3]).map((index) => ({
        id: index + 1,
        age: [36, 45, 17, null][index],
      })),
      nullsLast: idRows(3, 1, 2, 4),
      page: idRows(2, 3),
      callbackOrder: userNames.toReversed(),
    },
    "aggregates-group-by-having": {
      totals: [
        {
          authorId: 1,
          posts: 2,
          withTitle: 2,
          distinctPublished: 2,
          averageViews: numeric(52.5),
          averageDistinct: numeric(52.5),
          totalViews: "105",
          distinctViews: "105",
          maxViews: 100,
          minViews: 5,
        },
        {
          authorId: 2,
          posts: 1,
          withTitle: 1,
          distinctPublished: 1,
          averageViews: numeric(50),
          averageDistinct: numeric(50),
          totalViews: "50",
          distinctViews: "50",
          maxViews: 50,
          minViews: 50,
        },
        {
          authorId: 3,
          posts: 1,
          withTitle: 1,
          distinctPublished: 1,
          averageViews: numeric(0),
          averageDistinct: numeric(0),
          totalViews: "0",
          distinctViews: "0",
          maxViews: 0,
          minViews: 0,
        },
      ],
      busyAuthors: [{ authorId: 1 }, { authorId: 2 }],
    },
    joins: {
      left: [
        { user: "Ada", post: "Notes" },
        { user: "Ada", post: "Engines" },
        { user: "Grace", post: "Compilers" },
        { user: "Linus", post: "Kernels" },
        { user: "Margaret", post: null },
      ],
      right: [
        { user: "Grace", comment: "Brilliant" },
        { user: "Linus", comment: "Agreed" },
        { user: "Ada", comment: "Great" },
        { user: null, comment: "Anonymous" },
      ],
      inner: posts.map((post) => ({ corpus_posts: post, corpus_users: users[post.authorId - 1] })),
      full: (postgres ? [1, 2, 3, 4, 0] : [0, 1, 2, 3, 4]).map(
        (index) =>
          [
            { user: null, comment: "Anonymous" },
            { user: "Ada", comment: "Great" },
            { user: "Grace", comment: "Brilliant" },
            { user: "Linus", comment: "Agreed" },
            { user: "Margaret", comment: null },
          ][index],
      ),
      cross: names.flatMap((_, index) => [
        { user: index + 1, group: 1 },
        { user: index + 1, group: 2 },
      ]),
    },
    "aliases-and-self-joins": {
      tree: [
        { child: "Root", parent: null },
        { child: "Child", parent: "Root" },
        { child: "Grandchild", parent: "Child" },
      ],
      fromAliased: nameRows(...names),
      ...(next ? { original: true } : {}),
    },
    subqueries: {
      fromSubquery: [
        { authorId: 1, views: 100 },
        { authorId: 2, views: 50 },
      ],
      scalar: names.map((name, index) => ({ name, latestTitle: ["Engines", "Compilers", "Kernels", null][index] })),
      withSqlAlias: [{ total: postgres ? "4" : 4 }],
    },
    "common-table-expressions": {
      fromCte: [userNames[1], userNames[3]],
      fromRawCte: [{ value: 1 }, { value: 2 }, { value: 3 }],
      ...(postgres
        ? { modifying: { inserted: nameRows("From CTE"), updated: idRows(4), deleted: idRows(4) } }
        : { withUpdate: [{ id: 2, views: 1 }], withDelete: idRows(4) }),
    },
    "set-operations": {
      union: [1, 2, 3],
      unionAll: [1, 1, 1, 2, 2, 3, 3],
      intersect: [1, 2, 3],
      except: [],
      chained: idRows(1, 2),
      ...(postgres ? { intersectAll: [1, 2, 3], exceptAll: [1], chainedAll: idRows(1, 3) } : {}),
    },
    "dynamic-query-building": { all: idRows(1, 2, 3, 4), writers: idRows(2, 4), joined: idRows(4) },
    "count-helper": {
      total: 4,
      writers: 2,
      nested: [2, 1, 1, 0].map((count, index) => ({ id: index + 1, posts: count })),
    },
    "query-cache-opt-in": { defaults: idRows(1, 2, 3, 4), configured: nameRows("Ada"), disabled: idRows(1) },
    "prepared-statements-and-placeholders": {
      first: nameRows("Ada"),
      second: nameRows("Grace"),
      writers: idRows(2),
      inserted: nameRows("Prepared"),
      filled: [1, 2],
      ...(!postgres ? { firstGet: { name: "Ada" }, values: next ? [["Grace"]] : nameRows("Grace") } : {}),
    },
    "sql-template-helpers": {
      joined: [{ id: 1, name: "Ada" }],
      identifiers: nameRows("Grace"),
      raw: [{ three: 3 }],
      fromList: [{ four: postgres ? "4" : 4 }],
      appended: [{ five: 5 }],
      typed: [{ total: postgres ? "4" : 4 }],
      inlined: query(["select 'it''s', 10"], []),
      rendered: query(
        ['select "corpus_users"."id", "corpus_users"."name"', 'from "corpus_users"', 'where "corpus_users"."id" ='],
        [1],
      ),
      isWrapper: [true, !next, false],
      bound: query([postgres ? "$1" : "?"], [5]),
      ...(next ? { commenter: ["/*flag='true',route='corpus'*/", "/*a='1',b='2'*/"] } : {}),
      ...(next && postgres
        ? { commented: { sql: query(["corpus", "attempt", 'from "corpus_users"'], [1]), rows: idRows(1) } }
        : {}),
    },
    "to-sql": {
      select: query(["select", 'from "corpus_users"', 'where "corpus_users"."id" ='], [1]),
      insert: query(
        ['insert into "corpus_users"', 'returning "id"'],
        postgres ? ["To SQL", "to-sql@example.test"] : ["To SQL", "to-sql@example.test", "reader"],
      ),
      update: query(['update "corpus_users"', 'set "age" =', 'where "corpus_users"."id" ='], [1, 1]),
      relational: query(["select", "corpus_users", "corpus_posts", "limit"], [1]),
      embedded: postgres ? [{ total: 4 }] : { total: 4 },
      ...(postgres
        ? { delete: query(['delete from "corpus_users"', "where"], [1]), count: true }
        : {
            updateLimit: query(['update "corpus_users"', "order by", "limit"], [1, 1]),
            deleteLimit: query(['delete from "corpus_users"', "where", "order by", "limit"], [1, 1]),
          }),
    },
    "insert-variants": {
      single: [{ id: postgres ? 5 : 3, name: "Single" }],
      many: nameRows("Many A", "Many B"),
      [postgres ? "rowCount" : "rowsAffected"]: 1,
      fromSelect: [
        { id: 101, name: "Ada" },
        { id: 102, name: "Grace" },
      ],
      fromCallback: idRows(200),
      sqlValue: nameRows("SQL VALUE"),
    },
    "insert-on-conflict": {
      nothing: [],
      nothingTarget: [],
      update: [{ id: 1, name: "Ada Lovelace" }],
      updateWhere: [],
      composite: [{ userId: 1, groupId: 1 }],
    },
    "update-variants": {
      set: [{ id: 1, age: 37, profile: null }],
      expression: [
        { id: 1, views: 200 },
        { id: 3, views: 100 },
        { id: 4, views: 0 },
      ],
      fromJoin: [{ id: 3, title: "Grace: Compilers", ...(postgres ? { author: "Grace" } : {}) }],
      noMatch: [],
      [postgres ? "rowCount" : "rowsAffected"]: 4,
    },
    "delete-variants": {
      returned: [{ body: "Great" }, { body: "Anonymous" }],
      [postgres ? "cascaded" : "removed"]: idRows(3),
      [postgres ? "rowCount" : "rowsAffected"]: 4,
      ...(postgres
        ? {
            nulledComments: [
              { id: 1, authorId: 2 },
              { id: 2, authorId: null },
            ],
            remainingPosts: idRows(1, 2, 3),
          }
        : {}),
    },
    transactions: {
      committed: postgres ? 10 : 4,
      explicitRollback: capturedError("Rollback"),
      thrown: capturedError("corpus failure"),
      ...(!postgres && next ? { exclusive: capturedError("Exclusive transactions are not supported by driver") } : {}),
      names: nameRows("Pioneers", "Writers", "Committed", "Savepoint kept"),
      ...(postgres
        ? {
            readOnly: databaseError({ dialect, code: "25006", message: /read-only/ }),
            setTransaction: [{ isolation: "repeatable read", read_only: "on" }],
          }
        : {}),
    },
    "database-errors": {
      unique,
      check,
      notNull,
      syntax,
      ...(postgres ? { foreignKey: databaseError({ dialect, code: "23503", message: /foreign key/ }) } : {}),
    },
    "relational-find-many": {
      all: users,
      columns: userNames.toReversed(),
      excluded: users
        .slice(1, 3)
        .map((user) =>
          Object.fromEntries(
            Object.entries(user).filter(([key]) => key !== "profile" && key !== (postgres ? "tags" : "joinedAt")),
          ),
        ),
      nested: names.map((name, index) => ({
        name,
        posts: posts
          .filter((post) => post.authorId === index + 1)
          .map((post) => ({
            title: post.title,
            comments: (post.id === 1 ? ["Brilliant", "Agreed"] : post.id === 3 ? ["Great", "Anonymous"] : []).map(
              (body) => ({ body }),
            ),
          })),
      })),
      manyToMany: names.map((name, index) => ({
        name,
        [next ? "groups" : "usersToGroups"]: (index === 0
          ? ["Pioneers"]
          : index === 1
            ? ["Pioneers", "Writers"]
            : index === 3
              ? ["Writers"]
              : []
        ).map((groupName): Expectation => (next ? { name: groupName } : { group: { name: groupName } })),
      })),
      reverseManyToMany: groups.map((group, index) => ({
        ...group,
        [next ? "members" : "usersToGroups"]: (index === 0 ? ["Ada", "Grace"] : ["Grace", "Margaret"]).map(
          (name): Expectation => (next ? { name } : { user: { name } }),
        ),
      })),
      selfReference: categories.map((category, index) => ({
        ...category,
        parent: index === 0 ? null : categories[index - 1],
        children: index === 2 ? [] : [categories[index + 1]],
      })),
      extras: names.map((name, index) => ({ id: index + 1, lowerName: name.toLowerCase() })),
      orderCallback: idRows(1, 3, 2, 4),
      ...(next
        ? {
            aliased: names.map((name, index) => ({
              name,
              publishedPosts: posts
                .filter((post) => post.authorId === index + 1 && post.published)
                .map(({ title }) => ({ title })),
            })),
          }
        : { staticExtras: names.map((name, index) => ({ id: index + 1, upperName: name.toUpperCase() })) }),
    },
    "relational-filters": {
      equals: [2, 4],
      operators: [1, 2],
      or: [1, 4],
      not: [1, 3],
      inList: [2, 3],
      notInList: [1, 4],
      like: [1, 2, 4],
      relation: [1],
      raw: [2, 4],
      nestedWhere: [
        { id: 1, posts: [{ title: "Notes" }] },
        { id: 2, posts: [{ title: "Compilers" }] },
      ],
      ...(next ? { and: [2], relationExists: [1, 2, 3] } : { operatorsHelper: legacyOperators }),
      ...(postgres ? { ilike: [2], arrays: [1, 3] } : {}),
    },
    "relational-find-first-and-prepared": {
      first: { ...users[3], posts: [] },
      missing: undefinedValue,
      preparedFirst: { name: "Grace" },
      preparedSecond: { name: "Linus" },
      oneRequired: { ...posts[2], author: { name: "Grace" } },
      oneOptional: ["Brilliant", "Agreed", "Great", "Anonymous"].map((body, index) => ({
        body,
        author: index === 3 ? null : { name: ["Grace", "Linus", "Ada"][index] },
      })),
    },
    views: {
      builderView: [
        { id: 3, title: "Compilers", authorId: 2 },
        { id: 4, title: "Kernels", authorId: 3 },
      ],
      sqlView: userNames.slice(0, 2),
      name: "corpus_published_posts",
      selected: ["id", "title", "authorId"],
      config: "corpus_published_posts",
      ...(postgres
        ? {
            materialized: [
              { authorId: 1, total: 2 },
              { authorId: 2, total: 1 },
              { authorId: 3, total: 1 },
            ],
            refreshWithNoData: commandResult("REFRESH"),
            unpopulated: databaseError({ dialect, code: "55000", message: /not been populated/ }),
            refreshed: commandResult("REFRESH"),
            refreshedConcurrently: commandResult("REFRESH"),
            afterRefresh: [
              { authorId: 1, total: 2 },
              { authorId: 2, total: 1 },
              { authorId: 3, total: 1 },
            ],
            materializedConfig: "corpus_post_stats",
          }
        : { prefixed: [{ id: 1, name: "prefixed" }] }),
    },
    "database-defaults": postgres
      ? [{ id: 1, createdAtIsTransactionTime: true, tokenVersion: "4" }]
      : [{ id: 1, createdAtIsPositive: 1 }],
    constraints: {
      compositeUnique: unique,
      expressionUnique: unique,
      allowed: idRows(4),
      ...(postgres ? { selfReferenceCascade: [] } : {}),
    },
    replicas: {
      fromReplica: idRows(1, 2, 3, 4),
      fromPrimary: idRows(1, 2),
      relational: groups,
      ...(postgres ? { writeGoesToPrimary: nameRows("Replica write") } : {}),
    },
    "entity-checks": {
      isTable: [true, false],
      isView: [true, false],
      is: [true, true, true, false],
      orderByOperators: ["asc", "desc", "sql"],
      ...(postgres
        ? {
            isPgEnum: [true, false],
            isPgSchema: [true, false],
            isPgSequence: [true, false],
            isPgView: [true, false],
            isPgMaterializedView: [true, false],
          }
        : {}),
      ...(next
        ? {
            isTableAlias: [true, false],
            isNoop: [true, false],
            unreachable: capturedError("Didn't expect to get here"),
            operators,
          }
        : {}),
    },
    [next ? "relations-definition-parts" : "relations-definition"]: next
      ? {
          partTables: ["posts"],
          relationTables: ["categories", "comments", "groups", "posts", "users", "usersToGroups"],
          userRelations: ["comments", "groups", "posts", "publishedPosts"],
        }
      : {
          tables: ["corpus_users", "corpus_posts", "corpus_categories"],
          userRelations: ["comments", "posts", "usersToGroups"],
        },
  };

  if (!postgres) {
    expected["query-execution-modes"] = {
      all: userNames,
      get: userNames[0],
      values: next ? names.map((name, index) => [index + 1, name]) : userNames,
      rawAll: userNames,
      rawGet: { total: 4 },
      rawValues: next ? [[1], [2], [3], [4]] : idRows(1, 2, 3, 4),
      rawRun: { rowsAffected: 2 },
    };
    expected["postgres-only-operators-to-sql"] = {
      ilike: query(["ilike"], ["a%"]),
      notIlike: query(["not ilike"], ["a%"]),
      arrayContains: query(["@>"], next ? [["en"]] : ["en"]),
      arrayContained: query(["<@"], next ? [["en"]] : ["en"]),
      arrayOverlaps: query(["&&"], next ? [["en"]] : ["en"]),
      distances: query(["<->", "<+>", "<#>", "<=>", "<~>", "<%>"], ["[1,2]", "[1,2]", "[1,2]", "[1,2]", "10", "10"]),
    };
    expected.batch = {
      returned: idRows(3),
      selected: nameRows("Pioneers", "Writers", "Batched"),
      updated: 1,
      relational: { id: 3, name: "Batched twice" },
      deleted: nameRows("Batched twice"),
      failed: missingTable,
      atomic: [],
    };
  } else {
    expected["where-array-operators"] = { arrayContains: [1], arrayContained: [2, 3, 4], arrayOverlaps: [2, 3] };
    const lateralRows = [
      { user: "Ada", latest: "Engines" },
      { user: "Grace", latest: "Compilers" },
      { user: "Linus", latest: "Kernels" },
    ];
    expected["lateral-joins"] = {
      leftLateral: [...lateralRows, { user: "Margaret", latest: null }],
      innerLateral: lateralRows,
      crossLateral: lateralRows,
    };
    expected["row-locking"] = {
      forUpdate: idRows(1),
      forShareSkipLocked: idRows(1, 2, 3, 4),
      forNoKeyUpdateNoWait: idRows(2),
      forKeyShareOf: idRows(1),
    };
    expected["enums-schemas-and-sequences"] = {
      enumValues: ["reader", "writer", "admin"],
      enumWithSchema: "corpus_scope",
      scoped: [{ id: 2, status: "closed" }],
      scopedSql: query(['"corpus_scope"."items"'], []),
      counter: [{ value: "1000", next: "1010" }],
      scopedSequence: [{ value: "50" }],
      prefixed: query(['"corpus_prefixed_things"'], []),
      prefixedRows: [{ id: 1, name: "prefixed" }],
      secured: [{ id: 1, owner: "corpus" }],
      enumRejected: databaseError({ dialect, code: "22P02", message: /corpus_role/ }),
    };
    expected["vectors-and-distances"] = {
      rows: [
        { id: 1, embedding: [1, 2, 3], half: [1, 2, 3], sparse: "{1:1,3:2}/5", bits: "1010" },
        { id: 2, embedding: [3, 2, 1], half: [0.5, 0.5, 0.5], sparse: "{2:4}/5", bits: "0110" },
      ],
      distances: [
        {
          id: 1,
          l2: approximate(Math.sqrt(5)),
          l1: 3,
          inner: -6,
          cosine: approximate(1 - 6 / Math.sqrt(42)),
          hamming: 2,
          jaccard: approximate(2 / 3),
        },
        {
          id: 2,
          l2: approximate(Math.sqrt(5)),
          l1: 3,
          inner: -6,
          cosine: approximate(1 - 6 / Math.sqrt(42)),
          hamming: 4,
          jaccard: 1,
        },
      ],
      nearest: idRows(2),
    };
    expected["postgres-array-helpers"] = {
      make: '{"a","b,c",null,"d\\"e"}',
      makeNested: "{{1,2},{3,4}}",
      parse: ["a", "b,c", "NULL"],
      parseNested: [
        [
          [
            ["1", "2"],
            ["3", "4"],
          ],
        ],
        13,
      ],
    };
    expected["unsupported-engine-types-to-sql"] = {
      insert: query(
        ['insert into "corpus_places"', '"location"', '"tupleLocation"', "values ($1, $2, $3)"],
        [1, "point(1 2)", "point(3 4)"],
      ),
      select: query(["select", '"corpus_places"'], []),
    };
  }

  return expected;
}

/** Fail when a resolved ORM scenario returns a wrong result or lacks an independent expectation. */
export function assertOrmCaseResults({
  pair,
  dialect,
  results,
}: {
  pair: Pick<HarnessPair, "ormApi">;
  dialect: Dialect;
  results: readonly OrmCaseResult[];
}): void {
  const expectations = getOrmExpectations(pair, dialect);

  for (const result of results) {
    assert.ok(result.ok, `${dialect} ${result.id}: ${JSON.stringify(result)}`);
    assert.ok(Object.hasOwn(expectations, result.id), `${dialect} ${result.id} has no expected result`);
    assertMatches(result.value, { expected: expectations[result.id], path: `${pair.ormApi} ${dialect} ${result.id}` });
  }
}
