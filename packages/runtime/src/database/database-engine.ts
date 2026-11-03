import type { Dialect } from "@drizzle-run/core/catalog";
import type {
  DatabaseColumnDescription,
  DatabaseForeignKeyDescription,
  DatabaseIndexDescription,
  DatabaseTableDescription,
  DatabaseViewDescription,
  PostgresDatabaseDescription,
  PostgresSchemaDescription,
  SqliteDatabaseDescription,
  SqliteTableDescription,
} from "@drizzle-run/core/contracts";
import type { InStatement, InValue } from "@libsql/client";
import { sumBy } from "es-toolkit";
import * as z from "zod/mini";

import type { SqliteClient, SqliteTransaction } from "./sqlite-client.ts";

/** The database a run targets */
export type DatabaseDialect = Dialect;

/** A database the guest drives through named operations, such as `pg.query` or `sqlite.execute` */
export interface DatabaseEngine {
  call(operation: string, value: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** A database error in a form that crosses the worker boundary, keeping its driver codes */
export interface SerializedDatabaseError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  rawCode?: string | number;
  extendedCode?: string;
}

const MAX_DATABASE_MESSAGE_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_POSTGRES_CONNECTIONS = 32;
const POSTGRES_PROTOCOL_3_0 = 196_608;
const POSTGRES_CANCEL_REQUEST = 80_877_102;
const POSTGRES_SSL_REQUEST = 80_877_103;
const POSTGRES_GSSENC_REQUEST = 80_877_104;
const POSTGRES_QUERY = 0x51; // "Q"
const POSTGRES_SYNC = 0x53; // "S"
const POSTGRES_TERMINATE = 0x58; // "X"
const POSTGRES_READY_FOR_QUERY = 0x5a; // "Z"
// Parse, Bind and Execute of an unnamed ROLLBACK, then Sync: the frames that end a closed connection's open cycle.
const POSTGRES_ROLLBACK_CYCLE = concatBytes(
  postgresPacket("P", new TextEncoder().encode("\0ROLLBACK\0\0\0")),
  postgresPacket("B", new Uint8Array(8)),
  postgresPacket("E", new Uint8Array(5)),
  postgresPacket("S", new Uint8Array()),
);

/**
 * The wire state of one PostgreSQL connection
 *
 * `startup` until its startup packet arrives, then `ready`. `transactionStatus` is the status byte of the last
 * ReadyForQuery it was sent: `I` idle, `T` in a transaction, `E` in a failed transaction. `cycleOpen` is true while
 * frames it sent wait for their Sync, which holds the session in an implicit transaction (or, after an error, makes
 * it skip every frame until a Sync).
 */
type PostgresWireConnection =
  | { phase: "startup"; input: Uint8Array }
  | { phase: "ready"; input: Uint8Array; transactionStatus: PostgresTransactionStatus; cycleOpen: boolean };

type PostgresTransactionStatus = "I" | "T" | "E";

/** A frame on a connection the guest opened besides its `pg` client's; 0 is that client's own. */
const PostgresConnectionExchangeSchema = z.object({
  connection: z.number().check(z.int(), z.positive()),
  bytes: z.instanceof(Uint8Array),
});

const PostgresPlanQuerySchema = z.object({ sql: z.string(), params: z.optional(z.array(z.unknown())) });

const SqlTextRequestSchema = z.object({ sql: z.string() });

// z.number() refuses NaN and the infinities, which SQLite cannot bind.
const SqlValueSchema = z.union([
  z.null(),
  z.string(),
  z.boolean(),
  z.bigint(),
  z.number(),
  z.date(),
  z.instanceof(ArrayBuffer),
  z.instanceof(Uint8Array),
]);

/** One statement: its SQL text alone, or with positional or named arguments. */
const SqlStatementSchema = z.union([
  z.string(),
  z.pipe(
    z.object({
      sql: z.string(),
      args: z.optional(z.union([z.array(SqlValueSchema), z.record(z.string(), SqlValueSchema)])),
    }),
    z.transform(({ sql, args }): InStatement => ({ sql, args: args ?? [] })),
  ),
]);

/** A batch statement: a statement, or the `[sql, args?]` tuple only `sqlite.batch` takes. */
const SqlBatchStatementSchema = z.union([
  SqlStatementSchema,
  z.pipe(
    z.tuple([z.string(), z.optional(z.array(SqlValueSchema))]),
    z.transform(([sql, args]): [string, InValue[]?] => (args === undefined ? [sql] : [sql, args])),
  ),
]);

const TransactionModeSchema = z.enum(["read", "write", "deferred"]);

const SqliteStatementRequestSchema = z.object({ statement: SqlStatementSchema });

const SqlitePlanTimeSchema = z.object({
  statement: SqlStatementSchema,
  rollback: z.boolean(),
  budgetMs: z.number(),
  maxSamples: z.number(),
});

const TransactionSelectionSchema = z.object({ transaction: z.optional(z.number()) });

const TransactionModeRequestSchema = z.object({ mode: z.optional(TransactionModeSchema) });

const SqliteBatchRequestSchema = z.object({
  statements: z.array(SqlBatchStatementSchema),
  mode: z.optional(TransactionModeSchema),
});

const SqliteMigrateRequestSchema = z.object({ statements: z.array(SqlStatementSchema) });

/**
 * Create a database engine
 *
 * Opens an in-memory PGlite (with `pgvector`) or SQLite database. `call` throws on an unsupported operation or a
 * malformed request.
 */
export async function createDatabaseEngine(
  dialect: DatabaseDialect,
  options: { databaseTemplate?: Blob } = {},
): Promise<DatabaseEngine> {
  const { databaseTemplate } = options;
  if (dialect === "postgresql") {
    const [{ PGlite }, { vector }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("@electric-sql/pglite-pgvector"),
    ]);
    const postgres = await PGlite.create("memory://", {
      extensions: { vector },
      ...(databaseTemplate ? { loadDataDir: databaseTemplate } : {}),
    });
    // Read once: a connection may start while another left the session in a failed transaction, where every query
    // fails until it ends.
    const serverVersion = await postgres.query<{ server_version: string }>("SHOW server_version");
    const startupReply = createPostgresStartupReply(serverVersion.rows[0]?.server_version ?? "");
    // Every wire connection shares the one PGlite session, so a second client (Effect's own) sees the same data and
    // transactions as the playground's `pg` client. The guest lets one connection at a time hold a transaction
    // Connection 0 belongs to the main PostgreSQL client; other sessions open with a startup packet.
    const connections = new Map<number, PostgresWireConnection>();
    let closed = false;

    const runCycle = async (
      connection: Extract<PostgresWireConnection, { phase: "ready" }>,
      frames: readonly Uint8Array[],
      synced: boolean,
    ): Promise<Uint8Array> => {
      if (frames.length === 0) {
        return new Uint8Array();
      }

      const reply = toPostgresCycleReply(await postgres.execProtocolRaw(concatBytes(...frames)), synced);
      connection.cycleOpen = !synced;

      if (reply.transactionStatus !== undefined) {
        connection.transactionStatus = reply.transactionStatus;
      }

      return reply.bytes;
    };

    // The server rolls back what a closed connection left open: a cycle waiting for its Sync is rolled back and synced
    // first, then its transaction, so the next connection finds the session idle.
    const rollBackConnection = async (connection: PostgresWireConnection): Promise<void> => {
      if (connection.phase !== "ready") {
        return;
      }

      if (connection.cycleOpen) {
        await runCycle(connection, [POSTGRES_ROLLBACK_CYCLE], true);
      }

      if (connection.transactionStatus !== "I") {
        await postgres.exec("ROLLBACK");
      }
    };

    const exchange = async (connectionId: number, bytes: Uint8Array): Promise<Uint8Array> => {
      if (bytes.byteLength > MAX_DATABASE_MESSAGE_BYTES) {
        throw new RangeError("PostgreSQL exchange exceeds 2 MiB");
      }

      const known = connections.get(connectionId);

      if (known === undefined && connections.size >= MAX_POSTGRES_CONNECTIONS) {
        throw new RangeError(
          `Cannot open PostgreSQL connection ${connectionId}: ${MAX_POSTGRES_CONNECTIONS} connections are already open`,
        );
      }

      let connection: PostgresWireConnection = known ?? { phase: "startup", input: new Uint8Array() };

      try {
        connection.input = concatBytes(connection.input, bytes);

        if (connection.input.byteLength > MAX_DATABASE_MESSAGE_BYTES) {
          throw new RangeError("PostgreSQL exchange exceeds 2 MiB");
        }

        const output: Uint8Array[] = [];
        let cycle: Uint8Array[] = [];
        // False once the client closed the connection (Terminate) or it only carried a cancel request.
        let open = true;

        while (open) {
          const headerLength = connection.phase === "startup" ? 8 : 5;

          if (connection.input.byteLength < headerLength) {
            break;
          }

          const length =
            connection.phase === "startup" ? readUint32(connection.input, 0) : readUint32(connection.input, 1) + 1;

          if (length < headerLength || length > MAX_DATABASE_MESSAGE_BYTES) {
            throw new TypeError(`Invalid PostgreSQL packet length: ${length}`);
          }

          if (connection.input.byteLength < length) {
            break;
          }

          const message = connection.input.subarray(0, length);
          const rest = connection.input.slice(length);

          if (connection.phase === "startup") {
            const code = readUint32(message, 4);

            if (code === POSTGRES_CANCEL_REQUEST) {
              // PGlite runs one statement at a time and cannot interrupt it. The server closes a cancel connection.
              open = false;
            } else if (code === POSTGRES_SSL_REQUEST || code === POSTGRES_GSSENC_REQUEST) {
              // "N": no encryption, so the client goes on with its startup packet in plain text.
              output.push(Uint8Array.of(0x4e));
              connection.input = rest;
            } else if (code === POSTGRES_PROTOCOL_3_0) {
              connection = { phase: "ready", input: rest, transactionStatus: "I", cycleOpen: false };
              output.push(startupReply);
            } else {
              throw new TypeError(`Expected PostgreSQL protocol 3.0, but got ${code >>> 16}.${code & 0xffff}`);
            }

            continue;
          }

          connection.input = rest;

          if (message[0] === POSTGRES_TERMINATE) {
            output.push(await runCycle(connection, cycle, false));
            cycle = [];
            await rollBackConnection(connection);
            open = false;
            continue;
          }

          cycle.push(message);

          if (message[0] === POSTGRES_SYNC || message[0] === POSTGRES_QUERY) {
            output.push(await runCycle(connection, cycle, true));
            cycle = [];
          }
        }

        if (open && connection.phase === "ready") {
          output.push(await runCycle(connection, cycle, false));
        }

        // A connection still in its startup with nothing buffered is the same as a new one, so it is not kept.
        if (open && (connection.phase === "ready" || connection.input.byteLength > 0)) {
          connections.set(connectionId, connection);
        } else {
          connections.delete(connectionId);
        }

        return concatBytes(...output);
      } catch (cause) {
        connections.delete(connectionId);
        await rollBackConnection(connection).catch(() => {});
        throw cause;
      }
    };

    return {
      async call(operation, value) {
        assertEngineOpen(closed);

        if (operation === "pg.exchange") {
          if (!(value instanceof Uint8Array)) {
            throw new TypeError("Invalid PostgreSQL exchange");
          }

          return exchange(0, value);
        }

        if (operation === "pg.connection-exchange") {
          const request = PostgresConnectionExchangeSchema.safeParse(value);

          if (!request.success) {
            throw new TypeError("Invalid PostgreSQL connection exchange: expected { connection, bytes }");
          }

          return exchange(request.data.connection, request.data.bytes);
        }

        if (operation === "pg.enable-vector") {
          if (value !== undefined && value !== null) {
            throw new TypeError("Vector extension operation does not accept a payload");
          }

          await postgres.query("CREATE EXTENSION IF NOT EXISTS vector");
          return undefined;
        }

        if (operation === "inspect") {
          return inspectPostgres(postgres);
        }

        if (operation === "plan.query") {
          const request = parseRequest(
            PostgresPlanQuerySchema,
            value,
            "A planning query requires SQL text and a parameter list",
          );

          // JSON stays text, so EXPLAIN (FORMAT JSON) reaches the planner exactly as Postgres wrote it.
          const result = await postgres.query<Record<string, unknown>>(request.sql, request.params ?? [], {
            parsers: { 114: (text: string) => text, 3802: (text: string) => text },
          });

          return { rows: result.rows };
        }

        if (operation === "plan.exec") {
          const request = parseRequest(SqlTextRequestSchema, value, "A planning statement requires SQL text");

          await postgres.exec(request.sql);

          return undefined;
        }

        throw new Error(`Unsupported PostgreSQL operation: ${operation}`);
      },
      async close() {
        if (closed) {
          return;
        }

        closed = true;
        connections.clear();
        await postgres.close();
      },
    };
  }

