import { serializeValue, type SqlEvent } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { countQueries, getStatementKind, getStatementParams, groupFooterStatements } from "./result-sql";

function makeStatement(sql: string, parameters: unknown[] = [], sequence = 1): SqlEvent {
  return {
    sequence,
    phase: "run",
    origin: "drizzle",
    kind: "executed",
    sql,
    parameters: parameters.map((value) => serializeValue(value)),
    outcome: "succeeded",
  };
}

describe("getStatementKind", () => {
  it("should tell transaction control apart from queries", () => {
    expect(getStatementKind("begin")).toBe("begin");
    expect(getStatementKind("START TRANSACTION")).toBe("begin");
    expect(getStatementKind("commit")).toBe("commit");
    expect(getStatementKind("rollback")).toBe("rollback");
    expect(getStatementKind("rollback to savepoint sp1")).toBe("savepoint");
    expect(getStatementKind("savepoint sp1")).toBe("savepoint");
    expect(getStatementKind('insert into "users" ("id") values ($1)')).toBe("query");
  });
});

describe("groupFooterStatements", () => {
  it("should frame a committed batch and number only its queries", () => {
    const groups = groupFooterStatements([
      makeStatement("begin", [], 1),
      makeStatement('insert into "users" ("id", "name") values ($1, $2)', [2, "Grace"], 2),
      makeStatement('insert into "posts" ("id", "authorId", "title") values ($1, $2, $3)', [2, 2, "A draft"], 3),
      makeStatement("commit", [], 4),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.transaction).toEqual({ outcome: "committed" });
    expect(groups[0]?.statements.map((entry) => [entry.kind, entry.number])).toEqual([
      ["begin", undefined],
      ["query", 1],
      ["query", 2],
      ["commit", undefined],
    ]);
  });

  it("should keep loose queries outside a rolled back transaction", () => {
    const groups = groupFooterStatements([
      makeStatement('select * from "users"', [], 1),
      makeStatement("begin", [], 2),
      makeStatement('insert into "users" ("id") values ($1)', [1], 3),
      makeStatement("rollback", [], 4),
    ]);

    expect(groups.map((group) => group.transaction?.outcome)).toEqual([undefined, "rolled_back"]);
    expect(groups[1]?.statements[1]?.number).toBe(2);
  });
});

describe("countQueries", () => {
  it("should leave transaction control out of the count", () => {
    expect(countQueries([makeStatement("begin"), makeStatement("select 1"), makeStatement("commit")])).toBe(1);
  });
});

describe("getStatementParams", () => {
  it("should pair each value with its own PostgreSQL placeholder", () => {
    const params = getStatementParams(makeStatement('insert into "users" values ($1, $2)', [2, "Grace"]));

    expect(params.map((param) => param.label)).toEqual(["$1", "$2"]);
    expect(params[1]?.value).toEqual(serializeValue("Grace"));
  });

  it("should number SQLite positional params", () => {
    expect(getStatementParams(makeStatement("select ? as a, ? as b", [1, 2])).map((param) => param.label)).toEqual([
      "?1",
      "?2",
    ]);
  });

  it("should keep SQLite named params", () => {
    const statement = { ...makeStatement("select :id"), namedParameters: { id: serializeValue(1) } };

    expect(getStatementParams(statement).map((param) => param.label)).toEqual([":id"]);
  });
});
