import { describe, expect, it, vi } from "vitest";

import { createTestDatabaseEngine as createDatabaseEngine } from "../../test/database/engine-fixture.ts";
import { PlainRecordSchema } from "../schema.ts";
import { decodeDatabaseValue as decode, encodeDatabaseValue as encode } from "./database-codec.ts";
import { serializeDatabaseError } from "./database-engine.js";

describe("database engine", () => {
  it("should retain inspection and reconnect after the guest closes SQLite", async () => {
    const engine = await createDatabaseEngine("sqlite");

    try {
      await engine.call("sqlite.execute", { statement: "CREATE TABLE retained (value INTEGER)" });
      await engine.call("sqlite.execute", { statement: "INSERT INTO retained VALUES (42)" });
      await engine.call("sqlite.multiple", { sql: "BEGIN; INSERT INTO retained VALUES (99)" });
      await engine.call("sqlite.close", {});

      await expect(engine.call("sqlite.execute", { statement: "SELECT * FROM retained" })).rejects.toThrow(
        "SQLite client is closed",
      );
      await expect(engine.call("inspect", undefined)).resolves.toMatchObject({ tables: expect.any(Array) });
      await engine.call("sqlite.reconnect", {});
      await expect(engine.call("sqlite.execute", { statement: "SELECT * FROM retained" })).resolves.toMatchObject({
        rows: [[42]],
      });
    } finally {
      await engine.close();
    }
  });

  it("should inspect composite PostgreSQL foreign keys in binding order", async () => {
    const engine = await createDatabaseEngine("postgresql");

    try {
      await engine.call("plan.exec", {
        sql: "CREATE TABLE parent (a int, b int, PRIMARY KEY(a,b)); CREATE TABLE child (x int, y int, FOREIGN KEY(x,y) REFERENCES parent(a,b))",
      });
      await expect(engine.call("inspect", undefined)).resolves.toMatchObject({
        schemas: expect.arrayContaining([
          expect.objectContaining({
            name: "public",
            tables: expect.arrayContaining([
              expect.objectContaining({
                name: "child",
                foreignKeys: [{ columns: ["x", "y"], referencedTable: "parent", referencedColumns: ["a", "b"] }],
              }),
            ]),
          }),
        ]),
      });
    } finally {
      await engine.close();
    }
  });

  it.each(["COMMIT", "ROLLBACK"])("should report SQLite transaction state after executing %s", async (ending) => {
    const engine = await createDatabaseEngine("sqlite");

    try {
      const transaction = await engine.call("sqlite.begin", { mode: "deferred" });
      const selected = await engine.call("sqlite.execute", { transaction, statement: "SELECT 1" });

      expect(selected).toMatchObject({ closed: false, rows: [[1]] });

      const ended = await engine.call("sqlite.execute", { transaction, statement: ending });

      expect(ended).toMatchObject({ closed: true });
    } finally {
      await engine.close();
    }
  });

  it("should run SQLite statements, tuples, transactions, and inspection against SQLite WASM", async () => {
    const engine = await createDatabaseEngine("sqlite");

    try {
      const created = await engine.call("sqlite.execute", {
        statement:
          "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, count INTEGER NOT NULL)",
      });
      expect(created).toMatchObject({ rowsAffected: 0, columns: [] });

      const inserted = (await engine.call("sqlite.execute", {
        statement: { sql: "INSERT INTO notes (body, count) VALUES (?, ?)", args: ["first", 9007199254740993n] },
      })) as { rowsAffected: number; lastInsertRowid: bigint };
      expect(inserted.rowsAffected).toBe(1);
      expect(inserted.lastInsertRowid).toBe(1n);

      await engine.call("sqlite.batch", {
        mode: "write",
        statements: [
          ["INSERT INTO notes (body, count) VALUES (?, ?)", ["second", 2]],
          { sql: "UPDATE notes SET count = count + ? WHERE id = ?", args: [3, 1] },
        ],
      });

      const transaction = (await engine.call("sqlite.begin", { mode: "deferred" })) as number;
      await engine.call("sqlite.execute", {
        transaction,
        statement: { sql: "INSERT INTO notes (body, count) VALUES (?, ?)", args: ["rolled back", 3] },
      });
      await engine.call("sqlite.rollback", { transaction });

      const result = (await engine.call("sqlite.execute", {
        statement: "SELECT id, body, count FROM notes ORDER BY id",
      })) as { columns: string[]; rows: unknown[][] };
      expect(result.columns).toEqual(["id", "body", "count"]);
      expect(result.rows).toEqual([
        [1, "first", 9007199254740996n],
        [2, "second", 2],
      ]);

      const blob = (await engine.call("sqlite.execute", {
        statement: { sql: "SELECT ? AS payload", args: [new Uint8Array([0, 127, 255])] },
      })) as { rows: unknown[][] };
      expect(blob.rows[0]?.[0]).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(blob.rows[0]?.[0] as ArrayBuffer))).toEqual([0, 127, 255]);

      const description = (await engine.call("inspect", undefined)) as {
        dialect: string;
        tables: Array<{ name: string; primaryKey: string[]; autoIncrement: boolean }>;
      };
      expect(description.dialect).toBe("sqlite");
      expect(description.tables).toContainEqual(
        expect.objectContaining({
          name: "notes",
          primaryKey: ["id"],
          autoIncrement: true,
        }),
      );
    } finally {
      await engine.close();
    }
  });

  it("should roll back a failed SQLite batch and enforce read-only transactions", async () => {
    const engine = await createDatabaseEngine("sqlite");

    try {
      await engine.call("sqlite.execute", {
        statement: "CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      });

      await expect(
        engine.call("sqlite.batch", {
          mode: "write",
          statements: [
            ["INSERT INTO entries (value) VALUES (?)", ["kept out"]],
            "INSERT INTO missing_table VALUES (1)",
          ],
        }),
      ).rejects.toThrow("no such table: missing_table");

      const transaction = (await engine.call("sqlite.begin", { mode: "read" })) as number;
      let readonlyError: unknown;

      try {
        await engine.call("sqlite.execute", {
          transaction,
          statement: "INSERT INTO entries (value) VALUES ('blocked')",
        });
      } catch (cause) {
        readonlyError = cause;
      }

      expect(readonlyError).toBeInstanceOf(Error);
      expect(serializeDatabaseError(readonlyError)).toMatchObject({
        name: "LibsqlError",
        code: "SQLITE_READONLY",
        rawCode: 8,
        message: expect.stringContaining("readonly"),
      });
      await engine.call("sqlite.rollback", { transaction });

      const result = (await engine.call("sqlite.execute", {
        statement: "SELECT COUNT(*) AS count FROM entries",
      })) as { rows: unknown[][] };
      expect(result.rows).toEqual([[0]]);
    } finally {
      await engine.close();
    }
  });

  it("should serve PostgreSQL v3 query results and pgvector through PGlite", async () => {
    const engine = await createDatabaseEngine("postgresql");

    try {
      const startup = (await engine.call("pg.exchange", postgresStartupPacket())) as Uint8Array;
      expect(postgresMessageTypes(startup)).toEqual(["R", "S", "S", "S", "Z"]);

      await engine.call("pg.enable-vector", undefined);
      const query = (await engine.call(
        "pg.exchange",
        postgresQueryPacket("SELECT ARRAY[1, 2] AS values, '[1,2,3]'::vector AS embedding"),
      )) as Uint8Array;
      const rows = postgresDataRows(query);
      expect(rows).toEqual([["{1,2}", "[1,2,3]"]]);
      expect(postgresMessageTypes(query)).toContain("T");
      expect(postgresMessageTypes(query)).toContain("Z");

      await engine.call("pg.exchange", postgresQueryPacket("CREATE TABLE transaction_check (value integer)"));
      await engine.call("pg.exchange", postgresQueryPacket("BEGIN"));
      await engine.call("pg.exchange", postgresQueryPacket("INSERT INTO transaction_check VALUES (1)"));
      await engine.call("pg.exchange", postgresQueryPacket("ROLLBACK"));
      const rolledBack = (await engine.call(
        "pg.exchange",
        postgresQueryPacket("SELECT COUNT(*) FROM transaction_check"),
      )) as Uint8Array;
      expect(postgresDataRows(rolledBack)).toEqual([["0"]]);

      const invalid = (await engine.call(
        "pg.exchange",
        postgresQueryPacket("SELECT * FROM absent_table"),
      )) as Uint8Array;
      expect(postgresMessageTypes(invalid)).toContain("E");
      expect(postgresMessageTypes(invalid)).toContain("Z");

      const description = (await engine.call("inspect", undefined)) as {
        dialect: string;
        schemas: Array<{ name: string }>;
      };
      expect(description.dialect).toBe("postgresql");
      expect(description.schemas.some((schema) => schema.name === "public")).toBe(true);
    } finally {
      await engine.close();
    }
  });

  it("should give each PostgreSQL connection its own startup on the one shared database", async () => {
    const engine = await createDatabaseEngine("postgresql");
    const onSecond = (bytes: Uint8Array) => engine.call("pg.connection-exchange", { connection: 1, bytes });

    try {
      await engine.call("pg.exchange", postgresStartupPacket());
      await engine.call("pg.exchange", postgresQueryPacket("CREATE TABLE shared (value integer)"));
      await engine.call("pg.exchange", postgresQueryPacket("INSERT INTO shared VALUES (7)"));

      const startup = (await onSecond(postgresStartupPacket())) as Uint8Array;
      const rows = (await onSecond(postgresQueryPacket("SELECT value FROM shared"))) as Uint8Array;

      expect(postgresMessageTypes(startup)).toEqual(["R", "S", "S", "S", "Z"]);
      expect(postgresDataRows(rows)).toEqual([["7"]]);

      await onSecond(new Uint8Array([0x58, 0, 0, 0, 4]));
      const reopened = (await onSecond(postgresStartupPacket())) as Uint8Array;

      expect(postgresMessageTypes(reopened)).toEqual(["R", "S", "S", "S", "Z"]);
      await expect(onSecond(new Uint8Array([1]))).resolves.toEqual(new Uint8Array());
      await expect(engine.call("pg.connection-exchange", { connection: 0, bytes: new Uint8Array() })).rejects.toThrow(
        "Invalid PostgreSQL connection exchange",
      );
    } finally {
      await engine.close();
    }
  });

  it("should answer an extended-protocol error with one ReadyForQuery, as a server does", async () => {
    const engine = await createDatabaseEngine("postgresql");
    const onSecond = (bytes: Uint8Array) =>
      engine.call("pg.connection-exchange", { connection: 1, bytes }) as Promise<Uint8Array>;

    try {
      await onSecond(postgresStartupPacket());

      const failed = await onSecond(postgresExtendedCycle("SELECT 1/0"));
      const failedThenSelected = await onSecond(
        concatPackets(postgresExtendedCycle("SELECT 1/0"), postgresExtendedCycle("SELECT 2")),
      );
      const unsynced = await onSecond(postgresExtendedCycle("SELECT 1/0", { sync: false }));
      const synced = await onSecond(postgresPacket("S", new Uint8Array()));

      expect(postgresMessageTypes(failed)).toEqual(["1", "E", "Z"]);
      expect(postgresMessageTypes(failedThenSelected)).toEqual(["1", "E", "Z", "1", "2", "D", "C", "Z"]);
      expect(postgresMessageTypes(unsynced)).toEqual(["1", "E"]);
      expect(postgresMessageTypes(synced)).toEqual(["Z"]);
    } finally {
      await engine.close();
    }
  });

  it("should roll back the transaction of a connection that closes inside it", async () => {
    const engine = await createDatabaseEngine("postgresql");
    const on = (connection: number) => (bytes: Uint8Array) =>
      engine.call("pg.connection-exchange", { connection, bytes }) as Promise<Uint8Array>;

    try {
      await engine.call("pg.exchange", postgresStartupPacket());
      await engine.call("pg.exchange", postgresQueryPacket("CREATE TABLE kept (value integer)"));
      await on(1)(postgresStartupPacket());
      await on(1)(postgresQueryPacket("BEGIN"));
      await on(1)(postgresQueryPacket("INSERT INTO kept VALUES (1)"));
      await on(1)(postgresQueryPacket("SELECT 1/0"));

      const startup = await on(2)(postgresStartupPacket());
      await on(1)(postgresTerminatePacket());
      const counted = (await engine.call(
        "pg.exchange",
        postgresQueryPacket("SELECT COUNT(*) FROM kept"),
      )) as Uint8Array;

      expect(postgresMessageTypes(startup)).toEqual(["R", "S", "S", "S", "Z"]);
      expect(postgresMessageTypes(counted)).not.toContain("E");
      expect(postgresDataRows(counted)).toEqual([["0"]]);
    } finally {
      await engine.close();
    }
  });

  it("should close and roll back a connection that sends an invalid packet", async () => {
    const engine = await createDatabaseEngine("postgresql");
    const on = (connection: number) => (bytes: Uint8Array) =>
      engine.call("pg.connection-exchange", { connection, bytes }) as Promise<Uint8Array>;

    try {
      await engine.call("pg.exchange", postgresStartupPacket());
      await engine.call("pg.exchange", postgresQueryPacket("CREATE TABLE kept (value integer)"));
      await on(1)(postgresStartupPacket());
      await on(1)(postgresQueryPacket("BEGIN"));
      await on(1)(postgresQueryPacket("INSERT INTO kept VALUES (1)"));

      await expect(on(1)(Uint8Array.of(0x51, 0, 0, 0, 2))).rejects.toThrow("Invalid PostgreSQL packet length: 3");
      await expect(on(1)(postgresQueryPacket("SELECT 1"))).rejects.toThrow(TypeError);
      const counted = (await engine.call(
        "pg.exchange",
        postgresQueryPacket("SELECT COUNT(*) FROM kept"),
      )) as Uint8Array;

      expect(postgresMessageTypes(counted).at(-1)).toBe("Z");
      expect(postgresDataRows(counted)).toEqual([["0"]]);
      expect(counted.at(-1)).toBe(0x49);
    } finally {
      await engine.close();
    }
  });

  it.each([
    ["an explicit transaction", ["BEGIN", "INSERT INTO open_cycle VALUES (1)"]],
    ["an implicit transaction", ["INSERT INTO open_cycle VALUES (1)"]],
    ["a failed statement", ["SELEC 1"]],
    ["a failed explicit transaction", ["BEGIN", "INSERT INTO open_cycle VALUES (1)", "SELECT 1/0"]],
  ])("should leave the session idle when a connection closes in a cycle with %s and no Sync", async (_, queries) => {
    const engine = await createDatabaseEngine("postgresql");
    const on = (connection: number) => (bytes: Uint8Array) =>
      engine.call("pg.connection-exchange", { connection, bytes }) as Promise<Uint8Array>;

    try {
      await engine.call("pg.exchange", postgresStartupPacket());
      await engine.call("pg.exchange", postgresQueryPacket("CREATE TABLE open_cycle (value integer)"));
      await on(1)(postgresStartupPacket());
      await on(1)(concatPackets(...queries.map((query) => postgresExtendedCycle(query, { sync: false }))));
      await on(1)(postgresTerminatePacket());
      const counted = (await engine.call(
        "pg.exchange",
        postgresExtendedCycle("SELECT COUNT(*) FROM open_cycle"),
      )) as Uint8Array;

      expect(postgresDataRows(counted)).toEqual([["0"]]);
      expect(counted.at(-1)).toBe(0x49);
    } finally {
      await engine.close();
    }
  });

  it("should answer cancel and SSL requests without keeping their connection", async () => {
    const engine = await createDatabaseEngine("postgresql");
    const on = (connection: number) => (bytes: Uint8Array) =>
      engine.call("pg.connection-exchange", { connection, bytes }) as Promise<Uint8Array>;

    try {
      const cancelled = await on(1)(postgresRequestPacket(80_877_102, new Uint8Array(8)));
      const restarted = await on(1)(postgresStartupPacket());
      const sslAnswer = await on(2)(postgresRequestPacket(80_877_103));
      const sslStartup = await on(2)(postgresStartupPacket());

      expect(cancelled).toEqual(new Uint8Array());
      expect(postgresMessageTypes(restarted)).toEqual(["R", "S", "S", "S", "Z"]);
      expect(sslAnswer).toEqual(Uint8Array.of(0x4e));
      expect(postgresMessageTypes(sslStartup)).toEqual(["R", "S", "S", "S", "Z"]);
      await expect(on(3)(postgresRequestPacket(131_072))).rejects.toThrow(
        "Expected PostgreSQL protocol 3.0, but got 2.0",
      );
    } finally {
      await engine.close();
    }
  });

  it("should stop at a Terminate and cap the open connections", async () => {
    const engine = await createDatabaseEngine("postgresql");
    const on = (connection: number) => (bytes: Uint8Array) =>
      engine.call("pg.connection-exchange", { connection, bytes }) as Promise<Uint8Array>;

    try {
      await engine.call("pg.exchange", postgresStartupPacket());
      await engine.call("pg.exchange", postgresQueryPacket("CREATE TABLE after_terminate (value integer)"));
      await on(1)(postgresStartupPacket());
      await on(1)(
        concatPackets(postgresTerminatePacket(), postgresQueryPacket("INSERT INTO after_terminate VALUES (1)")),
      );
      const counted = (await engine.call(
        "pg.exchange",
        postgresQueryPacket("SELECT COUNT(*) FROM after_terminate"),
      )) as Uint8Array;

      expect(postgresDataRows(counted)).toEqual([["0"]]);

      // Connection 0 is open, so 31 more fill the 32.
      for (let connection = 1; connection <= 31; connection += 1) {
        await on(connection)(postgresStartupPacket());
      }

      await expect(on(32)(postgresStartupPacket())).rejects.toThrow(
        "Cannot open PostgreSQL connection 32: 32 connections are already open",
      );
      await on(31)(postgresTerminatePacket());
      await expect(on(32)(postgresStartupPacket())).resolves.toBeInstanceOf(Uint8Array);
    } finally {
      await engine.close();
    }
  });

  it("should initialize the worker explicitly and serialize database requests", async () => {
    vi.resetModules();
    const worker = createFakeWorkerScope();
    vi.stubGlobal("self", worker.scope);

    try {
      const { serveDatabase } = await import("./database-service.ts");
      serveDatabase(worker.scope);

      const ready = worker.waitForMessage((message) => readField(message, "kind") === "ready");
      worker.dispatch({ kind: "init", dialect: "sqlite" });
      await ready;

      const created = worker.waitForMessage((message) => readField(message, "id") === 1);
      worker.dispatch({
        id: 1,
        operation: "sqlite.execute",
        value: encode({ statement: "CREATE TABLE worker_test (value TEXT)" }),
      });
      expect(decode((await created).value)).toMatchObject({ columns: [], rowsAffected: 0 });

      const rejected = worker.waitForMessage((message) => readField(message, "id") === 2);
      worker.dispatch({ id: 2, operation: "sqlite.execute", value: encode({ statement: "SELECT 1" }) });
      expect(decode((await rejected).value)).toMatchObject({ rows: [[1]] });

      const oversized = worker.waitForMessage((message) => readField(message, "id") === 3);
      worker.dispatch({
        id: 3,
        operation: "sqlite.execute",
        value: encode({ statement: "x".repeat(2 * 1024 * 1024) }),
      });
      expect((await oversized).error).toMatchObject({ name: "RangeError" });

      const unsupported = worker.waitForMessage((message) => readField(message, "id") === 4);
      worker.dispatch({ id: 4, operation: "sqlite.unsupported", value: encode(undefined) });
      expect((await unsupported).error).toMatchObject({ name: "Error" });

      const closed = worker.waitForMessage((message) => readField(message, "id") === 5);
      worker.dispatch({ id: 5, operation: "close", value: encode(undefined) });
      expect(decode((await closed).value)).toBeUndefined();
      expect(worker.closed).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

/** A field of a posted message, or `undefined` when the message is not a plain object. */
function readField(message: unknown, key: string): unknown {
  const record = PlainRecordSchema.safeParse(message);

  return record.success ? record.data[key] : undefined;
}

function createFakeWorkerScope(): {
  scope: DedicatedWorkerGlobalScope;
  dispatch(message: unknown): void;
  waitForMessage(predicate: (message: unknown) => boolean): Promise<Record<string, unknown>>;
  closed: boolean;
} {
  const messages: unknown[] = [];
  const waiters: Array<{
    predicate: (message: unknown) => boolean;
    resolve(message: Record<string, unknown>): void;
  }> = [];
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  let isClosed = false;

  const scope = {
    addEventListener(type: string, callback: EventListenerOrEventListenerObject): void {
      if (type === "message" && typeof callback === "function") {
        listener = callback;
      }
    },
    postMessage(message: unknown): void {
      messages.push(message);

      const record = PlainRecordSchema.safeParse(message);

      for (const [index, waiter] of waiters.entries()) {
        if (waiter.predicate(message) && record.success) {
          waiters.splice(index, 1);
          waiter.resolve(record.data);
          break;
        }
      }
    },
    close(): void {
      isClosed = true;
    },
  } as unknown as DedicatedWorkerGlobalScope;

  return {
    scope,
    dispatch(message) {
      if (listener === undefined) {
        throw new Error("Database worker did not register its message listener");
      }

      listener({ data: message } as MessageEvent<unknown>);
    },
    waitForMessage(predicate) {
      const index = messages.findIndex(predicate);

      if (index !== -1) {
        const [message] = messages.splice(index, 1);
        return Promise.resolve(message as Record<string, unknown>);
      }

      return new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    get closed() {
      return isClosed;
    },
  };
}

function postgresStartupPacket(): Uint8Array {
  const values = ["user", "postgres", "database", "postgres", "client_encoding", "UTF8", ""];
  const parameters = new TextEncoder().encode(`${values.join("\0")}\0`);
  const packet = new Uint8Array(parameters.byteLength + 8);
  const view = new DataView(packet.buffer);
  view.setUint32(0, packet.byteLength, false);
  view.setUint32(4, 196608, false);
  packet.set(parameters, 8);

  return packet;
}

function postgresQueryPacket(query: string): Uint8Array {
  return postgresPacket("Q", new TextEncoder().encode(`${query}\0`));
}

function postgresPacket(type: string, body: Uint8Array): Uint8Array {
  const packet = new Uint8Array(body.byteLength + 5);
  packet[0] = type.charCodeAt(0);
  new DataView(packet.buffer).setUint32(1, body.byteLength + 4, false);
  packet.set(body, 5);

  return packet;
}

function postgresTerminatePacket(): Uint8Array {
  return postgresPacket("X", new Uint8Array());
}

/** A startup-phase request such as CancelRequest or SSLRequest: its length, its code, then its payload. */
function postgresRequestPacket(code: number, payload = new Uint8Array()): Uint8Array {
  const packet = new Uint8Array(payload.byteLength + 8);
  const view = new DataView(packet.buffer);
  view.setUint32(0, packet.byteLength, false);
  view.setUint32(4, code, false);
  packet.set(payload, 8);

  return packet;
}

/** Parse, Bind and Execute of an unnamed statement with no parameters, then Sync unless `sync` is false. */
function postgresExtendedCycle(query: string, { sync = true } = {}): Uint8Array {
  const encoder = new TextEncoder();

  return concatPackets(
    postgresPacket("P", concatPackets(encoder.encode(`\0${query}\0`), new Uint8Array(2))),
    postgresPacket("B", concatPackets(encoder.encode("\0\0"), new Uint8Array(6))),
    postgresPacket("E", concatPackets(encoder.encode("\0"), new Uint8Array(4))),
    ...(sync ? [postgresPacket("S", new Uint8Array())] : []),
  );
}

function concatPackets(...packets: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(packets.reduce((length, packet) => length + packet.byteLength, 0));
  let offset = 0;

  for (const packet of packets) {
    joined.set(packet, offset);
    offset += packet.byteLength;
  }

  return joined;
}

function postgresMessageTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    if (offset + 5 > bytes.byteLength) {
      throw new Error("Truncated PostgreSQL response packet");
    }

    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    types.push(String.fromCharCode(bytes[offset] ?? 0));
    offset += length + 1;
  }

  return types;
}

function postgresDataRows(bytes: Uint8Array): string[][] {
  const rows: string[][] = [];
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset < bytes.byteLength) {
    const type = String.fromCharCode(bytes[offset] ?? 0);
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    const end = offset + length + 1;

    if (type === "D") {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 5, length - 4);
      const count = view.getUint16(0, false);
      const values: string[] = [];
      let cursor = 2;

      for (let index = 0; index < count; index += 1) {
        const valueLength = view.getInt32(cursor, false);
        cursor += 4;
        values.push(
          valueLength === -1
            ? ""
            : decoder.decode(new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 5 + cursor, valueLength)),
        );
        cursor += valueLength === -1 ? 0 : valueLength;
      }

      rows.push(values);
    }

    offset = end;
  }

  return rows;
}