  if (dialect !== "sqlite") {
    throw new TypeError("Unsupported database dialect");
  }

  const { createSqliteClient } = await import("./sqlite-client.js");
  const sqlite = await createSqliteClient();
  const transactions = new Map<number, SqliteTransaction>();
  let nextTransaction = 0;
  let closed = false;
  let clientState: "open" | "closed" = "open";

  return {
    async call(operation, value) {
      assertEngineOpen(closed);

      if (operation === "inspect") {
        return inspectSqlite(sqlite);
      }

      if (operation === "plan.query") {
        const { statement } = parseRequest(
          SqliteStatementRequestSchema,
          value,
          "A planning query requires a statement",
        );
        const result = await sqlite.execute(statement);
        const planRows = result.rows.map((row) =>
          Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
        );

        return { rows: planRows };
      }

      if (operation === "plan.exec") {
        const request = parseRequest(SqlTextRequestSchema, value, "A planning statement requires SQL text");

        await sqlite.executeMultiple(request.sql);
        return undefined;
      }

      if (operation === "plan.time") {
        const { statement, ...timing } = parseRequest(
          SqlitePlanTimeSchema,
          value,
          "A planning timing requires a statement, rollback, budgetMs, and maxSamples",
        );

        return { samples: sqlite.time(statement, timing) };
      }

      if (operation === "sqlite.reconnect") {
        clientState = "open";

        return undefined;
      }

      if (operation === "sqlite.close") {
        closeSqlite(sqlite, transactions);
        clientState = "closed";
        // Reopening retains committed data for host inspection and rolls back the guest's unfinished transaction.
        sqlite.reconnect();

        return undefined;
      }

      if (clientState === "closed") {
        throw new Error("SQLite client is closed");
      }

      const { transaction: transactionId } = parseRequest(
        TransactionSelectionSchema,
        value,
        "Expected a database operation object",
      );
      const transaction = transactionId === undefined ? undefined : transactions.get(transactionId);
      const client = transaction ?? sqlite;

      if (transactionId !== undefined && transaction === undefined) {
        throw new Error("Transaction is closed or belongs to another run");
      }

      switch (operation) {
        case "sqlite.execute": {
          const { statement } = parseRequest(SqliteStatementRequestSchema, value, "A SQL statement requires text");

          return { ...serializeSqliteResult(await client.execute(statement)), closed: client.closed };
        }

        case "sqlite.batch": {
          const request = parseRequest(SqliteBatchRequestSchema, value, "A batch requires valid statements");
          const { statements } = request;
          const mode = request.mode ?? "deferred";
          const results =
            transaction === undefined
              ? await sqlite.batch(statements, mode)
              : await transaction.batch(statements.map(batchStatementAsStatement));

          return results.map(serializeSqliteResult);
        }

        case "sqlite.begin": {
          if (transactionId !== undefined) {
            throw new TypeError("A new transaction cannot select an existing transaction");
          }

          const { mode } = parseRequest(TransactionModeRequestSchema, value, "Unsupported SQLite transaction mode");
          const id = ++nextTransaction;
          transactions.set(id, await sqlite.transaction(mode ?? "write"));

          return id;
        }

        case "sqlite.commit":
        case "sqlite.rollback":
        case "sqlite.close-transaction": {
          if (transaction === undefined || transactionId === undefined) {
            throw new Error("No transaction selected");
          }

          try {
            if (operation === "sqlite.commit") {
              await transaction.commit();
            } else if (operation === "sqlite.rollback") {
              await transaction.rollback();
            } else {
              transaction.close();
            }
          } finally {
            transaction.close();
            transactions.delete(transactionId);
          }

          return undefined;
        }

        case "sqlite.multiple": {
          const request = parseRequest(SqlTextRequestSchema, value, "SQL must be text");

          await client.executeMultiple(request.sql);
          return undefined;
        }

        case "sqlite.migrate": {
          const { statements } = parseRequest(SqliteMigrateRequestSchema, value, "Migrations require statements");
          const results = await sqlite.migrate(statements);
          return results.map(serializeSqliteResult);
        }

        case "sqlite.sync":
          return sqlite.sync();

        default:
          throw new Error(`Unsupported SQLite operation: ${operation}`);
      }
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      closeSqlite(sqlite, transactions);
    },
  };
}

