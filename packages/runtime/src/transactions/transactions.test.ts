import { describe, expect, it } from "vitest";

import { classifyStatement, toRunTransactions, type WireTransaction } from "./transactions.ts";

function makeWireTransaction(options: Partial<WireTransaction> = {}): WireTransaction {
  return {
    id: 1,
    phase: "run",
    outcome: "committed",
    statements: [],
    durationMs: 3,
    ...options,
  };
}

const locate = (frames: string) => ({ source: "query.ts", line: Number(frames.split(":")[0]) });

describe("classifyStatement", () => {
  it("should read the transaction control statements Drizzle sends", () => {
    expect(
      [
        "begin",
        "BEGIN IMMEDIATE",
        "savepoint sp1",
        "release savepoint sp1",
        "rollback to savepoint sp1",
        "ROLLBACK",
        "commit",
      ].map((sql) => classifyStatement(sql)),
    ).toEqual(["begin", "begin", "savepoint", "release", "rollback_to", "rollback", "commit"]);
  });

  it("should tell writes from reads, including a write inside a with query", () => {
    expect(classifyStatement('update "accounts" set "balance" = $1')).toBe("write");
    expect(classifyStatement('  insert into "users" ("name") values ($1)')).toBe("write");
    expect(classifyStatement('with "moved" as (delete from "accounts" returning *) select * from "moved"')).toBe(
      "write",
    );
    expect(classifyStatement('with "rich" as (select * from "accounts") select * from "rich"')).toBe("read");
    expect(classifyStatement('select "id" from "accounts"')).toBe("read");
  });

  it("should count a write Postgres tagged even when the text hides it", () => {
    expect(classifyStatement('/* move */ update "accounts" set "balance" = $1', ["UPDATE"])).toBe("write");
    expect(classifyStatement('select 1; delete from "accounts"', ["SELECT", "DELETE"])).toBe("write");
    expect(classifyStatement('/* move */ update "accounts" set "balance" = $1')).toBe("read");
  });

  it("should keep a write Postgres reports under the outer select", () => {
    expect(
      classifyStatement('with "moved" as (update "accounts" set "balance" = 0 returning *) select * from "moved"', [
        "SELECT",
      ]),
    ).toBe("write");
    expect(classifyStatement('create table "copy" as select * from "accounts"', ["SELECT"])).toBe("write");
    expect(classifyStatement('select "id" from "accounts"', ["SELECT"])).toBe("read");
  });

  it("should read transaction control from the text, since Postgres tags rollback and rollback to alike", () => {
    expect(classifyStatement("rollback to savepoint sp1", ["ROLLBACK"])).toBe("rollback_to");
    expect(classifyStatement("rollback", ["ROLLBACK"])).toBe("rollback");
  });
});

describe("toRunTransactions", () => {
  it("should keep a committed transaction's writes and undo a rolled back savepoint's", () => {
    const roles = new Map([
      [1, "begin"],
      [2, "write"],
      [3, "savepoint"],
      [4, "write"],
      [5, "rollback_to"],
      [6, "commit"],
    ] as const);

    const transactions = toRunTransactions({
      transactions: [
        makeWireTransaction({ id: 1, frames: "6:1", statements: [1, 2, 6] }),
        makeWireTransaction({
          id: 2,
          parent: 1,
          frames: "12:5",
          outcome: "rolled_back",
          reason: "error",
          error: { name: "Error", message: "Changed our mind", frames: "14:13 12:5" },
          statements: [3, 4, 5],
        }),
      ],
      roles,
      locate,
    });

    expect(transactions).toEqual([
      {
        id: 1,
        phase: "run",
        source: "query.ts",
        line: 6,
        outcome: "committed",
        writes: "kept",
        statements: [
          { sequence: 1, role: "begin" },
          { sequence: 2, role: "write" },
          { sequence: 6, role: "commit" },
        ],
        durationMs: 3,
      },
      {
        id: 2,
        parent: 1,
        phase: "run",
        source: "query.ts",
        line: 12,
        outcome: "rolled_back",
        reason: "error",
        error: { name: "Error", message: "Changed our mind", source: "query.ts", line: 14 },
        writes: "undone",
        statements: [
          { sequence: 3, role: "savepoint" },
          { sequence: 4, role: "write" },
          { sequence: 5, role: "rollback_to" },
        ],
        durationMs: 3,
      },
    ]);
  });

  it("should not keep a released savepoint inside a transaction that rolled back", () => {
    const transactions = toRunTransactions({
      transactions: [
        makeWireTransaction({ id: 1, outcome: "rolled_back", reason: "rollback_call" }),
        makeWireTransaction({ id: 2, parent: 1, outcome: "committed" }),
      ],
      roles: new Map(),
      locate,
    });

    expect(transactions.map((transaction) => transaction.writes)).toEqual(["undone", "undone"]);
  });

  it("should drop a savepoint whose parent is missing, with its own savepoints", () => {
    const transactions = toRunTransactions({
      transactions: [
        makeWireTransaction({ id: 2, parent: 1 }),
        makeWireTransaction({ id: 3, parent: 2 }),
        makeWireTransaction({ id: 4 }),
      ],
      roles: new Map(),
      locate,
    });

    expect(transactions.map((transaction) => transaction.id)).toEqual([4]);
  });

  it("should read a statement whose SQL event was not seen, and leave out a site outside the project", () => {
    const [transaction] = toRunTransactions({
      transactions: [makeWireTransaction({ frames: "9:1", statements: [7] })],
      roles: new Map(),
      locate: () => undefined,
    });

    expect(transaction?.statements).toEqual([{ sequence: 7, role: "read" }]);
    expect(transaction).not.toHaveProperty("source");
  });
});
