import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteGuestClient } from "../../../../guests/quickjs-sqlite.ts";
import { createTestSqliteClient } from "../../test/database/engine-fixture.ts";
import { GuestResultSet } from "../../test/quickjs/sqlite-guest-fixture.ts";
import { encodeDatabaseValue } from "../database/database-codec.ts";
import { serializeDatabaseError } from "../database/database-engine.ts";

afterEach(() => vi.unstubAllGlobals());

describe("SQLite guest sync", () => {
  it("should preserve SQLite constraint codes through the host reply", async () => {
    const host = await createTestSqliteClient();

    try {
      await host.execute("CREATE TABLE sample (value TEXT UNIQUE)");
      await host.execute("INSERT INTO sample VALUES ('duplicate')");
      vi.stubGlobal("hostDatabaseCall", async () => {
        try {
          await host.execute("INSERT INTO sample VALUES ('duplicate')");
          throw new Error("Expected duplicate insertion to fail");
        } catch (cause) {
          return JSON.stringify({ ok: false, error: serializeDatabaseError(cause) });
        }
      });
      const client = createSqliteGuestClient(GuestResultSet);

      await expect(client.execute("INSERT INTO sample VALUES ('duplicate')")).rejects.toMatchObject({
        name: "LibsqlError",
        code: "SQLITE_CONSTRAINT",
        extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
        rawCode: 2067,
      });
    } finally {
      host.close();
    }
  });

  it.each([undefined, { frames_synced: 0, frame_no: 0 }])(
    "should accept a valid replication result %j",
    async (result) => {
      vi.stubGlobal("hostDatabaseCall", async () => JSON.stringify({ ok: true, value: encodeDatabaseValue(result) }));
      const client = createSqliteGuestClient(GuestResultSet);

      await expect(client.sync()).resolves.toEqual(result);
    },
  );

  it("should reject a malformed replication result", async () => {
    vi.stubGlobal("hostDatabaseCall", async () =>
      JSON.stringify({ ok: true, value: encodeDatabaseValue({ frames_synced: "invalid" }) }),
    );
    const client = createSqliteGuestClient(GuestResultSet);

    await expect(client.sync()).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_type", expected: "number", path: ["frames_synced"] }),
      ]),
    });
  });
});
