import { serializeValue, type SqlEvent } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  formatConsoleLine,
  formatParams,
  formatStatementDuration,
  getStatementTone,
  summarizeStatements,
  sumRowCounts,
  formatValuePreview,
  toOneLineSql,
} from "./log-format";

const makeStatement = ({ sql, rowCount }: { sql: string; rowCount?: number }): SqlEvent => ({
  sequence: 1,
  phase: "seed",
  origin: "drizzle",
  kind: "executed",
  sql,
  parameters: [],
  outcome: "succeeded",
  ...(rowCount === undefined ? {} : { rowCount }),
});

describe("formatStatementDuration", () => {
  it("should keep one decimal under 10 ms, round above, and switch to seconds past one", () => {
    expect(formatStatementDuration(0.24)).toBe("0.2 ms");
    expect(formatStatementDuration(1.4)).toBe("1.4 ms");
    expect(formatStatementDuration(21.3)).toBe("21 ms");
    expect(formatStatementDuration(1340)).toBe("1.3 s");
  });
});

describe("formatParams", () => {
  it("should quote strings the SQL way and spell other values as JSON", () => {
    expect(formatParams([serializeValue("Ada")])).toBe("$1 = 'Ada'");
    expect(formatParams([serializeValue(0), serializeValue("O'Hara")])).toBe("$1 = 0, $2 = 'O''Hara'");
    expect(formatParams([serializeValue({ tags: ["a"] })])).toBe('$1 = {"tags": ["a"]}');
  });

  it("should say so when there are none", () => {
    expect(formatParams([])).toBe("no params");
  });
});

describe("getStatementTone", () => {
  it("should tell transaction control and rollbacks from queries", () => {
    expect(getStatementTone("begin")).toBe("control");
    expect(getStatementTone("savepoint sp_1")).toBe("control");
    expect(getStatementTone("COMMIT")).toBe("control");
    expect(getStatementTone("rollback to savepoint sp_1")).toBe("rollback");
    expect(getStatementTone('select "id" from "users"')).toBe("query");
  });
});

describe("summarizeStatements", () => {
  it("should name each command once, in order, and add up the rows writes report", () => {
    const statements = [
      makeStatement({ sql: 'CREATE TABLE "accounts" ("id" serial)' }),
      makeStatement({ sql: 'insert into "accounts" values ($1)', rowCount: 1 }),
      makeStatement({ sql: 'insert into "accounts" values ($1)', rowCount: 1 }),
      makeStatement({ sql: "SET search_path TO public" }),
    ];

    expect(summarizeStatements(statements)).toBe("create table, insert 2 rows");
    expect(sumRowCounts(statements)).toBe(2);
  });

  it("should leave out a count no statement reported", () => {
    expect(summarizeStatements([makeStatement({ sql: "insert into t values (1)" })])).toBe("insert");
    expect(sumRowCounts([makeStatement({ sql: "begin" })])).toBeUndefined();
  });
});

describe("toOneLineSql", () => {
  it("should fold the SQL onto one line", () => {
    expect(toOneLineSql('select "id"\n  from "users"\n')).toBe('select "id" from "users"');
  });
});

describe("formatValuePreview", () => {
  it("should preview rows on one line with bare keys and quoted strings", () => {
    const rows = serializeValue([
      { id: 1, title: "Hello, Drizzle", "author-id": 1 },
      { id: 2, tags: [], meta: {} },
    ]);

    expect(formatValuePreview(rows)).toBe(
      '[{ id: 1, title: "Hello, Drizzle", "author-id": 1 }, { id: 2, tags: [], meta: {} }]',
    );
  });

  it("should end in an ellipsis once the preview passes its length", () => {
    const rows = serializeValue(Array.from({ length: 1_000 }, (_, id) => ({ id })));

    expect(formatValuePreview(rows, 20)).toBe("[{ id: 0 }, { id: 1 …");
  });

  it("should not cut a preview that fits exactly", () => {
    expect(formatValuePreview(serializeValue([1, 2]), 6)).toBe("[1, 2]");
  });
});

describe("formatConsoleLine", () => {
  it("should print strings as they are and preview other values, separated by spaces", () => {
    const values = [serializeValue("test"), serializeValue([{ id: 1 }]), serializeValue(2)];

    expect(formatConsoleLine(values)).toBe("test [{ id: 1 }] 2");
  });
});
