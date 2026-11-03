import { describe, expect, it, vi } from "vitest";

import { createDatabaseEngine, type DatabaseEngine } from "../database/database-engine.ts";
import { createPostgresSession as createSession } from "./postgres-session.ts";
import {
  decodeBinaryParameter,
  observePostgresWire,
  readUndecodedTypeOid,
  type WireStatement,
} from "./wire-observer.ts";
import type { WireTransport } from "./wire-transport.ts";

function createPostgresSession(
  call: (operation: string, value: unknown) => Promise<unknown>,
  options: Omit<Parameters<typeof createSession>[0], "call"> = {},
) {
  const session = createSession({ call, ...options });

  return { ...session, closeConnections: session.close };
}

describe("createPostgresSession", () => {
  it("should hold the other connections back while one is inside a transaction", async () => {
    await usingEngine(async (engine) => {
      const onWaiting = vi.fn();
      const session = createPostgresSession(callEngine(engine), { onWaiting, waitingNoticeMs: 20 });
      const first = await openConnection(session.connection());
      const second = await openConnection(session.connection());

      await first.query("CREATE TABLE entries (value integer)");
      await first.query("BEGIN");
      await first.query("INSERT INTO entries VALUES (1)");
      const secondInsert = second.query("INSERT INTO entries VALUES (2)");
      await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledWith({ connection: 2, owner: 1 }));

      await first.query("ROLLBACK");
      await secondInsert;

      expect(dataRows(await first.query("SELECT value FROM entries"))).toEqual([["2"]]);
    });
  });

  it("should let the others go on once a connection inside a transaction closes", async () => {
    await usingEngine(async (engine) => {
      const session = createPostgresSession(callEngine(engine));
      const first = await openConnection(session.connection());
      const second = await openConnection(session.connection());
      const third = await openConnection(session.connection());

      await first.query("CREATE TABLE entries (value integer)");
      await first.query("BEGIN");
      await first.query("INSERT INTO entries VALUES (1)");
      const secondInsert = second.query("INSERT INTO entries VALUES (2)");

      first.transport.destroy();
      await secondInsert;
      await third.query("BEGIN");
      await third.query("INSERT INTO entries VALUES (3)");
      await session.closeConnections();

      expect(dataRows(await queryOnHost(engine, "SELECT value FROM entries"))).toEqual([["2"]]);
    });
  });

  it("should give every connection of the session its notifications", async () => {
    await usingEngine(async (engine) => {
      const session = createPostgresSession(callEngine(engine));
      const listener = await openConnection(session.connection());
      const notifier = await openConnection(session.connection());

      await listener.query('LISTEN "Jobs"');
      const notified = await notifier.query("NOTIFY \"Jobs\", 'ready'");

      await vi.waitFor(() => expect(messageTypes(listener.received())).toContain("A"));
      expect(messageTypes(notified)).toEqual(["C", "A", "Z"]);
    });
  });

  it("should let a startup and a cancel request through while another connection holds the session", async () => {
    await usingEngine(async (engine) => {
      const onWaiting = vi.fn();
      const session = createPostgresSession(callEngine(engine), { onWaiting, waitingNoticeMs: 20 });
      const holder = await openConnection(session.connection());
      await holder.query("BEGIN");

      const cancel = session.connection();
      const cancelClosed = new Promise((resolve) => cancel.once("close", resolve));
      cancel.write(startupRequest(80_877_102, new Uint8Array(8)));
      const started = await openConnection(session.connection());
      await cancelClosed;
      await holder.query("COMMIT");
      await started.query("SELECT 1");

      expect(onWaiting).not.toHaveBeenCalled();
    });
  });

  it("should let a Terminate through while another connection holds the session", async () => {
    await usingEngine(async (engine) => {
      const onWaiting = vi.fn();
      const session = createPostgresSession(callEngine(engine), { onWaiting, waitingNoticeMs: 20 });
      const holder = await openConnection(session.connection());
      const closer = await openConnection(session.connection());

      await holder.query("BEGIN");
      await closer.send(packet("X"));
      await holder.query("COMMIT");

      expect(onWaiting).not.toHaveBeenCalled();
    });
  });

  it("should fail the waiting write of a connection that closes while it waits", async () => {
    await usingEngine(async (engine) => {
      const session = createPostgresSession(callEngine(engine));
      const holder = await openConnection(session.connection());
      const waiter = await openConnection(session.connection());

      await holder.query("BEGIN");
      const waiting = waiter.query("SELECT 1");
      waiter.transport.destroy();

      await expect(waiting).rejects.toThrow("PostgreSQL transport is closed");
      await holder.query("COMMIT");
    });
  });

  it("should hold the session for frames still waiting for their Sync", async () => {
    await usingEngine(async (engine) => {
      const onWaiting = vi.fn();
      const session = createPostgresSession(callEngine(engine), { onWaiting, waitingNoticeMs: 20 });
      const first = await openConnection(session.connection());
      const second = await openConnection(session.connection());

      await first.query("CREATE TABLE entries (value integer)");
      await first.send(
        concat(
          packet("Q", cString("SELECT 1")),
          unsyncedStatement("BEGIN"),
          unsyncedStatement("INSERT INTO entries VALUES (1)"),
        ),
      );
      const secondInsert = second.query("INSERT INTO entries VALUES (2)");
      await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledWith({ connection: 2, owner: 1 }));
      await first.send(packet("S"));
      await first.query("ROLLBACK");
      await secondInsert;

      expect(dataRows(await second.query("SELECT value FROM entries"))).toEqual([["2"]]);
    });
  });

  it("should close a connection whose exchange failed, and fail its statements", async () => {
    await usingEngine(async (engine) => {
      let failNextExchange = false;
      const call = async (operation: string, value: unknown) => {
        const reply = await engine.call(operation, value);

        if (failNextExchange) {
          failNextExchange = false;
          throw new RangeError("Database response exceeds 2 MiB");
        }

        return reply;
      };
      const statements: Array<{ sql: string; outcome: string }> = [];
      const session = createPostgresSession(call);
      const first = await openConnection(
        session.connection(
          observePostgresWire({
            onStatement: (statement, outcome) => statements.push({ sql: statement.sql, outcome }),
          }),
        ),
      );
      const second = await openConnection(session.connection());

      await first.query("CREATE TABLE entries (value integer)");
      await first.query("BEGIN");
      failNextExchange = true;
      await expect(first.query("INSERT INTO entries VALUES (1)")).rejects.toThrow("Database response exceeds 2 MiB");
      await second.query("INSERT INTO entries VALUES (2)");

      expect(statements.at(-1)).toEqual({ sql: "INSERT INTO entries VALUES (1)", outcome: "failed" });
      expect(dataRows(await second.query("SELECT value FROM entries"))).toEqual([["2"]]);
    });
  });

  it("should close a connection whose reply is not bytes, so the others stop waiting for its transaction", async () => {
    await usingEngine(async (engine) => {
      let corruptNextReply = false;
      const call = async (operation: string, value: unknown) => {
        const reply = await engine.call(operation, value);

        if (corruptNextReply) {
          corruptNextReply = false;

          return "not bytes";
        }

        return reply;
      };
      const onWaiting = vi.fn();
      const session = createPostgresSession(call, { onWaiting, waitingNoticeMs: 20 });
      const holder = await openConnection(session.connection());
      const other = await openConnection(session.connection());

      await holder.query("CREATE TABLE entries (value integer)");
      await holder.query("BEGIN");
      corruptNextReply = true;
      await expect(holder.query("INSERT INTO entries VALUES (1)")).rejects.toThrow("Invalid PostgreSQL response");
      await other.query("INSERT INTO entries VALUES (2)");

      expect(onWaiting).not.toHaveBeenCalled();
      expect(dataRows(await other.query("SELECT value FROM entries"))).toEqual([["2"]]);
    });
  });

  it("should close a cancel request's connection once the host read it", async () => {
    await usingEngine(async (engine) => {
      const session = createPostgresSession(callEngine(engine));
      const cancel = session.connection();
      const closed = new Promise((resolve) => cancel.once("close", resolve));

      cancel.write(startupRequest(80_877_102, new Uint8Array(8)));

      await expect(closed).resolves.toBeUndefined();
    });
  });
});

