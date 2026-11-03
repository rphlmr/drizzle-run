import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as z from "zod";

import { describeError } from "../orm-corpus/run-cases.ts";
import { assertOrmCaseResults, getOrmExpectations } from "./orm-expectations.ts";

void describe("ORM acceptance expectations", () => {
  void it("should cover every committed scenario for both APIs and dialects", () => {
    const ids = z
      .record(z.string(), z.array(z.string()))
      .parse(JSON.parse(readFileSync(new URL("../orm-corpus/case-ids.json", import.meta.url), "utf8")));

    for (const ormApi of ["v0", "v1"] as const) {
      for (const dialect of ["postgresql", "sqlite"] as const) {
        const corpus = `${ormApi === "v0" ? "legacy" : "next"}-${dialect}`;
        assert.deepEqual(Object.keys(getOrmExpectations({ ormApi }, dialect)).toSorted(), ids[corpus].toSorted());
      }
    }
  });

  void it("should reject wrong rows and predicates despite ok true", () => {
    for (const [id, value] of [
      [
        "select-sql-fields",
        [
          { id: 1, upper: "wrong", length: 3, literal: 2 },
          { id: 2, upper: "GRACE", length: 5, literal: 2 },
          { id: 3, upper: "LINUS", length: 5, literal: 2 },
          { id: 4, upper: "MARGARET", length: 8, literal: 2 },
        ],
      ],
      [
        "where-comparison-operators",
        { eq: [1], ne: [2, 3], gt: [2], gte: [1, 2], lt: [3], lte: [1, 3], columnToColumn: [1, 2, 3, 4] },
      ],
    ] as const) {
      assert.throws(() =>
        assertOrmCaseResults({
          pair: { ormApi: "v0" },
          dialect: "sqlite",
          results: [{ id, ok: true, value }],
        }),
      );
    }
  });

  void it("should reject a corrupted column codec in an otherwise correct round trip", () => {
    const row = {
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
      jsonText: { nested: { list: [1, "two", null] } },
      bytes: { $bytes: "00017f80ff" },
      jsonBlob: { b: 2, a: 1 },
      bigBlob: { $bigint: "9223372036854775807" },
      custom: "<mixed>",
    };
    const value = {
      returned: [row],
      selected: [row],
      raw: [
        {
          id: 1,
          regular: 1_234,
          flag: 1,
          seconds: 1_704_164_645,
          milliseconds: 1_704_164_645_678,
          numericString: 1234.5,
          jsonText: '{"nested":{"list":[1,"two",null]}}',
          bytes: "00017F80FF",
        },
      ],
      nulls: [{ ...Object.fromEntries(Object.keys(row).map((key) => [key, null])), id: 2 }],
    };
    const check = (observed: unknown) =>
      assertOrmCaseResults({
        pair: { ormApi: "v0" },
        dialect: "sqlite",
        results: [{ id: "column-type-round-trip", ok: true, value: observed }],
      });
    check(value);

    assert.throws(() => check({ ...value, returned: [{ ...row, flag: 1 }] }), /returned\[0\]\.flag/);
  });

  void it("should reject arbitrary errors and require each database violation code and message", () => {
    const rejected = (code: string, message: string) => ({ rejected: { name: "error", code, message } });
    const valid = {
      unique: rejected("23505", "duplicate key violates unique constraint"),
      foreignKey: rejected("23503", "violates foreign key constraint"),
      check: rejected("23514", "violates check constraint"),
      notNull: rejected("23502", "null violates not-null constraint"),
      syntax: rejected("42601", "syntax error"),
    };
    const check = (value: unknown) =>
      assertOrmCaseResults({
        pair: { ormApi: "v1" },
        dialect: "postgresql",
        results: [{ id: "database-errors", ok: true, value }],
      });
    check(valid);

    for (const unique of [
      { rejected: { name: "Error", message: "arbitrary adapter rejection" } },
      { resolved: [] },
      rejected("42601", "syntax error"),
      rejected("23505", "unrelated failure"),
    ]) {
      assert.throws(() => check({ ...valid, unique }));
    }
  });

  void it("should reject a successful constraint write and incorrect SQL parameters", () => {
    assert.throws(() =>
      assertOrmCaseResults({
        pair: { ormApi: "v0" },
        dialect: "sqlite",
        results: [
          {
            id: "constraints",
            ok: true,
            value: { compositeUnique: { resolved: [] }, expressionUnique: { resolved: [] }, allowed: [{ id: 4 }] },
          },
        ],
      }),
    );
    assert.throws(() =>
      assertOrmCaseResults({
        pair: { ormApi: "v1" },
        dialect: "postgresql",
        results: [
          {
            id: "unsupported-engine-types-to-sql",
            ok: true,
            value: {
              insert: {
                sql: 'insert into "corpus_places" ("location", "tupleLocation") values ($1, $2, $3)',
                params: [1, "point(9 9)", "point(3 4)"],
              },
              select: { sql: 'select * from "corpus_places"', params: [] },
            },
          },
        ],
      }),
    );
  });

  void it("should retain and validate SQLite extended result codes through captured errors", () => {
    const reject = ({
      code,
      rawCode,
      extendedCode,
      message,
    }: {
      code: string;
      rawCode: number;
      extendedCode: string;
      message: string;
    }) => ({
      rejected: describeError(Object.assign(new Error(message), { name: "LibsqlError", code, rawCode, extendedCode })),
    });
    const value = {
      unique: reject({
        code: "SQLITE_CONSTRAINT",
        rawCode: 2067,
        extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
        message: "UNIQUE constraint failed: corpus_users.email",
      }),
      check: reject({
        code: "SQLITE_CONSTRAINT",
        rawCode: 275,
        extendedCode: "SQLITE_CONSTRAINT_CHECK",
        message: "CHECK constraint failed: corpus_constrained_quantity",
      }),
      notNull: reject({
        code: "SQLITE_CONSTRAINT",
        rawCode: 1299,
        extendedCode: "SQLITE_CONSTRAINT_NOTNULL",
        message: "NOT NULL constraint failed: corpus_users.email",
      }),
      syntax: reject({ code: "SQLITE_ERROR", rawCode: 1, extendedCode: "SQLITE_ERROR", message: "syntax error" }),
    };
    const check = (observed: unknown) =>
      assertOrmCaseResults({
        pair: { ormApi: "v0" },
        dialect: "sqlite",
        results: [{ id: "database-errors", ok: true, value: observed }],
      });
    check(value);

    assert.throws(
      () =>
        check({
          ...value,
          unique: reject({
            code: "SQLITE_CONSTRAINT",
            rawCode: 1299,
            extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
            message: "UNIQUE constraint failed",
          }),
        }),
      /extended result code/,
    );
    assert.throws(
      () =>
        check({
          ...value,
          unique: reject({
            code: "SQLITE_CONSTRAINT",
            rawCode: 2067,
            extendedCode: "SQLITE_CONSTRAINT_CHECK",
            message: "UNIQUE constraint failed",
          }),
        }),
      /extended symbolic code/,
    );
  });

  void it("should reject unknown scenarios and reported scenario failures", () => {
    assert.throws(
      () =>
        assertOrmCaseResults({
          pair: { ormApi: "v0" },
          dialect: "sqlite",
          results: [{ id: "unknown", ok: true, value: [] }],
        }),
      /no expected result/,
    );
    assert.throws(() =>
      assertOrmCaseResults({
        pair: { ormApi: "v0" },
        dialect: "sqlite",
        results: [{ id: "baseline-seed", ok: false, error: "failed" }],
      }),
    );
  });
});
