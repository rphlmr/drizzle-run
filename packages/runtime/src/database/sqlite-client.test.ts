import { describe, expect, it } from "vitest";

import { createTestSqliteClient as createSqliteClient } from "../../test/database/engine-fixture.ts";

describe("transient SQLite database", () => {
  it("should expose libSQL error codes for queries, batches, scripts and transactions", async () => {
    const client = await createSqliteClient();

    try {
      const expected = { name: "LibsqlError", code: "SQLITE_ERROR", rawCode: 1 };
      await expect(client.execute("SELECT * FROM missing_table")).rejects.toMatchObject(expected);
      await expect(client.batch(["SELECT * FROM missing_table"])).rejects.toMatchObject(expected);
      await expect(client.executeMultiple("SELECT * FROM missing_table")).rejects.toMatchObject(expected);
      const transaction = await client.transaction();
      await expect(transaction.execute("SELECT * FROM missing_table")).rejects.toMatchObject(expected);
      await expect(transaction.executeMultiple("SELECT * FROM missing_table")).rejects.toMatchObject(expected);
      await transaction.rollback();
      await client.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
      await client.execute("INSERT INTO sample VALUES (1)");
      await expect(client.execute("INSERT INTO sample VALUES (1)")).rejects.toMatchObject({
        code: "SQLITE_CONSTRAINT",
        rawCode: expect.any(Number),
        cause: expect.objectContaining({ name: "SQLite3Error" }),
      });
      const reader = await client.transaction("read");
      await expect(reader.execute("INSERT INTO sample VALUES (2)")).rejects.toMatchObject({
        code: "SQLITE_READONLY",
        rawCode: 8,
      });
      await reader.rollback();
    } finally {
      client.close();
    }
  });

  it("should preserve stored generated columns and JSONB", async () => {
    const client = await createSqliteClient();

    try {
      await client.executeMultiple(
        "CREATE TABLE sample (value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED); INSERT INTO sample(value) VALUES (21)",
      );
      const result = await client.execute({
        sql: "SELECT doubled, json_extract(jsonb(?), '$.value') AS value FROM sample",
        args: ['{"value":42}'],
      });

      expect(result.rows[0]).toMatchObject({ doubled: 42, value: 42 });
    } finally {
      client.close();
    }
  });

  it("should preserve named bindings, declared column types, blobs and 64-bit integers", async () => {
    const client = await createSqliteClient();

    try {
      await client.executeMultiple("CREATE TABLE sample (id INTEGER PRIMARY KEY, title TEXT, payload BLOB)");
      await client.execute({
        sql: "INSERT INTO sample VALUES ($id, :title, @payload)",
        args: { id: 9_007_199_254_740_993n, ":title": "libsql", payload: new Uint8Array([0, 127, 255]) },
      });
      const result = await client.execute("SELECT * FROM sample");

      expect(result.columnTypes).toEqual(["INTEGER", "TEXT", "BLOB"]);
      expect(result.rows[0]?.id).toBe(9_007_199_254_740_993n);
      expect(result.rows[0]?.title).toBe("libsql");
      expect(result.rows[0]?.payload).toEqual(new Uint8Array([0, 127, 255]).buffer);
    } finally {
      client.close();
    }
  });

  it("should isolate uncommitted changes, roll back savepoints and reject writes in read transactions", async () => {
    const client = await createSqliteClient();

    try {
      await client.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
      const transaction = await client.transaction("write");
      await transaction.execute("INSERT INTO sample VALUES (1)");
      expect((await client.execute("SELECT count(*) AS count FROM sample")).rows[0]?.count).toBe(0);

      await transaction.executeMultiple(
        "SAVEPOINT nested; INSERT INTO sample VALUES (2); ROLLBACK TO nested; RELEASE nested",
      );
      await transaction.commit();
      expect((await client.execute("SELECT count(*) AS count FROM sample")).rows[0]?.count).toBe(1);

      const rolledBack = await client.transaction("write");
      await rolledBack.execute("INSERT INTO sample VALUES (3)");
      await rolledBack.rollback();
      const reader = await client.transaction("read");
      await expect(reader.execute("INSERT INTO sample VALUES (4)")).rejects.toThrow(/readonly/);
      await reader.rollback();
      expect((await client.execute("SELECT count(*) AS count FROM sample")).rows[0]?.count).toBe(1);
    } finally {
      client.close();
    }
  });

  it("should roll back a failed batch and expose inspection and query plans", async () => {
    const client = await createSqliteClient();

    try {
      await client.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT)");
      await expect(
        client.batch(["INSERT INTO sample VALUES (1, 'one')", "INSERT INTO sample VALUES (1, 'duplicate')"]),
      ).rejects.toThrow(/UNIQUE constraint/);

      expect((await client.execute("SELECT count(*) AS count FROM sample")).rows[0]?.count).toBe(0);
      expect((await client.execute("PRAGMA table_info(sample)")).rows).toHaveLength(2);
      expect((await client.execute("EXPLAIN QUERY PLAN SELECT * FROM sample WHERE id = 1")).rows[0]?.detail).toContain(
        "PRIMARY KEY",
      );
    } finally {
      client.close();
    }
  });

  it("should discard a closed transaction and isolate separate WASM modules", async () => {
    const first = await createSqliteClient();
    const second = await createSqliteClient();

    try {
      await first.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
      const transaction = await first.transaction("write");
      await transaction.execute("INSERT INTO sample VALUES (1)");
      transaction.close();

      expect((await first.execute("SELECT count(*) AS count FROM sample")).rows[0]?.count).toBe(0);
      await expect(transaction.execute("SELECT 1")).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
      await expect(second.execute("SELECT * FROM sample")).rejects.toThrow(/no such table/);
      first.close();
      await expect(first.execute("SELECT 1")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    } finally {
      first.close();
      second.close();
    }
  });
});