describe("observePostgresWire", () => {
  it("should give each statement the sequence onStart returned as it was sent", () => {
    const statements: WireStatement[] = [];
    let sequence = 10;
    const observer = observePostgresWire({
      onStart: () => ++sequence,
      onStatement: (statement) => statements.push(statement),
    });

    observer.sent(startupRequest(196_608, cString("")));
    observer.received(packet("Z", Uint8Array.of(0x49)));
    observer.sent(packet("Q", cString("SELECT 1")));
    sequence = 20;
    observer.received(concat(packet("C", cString("SELECT 1")), packet("Z", Uint8Array.of(0x49))));

    expect(statements.map((statement) => statement.sequence)).toEqual([11]);
  });

  it("should read binary arrays, timestamps, dates, bytea, jsonb and uuid parameters", () => {
    const statements: WireStatement[] = [];
    const observer = observePostgresWire({ onStatement: (statement) => statements.push(statement) });
    const timestamp = Date.UTC(2024, 0, 2, 3, 4, 5, 6);
    const parameters: Array<[number, Uint8Array]> = [
      [1007, int4Array([1, 2])],
      [1184, int64((BigInt(timestamp) - BigInt(Date.UTC(2000, 0, 1))) * 1000n)],
      [1082, int32((Date.UTC(2024, 0, 2) - Date.UTC(2000, 0, 1)) / 86_400_000)],
      [17, Uint8Array.of(0x00, 0xff)],
      [3802, concat(Uint8Array.of(1), new TextEncoder().encode('{"a":1}'))],
      [2950, Uint8Array.from({ length: 16 }, (_, index) => index)],
      [1700, Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0, 0, 7)],
    ];

    observer.sent(startupRequest(196_608, cString("")));
    observer.sent(boundStatement("INSERT INTO t VALUES ($1, $2, $3, $4, $5, $6, $7)", parameters));
    observer.received(concat(packet("Z", Uint8Array.of(0x49))));
    observer.received(
      concat(packet("1"), packet("2"), packet("C", cString("INSERT 0 1")), packet("Z", Uint8Array.of(0x49))),
    );

    const [statement] = statements;
    expect(statement?.tags).toEqual(["INSERT 0 1"]);
    expect(statement?.parameters.slice(0, 6)).toEqual([
      [1, 2],
      new Date(timestamp),
      "2024-01-02",
      "\\x00ff",
      '{"a":1}',
      "00010203-0405-0607-0809-0a0b0c0d0e0f",
    ]);
    expect(readUndecodedTypeOid(statement?.parameters[6])).toBe(1700);
  });

  it("should observe a connection that asked for SSL before its startup", () => {
    const statements: WireStatement[] = [];
    const observer = observePostgresWire({ onStatement: (statement) => statements.push(statement) });

    observer.sent(startupRequest(80_877_103, new Uint8Array()));
    observer.sent(startupRequest(196_608, cString("")));
    observer.received(packet("Z", Uint8Array.of(0x49)));
    observer.sent(packet("Q", cString("SELECT 1")));
    observer.received(concat(packet("C", cString("SELECT 1")), packet("Z", Uint8Array.of(0x49))));

    expect(statements.map((statement) => statement.sql)).toEqual(["SELECT 1"]);
  });

  it("should stop observing, not fail the query, when a statement cannot be reported", () => {
    const onError = vi.fn();
    const cause = new Error("Cannot report the statement");
    const observer = observePostgresWire({
      onStatement: () => {
        throw cause;
      },
      onError,
    });

    observer.sent(startupRequest(196_608, cString("")));
    observer.received(packet("Z", Uint8Array.of(0x49)));
    observer.sent(packet("Q", cString("SELECT 1")));

    expect(() =>
      observer.received(concat(packet("C", cString("SELECT 1")), packet("Z", Uint8Array.of(0x49)))),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(cause);
  });

  it("should floor timestamps before 2000 and leave dates past a JavaScript Date undecoded", () => {
    expect(decodeBinaryParameter(int64(-1n), 1184)).toEqual(new Date(Date.UTC(1999, 11, 31, 23, 59, 59, 999)));
    expect(readUndecodedTypeOid(decodeBinaryParameter(int32(2_000_000_000), 1082))).toBe(1082);
  });

  it("should fail the statements of an exchange the host failed", () => {
    const outcomes: Array<[string, string, unknown]> = [];
    const observer = observePostgresWire({
      onStatement: (statement, outcome, error) => outcomes.push([statement.sql, outcome, error]),
    });
    const cause = new RangeError("Database response exceeds 2 MiB");

    observer.sent(startupRequest(196_608, cString("")));
    observer.sent(boundStatement("SELECT 1", []));
    observer.failed(cause);

    expect(outcomes).toEqual([["SELECT 1", "failed", cause]]);
  });
});

