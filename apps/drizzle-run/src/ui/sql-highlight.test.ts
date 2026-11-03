import { describe, expect, it } from "vitest";

import { formatSql, tokenizeSql } from "./sql-highlight";

describe("tokenizeSql", () => {
  it("should classify keywords, strings, identifiers, params, numbers, and comments", () => {
    const tokens = tokenizeSql(`select "name" from users where id = ? and note = 'it''s' limit 10 -- done`).filter(
      (token) => token.kind !== "space",
    );

    expect(tokens.map((token) => [token.kind, token.text])).toEqual([
      ["keyword", "select"],
      ["identifier", `"name"`],
      ["keyword", "from"],
      ["plain", "users"],
      ["keyword", "where"],
      ["plain", "id"],
      ["plain", "="],
      ["param", "?"],
      ["keyword", "and"],
      ["plain", "note"],
      ["plain", "="],
      ["string", `'it''s'`],
      ["keyword", "limit"],
      ["number", "10"],
      ["comment", "-- done"],
    ]);
  });

  it("should round-trip the source text exactly", () => {
    const sql = "CREATE TABLE `users` (\n\t`id` integer PRIMARY KEY NOT NULL\n);";

    expect(
      tokenizeSql(sql)
        .map((token) => token.text)
        .join(""),
    ).toBe(sql);
  });
});

describe("formatSql", () => {
  it("should break a one-line query before its top-level clauses", () => {
    expect(
      formatSql(
        `select "id", "name" from "users" left join "posts" on "posts"."user_id" = "users"."id" where "id" = $1 order by "id" limit $2`,
      ),
    ).toBe(
      [
        `select "id", "name"`,
        `from "users"`,
        `left join "posts" on "posts"."user_id" = "users"."id"`,
        `where "id" = $1`,
        `order by "id"`,
        `limit $2`,
      ].join("\n"),
    );
  });

  it("should leave subqueries, strings, and multi-line SQL alone", () => {
    expect(formatSql(`select * from (select 'from where' from t) as x`)).toBe(
      `select *\nfrom (select 'from where' from t) as x`,
    );
    expect(formatSql("CREATE TABLE `a` (\n\t`id` integer\n);")).toBe("CREATE TABLE `a` (\n\t`id` integer\n);");
  });

  it("should put insert values on their own line", () => {
    expect(formatSql(`insert into "users" ("id", "name") values (?, ?) returning "id"`)).toBe(
      `insert into "users" ("id", "name")\nvalues (?, ?)\nreturning "id"`,
    );
  });
});
