import { describe, expect, it } from "vitest";

import type { SerializedValue } from "../contracts/index.ts";
import { evaluateChecks, sameValues, type CheckedResult } from "./evaluate.ts";
import { safeParseCheckSpec, type CheckSpec } from "./spec.ts";

function makeText(value: string): SerializedValue {
  return { type: "primitive", value };
}

function makeNumber(value: number): SerializedValue {
  return { type: "primitive", value };
}

function makeRow(fields: Record<string, SerializedValue>): SerializedValue {
  return { type: "object", value: fields };
}

function makeRows(...rows: SerializedValue[]): SerializedValue {
  return { type: "array", value: rows };
}

const usersTable = {
  name: "users",
  columns: [
    { name: "id", dataType: "integer", nullable: false },
    { name: "name", dataType: "text", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [],
  indexes: [{ name: "users_name_unique", columns: ["name"], unique: true }],
  checks: [],
};

const postsTable = {
  name: "posts",
  columns: [
    { name: "id", dataType: "integer", nullable: false },
    { name: "author_id", dataType: "integer", nullable: true },
  ],
  primaryKey: ["id"],
  foreignKeys: [{ columns: ["author_id"], referencedTable: "users", referencedColumns: ["id"] }],
  indexes: [{ name: "posts_author_idx", columns: ["author_id"], unique: false }],
  checks: [],
};

const displays = [
  {
    label: "Posts",
    values: [
      makeRows(
        makeRow({ id: makeNumber(1), title: makeText("Hello") }),
        makeRow({ id: makeNumber(2), title: makeText("Again") }),
      ),
    ],
  },
  { label: "Count", values: [makeNumber(2)] },
];

const sqlEvents = [
  {
    sequence: 1,
    phase: "bootstrap" as const,
    origin: "kit" as const,
    kind: "executed" as const,
    sql: "CREATE TABLE posts",
    parameters: [],
    outcome: "succeeded" as const,
  },
  {
    sequence: 2,
    phase: "run" as const,
    origin: "drizzle" as const,
    kind: "executed" as const,
    sql: 'select * from "posts" left join "users"',
    parameters: [],
    outcome: "succeeded" as const,
  },
];

const resultsByDialect: Record<string, CheckedResult> = {
  sqlite: {
    outcome: "succeeded",
    displays,
    sql: sqlEvents,
    database: {
      dialect: "sqlite",
      tables: [usersTable, postsTable].map((table) => ({ ...table, autoIncrement: false })),
      views: [],
    },
  },
  postgresql: {
    outcome: "succeeded",
    displays,
    sql: sqlEvents,
    database: {
      dialect: "postgresql",
      schemas: [
        {
          name: "public",
          tables: [
            usersTable,
            {
              ...postsTable,
              foreignKeys: [{ ...postsTable.foreignKeys[0], referencedTable: "public.users" }],
            },
          ],
          views: [],
          enums: [],
          sequences: [],
        },
      ],
    },
  },
};

function isPassed(
  result: CheckedResult,
  check: CheckSpec,
  expected?: Record<string, readonly SerializedValue[]>,
  files?: Record<string, string>,
): boolean {
  return evaluateChecks(result, [check], { expected, files })[0].passed;
}

describe.each(Object.entries(resultsByDialect))("evaluateChecks on %s", (_dialect, result) => {
  it("should pass noError only when the run succeeded", () => {
    expect(isPassed(result, { type: "noError" })).toBe(true);
    expect(isPassed({ ...result, outcome: "failed" }, { type: "noError" })).toBe(false);
  });

  it("should check table names, column types, and nullability", () => {
    expect(isPassed(result, { type: "table", name: "posts" })).toBe(true);
    expect(isPassed(result, { type: "table", name: "public.posts" })).toBe(true);
    expect(
      isPassed(result, {
        type: "table",
        name: "posts",
        columns: [{ name: "author_id", dataType: "INTEGER", nullable: true }],
      }),
    ).toBe(true);
    expect(isPassed(result, { type: "table", name: "posts", columns: [{ name: "author_id", nullable: false }] })).toBe(
      false,
    );
    expect(isPassed(result, { type: "table", name: "comments" })).toBe(false);
    expect(isPassed({ ...result, database: undefined }, { type: "table", name: "posts" })).toBe(false);
  });

  it("should match foreignKey and index columns in order", () => {
    expect(
      isPassed(result, {
        type: "foreignKey",
        table: "posts",
        columns: ["author_id"],
        references: { table: "users", columns: ["id"] },
      }),
    ).toBe(true);
    expect(
      isPassed(result, {
        type: "foreignKey",
        table: "posts",
        columns: ["id"],
        references: { table: "users", columns: ["id"] },
      }),
    ).toBe(false);
    expect(isPassed(result, { type: "index", table: "users", columns: ["name"], unique: true })).toBe(true);
    expect(isPassed(result, { type: "index", table: "posts", columns: ["author_id"], unique: true })).toBe(false);
    expect(isPassed(result, { type: "index", table: "posts", columns: ["author_id"] })).toBe(true);
  });

  it("should check a display's label, row count, and columns", () => {
    expect(isPassed(result, { type: "display", label: "Posts", rowCount: 2, columns: ["title"] })).toBe(true);
    expect(isPassed(result, { type: "display", label: "Posts", rowCount: 3 })).toBe(false);
    expect(isPassed(result, { type: "display", label: "Posts", columns: ["body"] })).toBe(false);
    expect(isPassed(result, { type: "display", label: "Count", rowCount: 1 })).toBe(true);
    expect(isPassed(result, { type: "display", label: "Missing" })).toBe(false);
  });

  it("should compare matchesSolution with the expected values", () => {
    const expected = {
      Posts: [
        makeRows(
          makeRow({ title: makeText("Again"), id: makeNumber(2) }),
          makeRow({ id: makeNumber(1), title: makeText("Hello") }),
        ),
      ],
    };
    const expectedWithOneRow = { Posts: [makeRows(makeRow({ id: makeNumber(1), title: makeText("Hello") }))] };

    expect(isPassed(result, { type: "matchesSolution", label: "Posts" }, expected)).toBe(true);
    expect(isPassed(result, { type: "matchesSolution", label: "Posts", ordered: true }, expected)).toBe(false);
    expect(isPassed(result, { type: "matchesSolution", label: "Posts" }, expectedWithOneRow)).toBe(false);
    expect(isPassed(result, { type: "matchesSolution", label: "Posts" })).toBe(false);
  });

  it("should read the learner's file for fileContains, case sensitive, and fail without it", () => {
    const files = { "query.ts": "await db.transaction(async (tx) => {});\n" };

    expect(
      isPassed(result, { type: "fileContains", file: "query.ts", contains: "db.transaction(" }, undefined, files),
    ).toBe(true);
    expect(
      isPassed(result, { type: "fileContains", file: "query.ts", contains: "DB.TRANSACTION(" }, undefined, files),
    ).toBe(false);
    expect(isPassed(result, { type: "fileContains", file: "schema.ts", contains: "db" }, undefined, files)).toBe(false);
    expect(isPassed(result, { type: "fileContains", file: "query.ts", contains: "db" })).toBe(false);
  });

  it("should fail a fileContains check on an Object.prototype name instead of throwing", () => {
    const files = { "query.ts": "x" };

    for (const file of ["toString", "constructor", "valueOf", "__proto__"]) {
      expect(isPassed(result, { type: "fileContains", file, contains: "x" }, undefined, files)).toBe(false);
    }
  });

  it("should look at run statements only for sqlExecuted, without regular expressions", () => {
    expect(isPassed(result, { type: "sqlExecuted", contains: "LEFT JOIN" })).toBe(true);
    expect(isPassed(result, { type: "sqlExecuted", contains: "create table" })).toBe(false);
    expect(isPassed(result, { type: "sqlExecuted", contains: "left.*join" })).toBe(false);
  });
});

describe("sameValues", () => {
  it("should ignore listed columns at any depth", () => {
    const actual = [
      makeRows(makeRow({ id: makeNumber(1), createdAt: { type: "date", value: "2026-10-13T00:00:00.000Z" } })),
    ];
    const expected = [
      makeRows(makeRow({ id: makeNumber(1), createdAt: { type: "date", value: "2020-01-01T00:00:00.000Z" } })),
    ];

    expect(sameValues(actual, expected)).toBe(false);
    expect(sameValues(actual, expected, { ignore: ["createdAt"] })).toBe(true);
  });

  it("should tell types apart", () => {
    expect(sameValues([makeNumber(1)], [makeText("1")])).toBe(false);
    expect(sameValues([{ type: "bigint", value: "1" }], [makeText("1")])).toBe(false);
  });
});

describe("safeParseCheckSpec", () => {
  it("should read a fileContains check and report a missing file", () => {
    expect(safeParseCheckSpec({ type: "fileContains", file: "query.ts", contains: "tx." })).toEqual({
      success: true,
      data: { type: "fileContains", file: "query.ts", contains: "tx." },
    });
    expect(safeParseCheckSpec({ type: "fileContains", contains: "tx." })).toMatchObject({
      success: false,
      issues: [{ path: ["file"], code: "INVALID_TYPE" }],
    });
  });

  it("should report a field of the wrong type as INVALID_TYPE, as every other contract does", () => {
    expect(safeParseCheckSpec({ type: "index", table: 3, columns: ["id"] })).toEqual({
      success: false,
      issues: [{ path: ["table"], code: "INVALID_TYPE", message: "Expected non-empty text." }],
    });
  });

  it("should report every problem of a display check, not only its row count", () => {
    const result = safeParseCheckSpec({ type: "display", label: " ", rowCount: -1, columns: [], extra: true });

    expect(!result.success && result.issues.map(({ path, code }) => ({ path, code }))).toEqual(
      expect.arrayContaining([
        { path: ["label"], code: "INVALID_VALUE" },
        { path: ["rowCount"], code: "INVALID_VALUE" },
        { path: ["columns"], code: "INVALID_VALUE" },
        { path: ["extra"], code: "UNKNOWN_FIELD" },
      ]),
    );
  });

  it("should read every check type with its optional fields", () => {
    const checks: CheckSpec[] = [
      { type: "noError" },
      { type: "table", name: "users", columns: [{ name: "id", dataType: "integer", nullable: false }] },
      { type: "foreignKey", table: "posts", columns: ["author_id"], references: { table: "users", columns: ["id"] } },
      { type: "index", table: "users", columns: ["email"], unique: true },
      { type: "display", label: "Users", rowCount: 0, columns: ["id"] },
      { type: "matchesSolution", label: "Users", ordered: true, ignore: ["created_at"] },
      { type: "sqlExecuted", contains: "insert" },
    ];

    for (const check of checks) {
      expect(safeParseCheckSpec(check)).toEqual({ success: true, data: check });
    }

    expect(safeParseCheckSpec({ type: "later", label: "x" })).toMatchObject({
      success: false,
      issues: [{ path: ["type"], code: "UNSUPPORTED_CHECK" }],
    });
    expect(safeParseCheckSpec({ type: 1 })).toMatchObject({ issues: [{ path: ["type"], code: "INVALID_TYPE" }] });
    expect(safeParseCheckSpec([], ["steps", 0])).toMatchObject({
      issues: [{ path: ["steps", 0], code: "INVALID_TYPE" }],
    });
  });

  it("should refuse a fileContains path the project could never hold", () => {
    for (const file of ["./schema.ts", "schema", "../query.ts", "toString", "notes.md"]) {
      expect(safeParseCheckSpec({ type: "fileContains", file, contains: "x" })).toMatchObject({
        success: false,
        issues: [{ path: ["file"], code: "INVALID_VALUE" }],
      });
    }

    expect(safeParseCheckSpec({ type: "fileContains", file: "helpers/users.ts", contains: "x" }).success).toBe(true);
  });
});
