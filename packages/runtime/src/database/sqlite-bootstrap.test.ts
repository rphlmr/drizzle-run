import { afterEach, describe, expect, it } from "vitest";

import { initializeTransientSqlite, SqliteClient, withTransientSqliteVfsConfiguration } from "./sqlite-client.ts";

afterEach(() => {
  delete globalThis.sqlite3ApiConfig;
});

describe("transient SQLite bootstrap", () => {
  it("should disable only OPFS VFSes and restore an existing bootstrap configuration", async () => {
    const previousConfiguration = {
      applicationOption: "keep",
      disable: {
        extension: true,
        vfs: {
          custom: true,
          opfs: false,
          "opfs-wl": false,
        },
      },
    };
    globalThis.sqlite3ApiConfig = previousConfiguration;

    await withTransientSqliteVfsConfiguration(async () => {
      const activeConfiguration = globalThis.sqlite3ApiConfig;

      expect(activeConfiguration).toMatchObject({
        applicationOption: "keep",
        disable: {
          extension: true,
          vfs: {
            custom: true,
            opfs: true,
            "opfs-wl": true,
          },
        },
      });
    });

    expect(globalThis.sqlite3ApiConfig).toBe(previousConfiguration);
  });

  it("should restore prior config after an initializer consumes the hook or rejects", async () => {
    const previousConfiguration = { applicationOption: "keep" };
    globalThis.sqlite3ApiConfig = previousConfiguration;
    const failure = new Error("SQLite bootstrap failed");

    await expect(
      withTransientSqliteVfsConfiguration(async () => {
        delete globalThis.sqlite3ApiConfig;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(globalThis.sqlite3ApiConfig).toBe(previousConfiguration);
  });

  it("should not leave a temporary config behind when no prior hook existed", async () => {
    delete globalThis.sqlite3ApiConfig;

    await withTransientSqliteVfsConfiguration(async () => {
      delete globalThis.sqlite3ApiConfig;
    });

    expect(Object.hasOwn(globalThis, "sqlite3ApiConfig")).toBe(false);
  });

  it("should initialize without OPFS VFSes and retain transactions and JSONB", async () => {
    const sqlite = await initializeTransientSqlite();
    const client = new SqliteClient(sqlite, "/playground.sqlite");

    expect(sqlite.capi.sqlite3_vfs_find("opfs")).toBe(0);
    expect(sqlite.capi.sqlite3_vfs_find("opfs-wl")).toBe(0);

    try {
      await client.execute({ sql: "CREATE TABLE sample (id INTEGER PRIMARY KEY)" });

      const transaction = await client.transaction("write");
      await transaction.execute({ sql: "INSERT INTO sample (id) VALUES (1)" });
      await transaction.rollback();

      const count = await client.execute({ sql: "SELECT count(*) FROM sample" });
      const json = await client.execute({
        sql: "SELECT json_extract(jsonb(?), '$.value')",
        args: ['{"value":42}'],
      });

      expect(count.rows[0]?.[0]).toBe(0);
      expect(json.rows[0]?.[0]).toBe(42);
    } finally {
      client.close();
    }
  });
});