/** Serialize a database error, keeping its stack, `code` and raw driver code when present */
export function serializeDatabaseError(value: unknown): SerializedDatabaseError {
  if (!(value instanceof Error)) {
    return { name: "Error", message: String(value) };
  }

  const details: SerializedDatabaseError = {
    name: value.name,
    message: value.message,
  };

  if (value.stack !== undefined) {
    details.stack = value.stack;
  }

  const error = value as Error & {
    code?: unknown;
    rawCode?: unknown;
    extendedCode?: unknown;
    resultCode?: unknown;
  };

  if (error.code !== undefined) {
    details.code = stringValue(error.code);
  }

  if (typeof error.extendedCode === "string") {
    details.extendedCode = error.extendedCode;
  }

  const rawCode = error.rawCode ?? error.resultCode;

  if (typeof rawCode === "string" || typeof rawCode === "number") {
    details.rawCode = rawCode;
  }

  return details;
}

function assertEngineOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Database engine is closed");
  }
}

/** A guest request read with `schema`; throws a `TypeError` with `message` when it does not match. */
function parseRequest<Output>(schema: z.ZodMiniType<Output>, value: unknown, message: string): Output {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError(message, { cause: parsed.error });
  }

  return parsed.data;
}

function batchStatementAsStatement(value: InStatement | [string, InValue[]?]): InStatement {
  if (!Array.isArray(value)) {
    return value;
  }

  return value[1] === undefined ? { sql: value[0] } : { sql: value[0], args: value[1] };
}