/** A raw wire connection: `query` sends one simple Query and resolves with the reply bytes it pushed. */
interface RawConnection {
  transport: WireTransport;
  send(bytes: Uint8Array): Promise<Uint8Array>;
  query(sql: string): Promise<Uint8Array>;
  received(): Uint8Array;
}

function callEngine(engine: DatabaseEngine): (operation: string, value: unknown) => Promise<unknown> {
  return (operation, value) => engine.call(operation, value);
}

async function usingEngine(test: (engine: DatabaseEngine) => Promise<void>): Promise<void> {
  const engine = await createDatabaseEngine("postgresql");

  try {
    await test(engine);
  } finally {
    await engine.close();
  }
}

async function openConnection(transport: WireTransport): Promise<RawConnection> {
  const chunks: Uint8Array[] = [];
  transport.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  transport.on("error", () => {});

  const send = async (bytes: Uint8Array) => {
    const from = chunks.length;
    await new Promise<void>((resolve, reject) =>
      transport.write(bytes, (cause) => (cause === undefined || cause === null ? resolve() : reject(cause))),
    );

    return concat(...chunks.slice(from));
  };

  await send(startupRequest(196_608, new TextEncoder().encode("user\0postgres\0database\0postgres\0\0")));

  return {
    transport,
    send,
    query: (sql) => send(packet("Q", cString(sql))),
    received: () => concat(...chunks),
  };
}