function serializeSqliteResult(value: Awaited<ReturnType<SqliteClient["execute"]>>) {
  return {
    columns: value.columns,
    columnTypes: value.columnTypes,
    rowsAffected: value.rowsAffected,
    lastInsertRowid: value.lastInsertRowid,
    rows: value.rows.map((row) => Array.from({ length: row.length }, (_, index) => row[index])),
  };
}

function closeSqlite(sqlite: SqliteClient, transactions: Map<number, SqliteTransaction>): void {
  for (const transaction of transactions.values()) {
    transaction.close();
  }

  transactions.clear();
  sqlite.close();
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = sumBy(parts, (part) => part.byteLength);
  const combined = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function postgresPacket(type: string, payload: Uint8Array): Uint8Array {
  if (type.length !== 1) {
    throw new TypeError("PostgreSQL packet type must be one byte");
  }

  const bytes = new Uint8Array(payload.byteLength + 5);
  bytes[0] = type.charCodeAt(0);
  new DataView(bytes.buffer).setUint32(1, payload.byteLength + 4, false);
  bytes.set(payload, 5);

  return bytes;
}

function encodeCStringPair(name: string, value: string): Uint8Array {
  return new TextEncoder().encode(`${name}\0${value}\0`);
}

/** The server's answer to a startup packet: no authentication, the parameters clients read, then ready and idle. */
function createPostgresStartupReply(serverVersion: string): Uint8Array {
  const parameters = Object.entries({
    server_version: serverVersion,
    client_encoding: "UTF8",
    standard_conforming_strings: "on",
  }).map(([name, value]) => postgresPacket("S", encodeCStringPair(name, value)));

  return concatBytes(postgresPacket("R", new Uint8Array(4)), ...parameters, postgresPacket("Z", Uint8Array.of(0x49)));
}

/**
 * Give PGlite's reply to one cycle of frames the ReadyForQuery a server sends
 *
 * A server sends one ReadyForQuery per Sync or simple Query. After an error in the extended protocol PGlite before
 * 0.5.11 sent one of its own before the Sync's, which strict clients such as `@effect/sql-pg` read as a desync. 0.5.11
 * replies as a server does, so this is a guard that changes nothing on it. A synced cycle
 * (ending with Sync or Query) keeps only its last ReadyForQuery, and a cycle still waiting for its Sync keeps none.
 * `transactionStatus` is the kept ReadyForQuery's status byte, if any.
 */
function toPostgresCycleReply(
  reply: Uint8Array,
  synced: boolean,
): { bytes: Uint8Array; transactionStatus: PostgresTransactionStatus | undefined } {
  const frames: Uint8Array[] = [];
  let lastReadyIndex = -1;
  let offset = 0;

  while (offset + 5 <= reply.byteLength) {
    const end = offset + readUint32(reply, offset + 1) + 1;
    const frame = reply.subarray(offset, Math.min(end, reply.byteLength));

    if (frame[0] === POSTGRES_READY_FOR_QUERY) {
      lastReadyIndex = frames.length;
    }

    frames.push(frame);
    offset = end;
  }

  const keptReadyIndex = synced ? lastReadyIndex : -1;
  const kept = frames.filter((frame, index) => frame[0] !== POSTGRES_READY_FOR_QUERY || index === keptReadyIndex);
  const status = keptReadyIndex === -1 ? undefined : String.fromCharCode(frames[keptReadyIndex]?.[5] ?? 0);

  return {
    bytes: concatBytes(...kept),
    transactionStatus: status === "I" || status === "T" || status === "E" ? status : undefined,
  };
}

type Row = Record<string, unknown>;

/** The one PGlite method the inspection reads rows through. */
type PostgresQueryClient = { query(sql: string): Promise<{ rows: Row[] }> };

async function inspectPostgres(client: PostgresQueryClient): Promise<PostgresDatabaseDescription> {
  const [schemas, tables, columns, primaryKeys, foreignKeys, indexes, checks, views, enums, sequences] =
    await Promise.all([
      rows(
        client,
        "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg_toast%' ORDER BY schema_name",
      ),
      rows(
        client,
        "SELECT table_schema AS schema_name, table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' ORDER BY table_schema, table_name",
      ),
      rows(
        client,
        "SELECT table_schema AS schema_name, table_name, column_name AS name, data_type, is_nullable, column_default, is_generated, generation_expression FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' ORDER BY table_schema, table_name, ordinal_position",
      ),
      rows(
        client,
        "SELECT tc.table_schema AS schema_name, tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_catalog = tc.constraint_catalog AND kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'PRIMARY KEY' ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position",
      ),
      rows(
        client,
        "SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname AS constraint_name, a.attname AS column_name, rt.relname AS referenced_table, ra.attname AS referenced_column, k.ordinal_position FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class rt ON rt.oid = c.confrelid CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(local_attribute, referenced_attribute, ordinal_position) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.local_attribute JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.referenced_attribute WHERE c.contype = 'f' ORDER BY n.nspname, t.relname, c.conname, k.ordinal_position",
      ),
      rows(
        client,
        "SELECT schemaname AS schema_name, tablename AS table_name, indexname AS name, indexdef FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname, tablename, indexname",
      ),
      rows(
        client,
        "SELECT n.nspname AS schema_name, c.relname AS table_name, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE con.contype = 'c' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY n.nspname, c.relname, con.conname",
      ),
      rows(
        client,
        "SELECT schemaname AS schema_name, viewname AS name, definition FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, viewname",
      ),
      rows(
        client,
        "SELECT n.nspname AS schema_name, t.typname AS name, e.enumlabel AS value FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace ORDER BY n.nspname, t.typname, e.enumsortorder",
      ),
      rows(
        client,
        "SELECT sequence_schema AS schema_name, sequence_name AS name FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY sequence_schema, sequence_name",
      ),
    ]);

  const schemaDescriptions: PostgresSchemaDescription[] = schemas.map((schema) => {
    const schemaName = stringValue(schema.name);

    return {
      name: schemaName,
      tables: tables
        .filter((table) => table.schema_name === schemaName)
        .map((table) =>
          describePostgresTable(
            schemaName,
            stringValue(table.name),
            columns,
            primaryKeys,
            foreignKeys,
            indexes,
            checks,
          ),
        ),
      views: views
        .filter((view) => view.schema_name === schemaName)
        .map((view) => ({ name: stringValue(view.name), definition: optionalString(view.definition) })),
      enums: groupEnums(enums.filter((entry) => entry.schema_name === schemaName)),
      sequences: sequences
        .filter((entry) => entry.schema_name === schemaName)
        .map((entry) => ({ name: stringValue(entry.name) })),
    };
  });

  return { dialect: "postgresql", schemas: schemaDescriptions };
}

function describePostgresTable(
  schemaName: string,
  tableName: string,
  columns: Row[],
  primaryKeys: Row[],
  foreignKeys: Row[],
  indexes: Row[],
  checks: Row[],
): DatabaseTableDescription {
  const matches = (row: Row) => row.schema_name === schemaName && row.table_name === tableName;

  return {
    name: tableName,
    columns: columns.filter(matches).map((column): DatabaseColumnDescription => ({
      name: stringValue(column.name),
      dataType: stringValue(column.data_type),
      nullable: column.is_nullable === "YES",
      ...(optionalString(column.column_default) === undefined
        ? {}
        : { defaultValue: optionalString(column.column_default) }),
      ...(column.is_generated === "ALWAYS" && optionalString(column.generation_expression) !== undefined
        ? { generatedExpression: optionalString(column.generation_expression) }
        : {}),
    })),
    primaryKey: primaryKeys.filter(matches).map((column) => stringValue(column.column_name)),
    foreignKeys: groupPostgresForeignKeys(foreignKeys.filter(matches)),
    indexes: indexes.filter(matches).map(parsePostgresIndex),
    checks: checks.filter(matches).map((check) => stringValue(check.definition)),
  };
}

function groupPostgresForeignKeys(rowsToGroup: Row[]): DatabaseForeignKeyDescription[] {
  const groups = new Map<string, DatabaseForeignKeyDescription>();

  for (const row of rowsToGroup) {
    const key = stringValue(row.constraint_name);
    const current = groups.get(key);
    groups.set(key, {
      columns: [...(current?.columns ?? []), stringValue(row.column_name)],
      referencedTable: stringValue(row.referenced_table),
      referencedColumns: [...(current?.referencedColumns ?? []), stringValue(row.referenced_column)],
    });
  }

  return [...groups.values()];
}

function parsePostgresIndex(row: Row): DatabaseIndexDescription {
  const definition = stringValue(row.indexdef);
  const columnsMatch = definition.match(/\((.*)\)(?:\s+WHERE\s+.*)?$/i);

  return {
    name: stringValue(row.name),
    columns: columnsMatch?.[1]?.split(",").map((column) => column.trim().replace(/^"|"$/g, "")) ?? [],
    unique: /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(definition),
  };
}

function groupEnums(enumRows: Row[]): Array<{ name: string; values: string[] }> {
  const groups = new Map<string, string[]>();

  for (const row of enumRows) {
    const name = stringValue(row.name);
    groups.set(name, [...(groups.get(name) ?? []), stringValue(row.value)]);
  }

  return [...groups].map(([name, values]) => ({ name, values }));
}

async function rows(client: PostgresQueryClient, sql: string): Promise<Row[]> {
  return (await client.query(sql)).rows;
}

async function inspectSqlite(client: SqliteClient): Promise<SqliteDatabaseDescription> {
  const objects = await querySqliteRows(
    client,
    "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  const tables: SqliteTableDescription[] = [];
  const views: DatabaseViewDescription[] = [];

  for (const object of objects) {
    const name = stringValue(object.name);
    const definition = optionalString(object.sql);

    if (object.type === "view") {
      views.push({ name, ...(definition === undefined ? {} : { definition }) });

      continue;
    }

    const identifier = quoteSqliteIdentifier(name);
    const [columns, foreignKeys, indexList] = await Promise.all([
      querySqliteRows(client, `PRAGMA table_xinfo(${identifier})`),
      querySqliteRows(client, `PRAGMA foreign_key_list(${identifier})`),
      querySqliteRows(client, `PRAGMA index_list(${identifier})`),
    ]);

    const indexes: DatabaseIndexDescription[] = [];

    for (const index of indexList) {
      const indexName = stringValue(index.name);
      const indexColumns = await querySqliteRows(client, `PRAGMA index_info(${quoteSqliteIdentifier(indexName)})`);
      indexes.push({
        name: indexName,
        columns: indexColumns.map((column) => stringValue(column.name)),
        unique: numberValue(index.unique) === 1,
      });
    }

    const primaryKey = columns
      .filter((column) => numberValue(column.pk) > 0)
      .toSorted((left, right) => numberValue(left.pk) - numberValue(right.pk))
      .map((column) => stringValue(column.name));
    tables.push({
      name,
      columns: columns.map((column): DatabaseColumnDescription => ({
        name: stringValue(column.name),
        dataType: stringValue(column.type),
        nullable: numberValue(column.notnull) === 0 && numberValue(column.pk) === 0,
        ...(optionalString(column.dflt_value) === undefined ? {} : { defaultValue: optionalString(column.dflt_value) }),
        ...(numberValue(column.hidden) >= 2
          ? { generatedExpression: extractGeneratedExpression(definition, stringValue(column.name)) ?? "generated" }
          : {}),
      })),
      primaryKey,
      foreignKeys: groupSqliteForeignKeys(foreignKeys),
      indexes,
      checks: extractSqliteChecks(definition),
      ...(definition === undefined ? {} : { sql: definition }),
      autoIncrement: /\bAUTOINCREMENT\b/i.test(definition ?? ""),
    });
  }

  return { dialect: "sqlite", tables, views };
}

async function querySqliteRows(client: SqliteClient, sql: string): Promise<Row[]> {
  const result = await client.execute(sql);
  return result.rows;
}

function groupSqliteForeignKeys(foreignKeys: Row[]): DatabaseForeignKeyDescription[] {
  const groups = new Map<number, DatabaseForeignKeyDescription>();

  for (const foreignKey of foreignKeys) {
    const id = numberValue(foreignKey.id);
    const current = groups.get(id);
    groups.set(id, {
      columns: [...(current?.columns ?? []), stringValue(foreignKey.from)],
      referencedTable: stringValue(foreignKey.table),
      referencedColumns: [...(current?.referencedColumns ?? []), stringValue(foreignKey.to)],
    });
  }

  return [...groups.values()];
}

function extractSqliteChecks(createSql: string | undefined): string[] {
  if (createSql === undefined) {
    return [];
  }

  const checks: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  while (pattern.exec(createSql) !== null) {
    const start = pattern.lastIndex;
    let depth = 1;
    let quote: "'" | '"' | "`" | undefined;

    for (let index = start; index < createSql.length; index += 1) {
      const character = createSql[index];

      if (quote !== undefined) {
        if (character === quote && createSql[index + 1] === quote) {
          index += 1;
        } else if (character === quote) {
          quote = undefined;
        }

        continue;
      }

      if (character === "'" || character === '"' || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }

      if (depth === 0) {
        checks.push(createSql.slice(start, index).trim());
        pattern.lastIndex = index + 1;
        break;
      }
    }
  }

  return checks;
}

function extractGeneratedExpression(createSql: string | undefined, columnName: string): string | undefined {
  if (createSql === undefined) {
    return undefined;
  }

  const escapedName = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const generatedPattern = new RegExp(
    `(?:[\\"'\`]?${escapedName}[\\"'\`]?).*?GENERATED\\s+ALWAYS\\s+AS\\s*\\(([^)]*)\\)`,
    "i",
  );

  return createSql.match(generatedPattern)?.[1]?.trim();
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function stringValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;

    case "undefined":
      return "";

    case "object":
      return value === null ? "" : JSON.stringify(value);

    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
    case "function":
      return String(value);
  }
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}