async function queryOnHost(engine: DatabaseEngine, sql: string): Promise<Uint8Array> {
  await engine.call("pg.exchange", startupRequest(196_608, new TextEncoder().encode("user\0postgres\0\0")));

  return (await engine.call("pg.exchange", packet("Q", cString(sql)))) as Uint8Array;
}

function startupRequest(code: number, payload: Uint8Array): Uint8Array {
  return concat(int32(payload.byteLength + 8), int32(code), payload);
}

function packet(type: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  return concat(Uint8Array.of(type.charCodeAt(0)), int32(body.byteLength + 4), body);
}

/** Parse, Bind (every parameter binary) and Execute of an unnamed statement, then Sync. */
function boundStatement(sql: string, parameters: ReadonlyArray<[number, Uint8Array]>): Uint8Array {
  const parse = concat(cString(""), cString(sql), int16(parameters.length), ...parameters.map(([oid]) => int32(oid)));
  const bind = concat(
    cString(""),
    cString(""),
    int16(1),
    int16(1),
    int16(parameters.length),
    ...parameters.flatMap(([, value]) => [int32(value.byteLength), value]),
    int16(0),
  );

  return concat(packet("P", parse), packet("B", bind), packet("E", concat(cString(""), int32(0))), packet("S"));
}

/** Parse, Bind and Execute of an unnamed statement with no parameters, and no Sync. */
function unsyncedStatement(sql: string): Uint8Array {
  return concat(
    packet("P", concat(cString(""), cString(sql), int16(0))),
    packet("B", concat(cString(""), cString(""), int16(0), int16(0), int16(0))),
    packet("E", concat(cString(""), int32(0))),
  );
}

function int4Array(values: number[]): Uint8Array {
  return concat(
    int32(1),
    int32(0),
    int32(23),
    int32(values.length),
    int32(1),
    ...values.flatMap((value) => [int32(4), int32(value)]),
  );
}

function int16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, value);

  return bytes;
}

function int32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);

  return bytes;
}

function int64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value);

  return bytes;
}

function cString(text: string): Uint8Array {
  return new TextEncoder().encode(`${text}\0`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;

  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }

  return joined;
}

function messageTypes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];

  for (let offset = 0; offset + 5 <= bytes.byteLength; offset += view.getUint32(offset + 1) + 1) {
    types.push(String.fromCharCode(bytes[offset] ?? 0));
  }

  return types;
}

function dataRows(bytes: Uint8Array): string[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: string[][] = [];

  for (let offset = 0; offset + 5 <= bytes.byteLength; offset += view.getUint32(offset + 1) + 1) {
    if (bytes[offset] !== 0x44) {
      continue;
    }

    const values: string[] = [];
    let cursor = offset + 7;

    for (let index = 0; index < view.getUint16(offset + 5); index += 1) {
      const length = view.getInt32(cursor);
      values.push(length < 0 ? "" : new TextDecoder().decode(bytes.subarray(cursor + 4, cursor + 4 + length)));
      cursor += 4 + Math.max(length, 0);
    }

    rows.push(values);
  }

  return rows;
}
