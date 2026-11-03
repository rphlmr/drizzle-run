import type {
  Client,
  InArgs,
  InStatement,
  InValue,
  ResultSet,
  Row,
  Transaction,
  TransactionMode,
  Value,
} from "@libsql/client";
import { LibsqlError } from "@libsql/client/web";
import initSqlite, { type Database, type Sqlite3Static, type SqlValue } from "@sqlite.org/sqlite-wasm";

import { encodeBytes } from "./database-codec.ts";

interface SqliteApiConfiguration {
  [key: string]: unknown;
  disable?: {
    [key: string]: unknown;
    vfs?: Record<string, unknown>;
  };
}

declare global {
  var sqlite3ApiConfig: SqliteApiConfiguration | undefined;
}

function toSqlValue(value: InValue): SqlValue {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "boolean") {
    return Number(value);
  }

  return value;
}

function toRowValue(value: SqlValue): Value {
  if (value instanceof Uint8Array || value instanceof Int8Array) {
    return Uint8Array.from(value).buffer;
  }

  return value;
}

function toJsonValue(value: Value) {
  if (typeof value === "bigint") {
    return String(value);
  }

  if (value instanceof ArrayBuffer) {
    return encodeBytes(new Uint8Array(value));
  }

  return value;
}

function createRow(columns: string[], values: Value[]): Row {
  const row: Row = { length: values.length };
  Object.defineProperty(row, "length", { enumerable: false });

  for (const [index, value] of values.entries()) {
    Object.defineProperty(row, index, { value });
    const name = columns[index];

    if (name !== undefined && !Object.hasOwn(row, name)) {
      Object.defineProperty(row, name, { value, enumerable: true, configurable: true, writable: true });
    }
  }

  return row;
}

function withSqliteErrors<Result>(sqlite: Sqlite3Static, operation: () => Result): Result {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof sqlite.SQLite3Error) {
      const rawCode = cause.resultCode;
      throw new LibsqlError(
        cause.message,
        sqlite.capi.sqlite3_js_rc_str(rawCode & 0xff),
        sqlite.capi.sqlite3_js_rc_str(rawCode),
        rawCode,
        cause,
      );
    }

    throw cause;
  }
}

function executeSql(sqlite: Sqlite3Static, database: Database, sql: string): void {
  withSqliteErrors(sqlite, () => database.exec(sql));
}

function executeStatement(options: Parameters<typeof executePreparedStatement>[0]): ResultSet {
  return withSqliteErrors(options.sqlite, () => executePreparedStatement(options));
}

function executePreparedStatement({
  sqlite,
  database,
  input,
  args,
}: {
  sqlite: Sqlite3Static;
  database: Database;
  input: InStatement;
  args?: InArgs;
}): ResultSet {
  const statement = typeof input === "string" ? { sql: input, args } : input;
  const query = database.prepare(statement.sql);

  try {
    if (Array.isArray(statement.args) && statement.args.length > 0) {
      query.bind(statement.args.map(toSqlValue));
    } else if (statement.args !== undefined && !Array.isArray(statement.args)) {
      for (let index = 1; index <= query.parameterCount; index += 1) {
        const name = sqlite.capi.sqlite3_bind_parameter_name(query, index);
        const key = name !== null && Object.hasOwn(statement.args, name) ? name : name?.slice(1);
        const value = key === undefined ? undefined : statement.args[key];

        if (value === undefined) {
          throw new LibsqlError(`Missing argument for parameter ${name ?? index}`, "ARGS_INVALID");
        }

        query.bind(index, toSqlValue(value));
      }
    }

    const columns = query.columnCount === 0 ? [] : query.getColumnNames([]);
    const columnTypes = columns.map((_, index) => sqlite.capi.sqlite3_column_decltype(query, index) ?? "");
    const values: Value[][] = [];

    while (query.step()) {
      values.push(query.get([]).map(toRowValue));
    }

    const rowsAffected = sqlite.capi.sqlite3_stmt_readonly(query) ? 0 : database.changes();
    const lastInsertRowid = sqlite.capi.sqlite3_last_insert_rowid(database);

    return {
      columns,
      columnTypes,
      rows: values.map((row) => createRow(columns, row)),
      rowsAffected,
      lastInsertRowid,
      toJSON: () => ({
        columns,
        columnTypes,
        rows: values.map((row) => row.map(toJsonValue)),
        rowsAffected,
        lastInsertRowid: String(lastInsertRowid),
      }),
    };
  } finally {
    query.finalize();
  }
}

export class SqliteTransaction implements Transaction {
  readonly #sqlite: Sqlite3Static;
  readonly #database: Database;
  readonly #release: () => void;

  constructor({ sqlite, database, release }: { sqlite: Sqlite3Static; database: Database; release: () => void }) {
    this.#sqlite = sqlite;
    this.#database = database;
    this.#release = release;
  }

  get closed(): boolean {
    return !this.#database.isOpen() || this.#sqlite.capi.sqlite3_get_autocommit(this.#database) !== 0;
  }

  async execute(statement: InStatement): Promise<ResultSet> {
    this.#affirmOpen();
    return executeStatement({ sqlite: this.#sqlite, database: this.#database, input: statement });
  }

  async batch(statements: InStatement[]): Promise<ResultSet[]> {
    this.#affirmOpen();
    return statements.map((statement) =>
      executeStatement({ sqlite: this.#sqlite, database: this.#database, input: statement }),
    );
  }

  async executeMultiple(sql: string): Promise<void> {
    this.#affirmOpen();
    executeSql(this.#sqlite, this.#database, sql);
  }

  async commit(): Promise<void> {
    this.#affirmOpen();
    executeSql(this.#sqlite, this.#database, "COMMIT");
    this.close();
  }

  async rollback(): Promise<void> {
    if (this.#database.isOpen()) {
      if (!this.closed) {
        executeSql(this.#sqlite, this.#database, "ROLLBACK");
      }

      this.close();
    }
  }

  close(): void {
    this.#database.close();
    this.#release();
  }

  #affirmOpen(): void {
    if (this.closed) {
      throw new LibsqlError("Transaction is closed", "TRANSACTION_CLOSED");
    }
  }
}

/**
 * SQLite client
 *
 * A libSQL `Client` over sqlite-wasm, so the guest's libSQL driver runs against an in-memory, transient database.
 */
export class SqliteClient implements Client {
  readonly protocol = "file";
  readonly #sqlite: Sqlite3Static;
  readonly #filename: string;
  readonly #transactions = new Set<SqliteTransaction>();
  #database: Database;

  constructor(sqlite: Sqlite3Static, filename: string) {
    this.#sqlite = sqlite;
    this.#filename = filename;
    this.#database = this.#open("c", true);
  }

  get closed(): boolean {
    return !this.#database.isOpen();
  }

  async execute(statement: InStatement, args?: InArgs): Promise<ResultSet> {
    this.#affirmOpen();
    return executeStatement({ sqlite: this.#sqlite, database: this.#database, input: statement, args });
  }

  async batch(
    statements: Array<InStatement | [string, InArgs?]>,
    mode: TransactionMode = "deferred",
  ): Promise<ResultSet[]> {
    const normalizedStatements = statements.map((statement) =>
      Array.isArray(statement) ? { sql: statement[0], args: statement[1] } : statement,
    );

    return this.#batch({ statements: normalizedStatements, mode, foreignKeys: true });
  }

  async migrate(statements: InStatement[]): Promise<ResultSet[]> {
    return this.#batch({ statements, mode: "deferred", foreignKeys: false });
  }

  async transaction(mode: TransactionMode = "write"): Promise<SqliteTransaction> {
    return this.#transaction(mode, true);
  }

  async executeMultiple(sql: string): Promise<void> {
    this.#affirmOpen();
    executeSql(this.#sqlite, this.#database, sql);
  }

  async sync(): Promise<undefined> {
    this.#affirmOpen();
    return undefined;
  }

  reconnect(): void {
    if (this.closed) {
      this.#database = this.#open("c", true);
    }
  }

  close(): void {
    for (const transaction of this.#transactions) {
      transaction.close();
    }

    this.#database.close();
  }

  /**
   * Times one statement on the main connection, reading every row and keeping none, so a large
   * result never crosses the worker boundary. Writes run inside a savepoint that is rolled back.
   */
  time(statement: InStatement, options: { rollback: boolean; budgetMs: number; maxSamples: number }): number[] {
    this.#affirmOpen();
    const input = typeof statement === "string" ? { sql: statement, args: undefined } : statement;
    const query = this.#database.prepare(input.sql);
    const samples: number[] = [];
    let spent = 0;

    try {
      while (samples.length < options.maxSamples && (samples.length < 3 || spent < options.budgetMs)) {
        if (options.rollback) {
          this.#database.exec("SAVEPOINT drizzle_run_timing");
        }

        try {
          query.reset(true);

          if (Array.isArray(input.args) && input.args.length > 0) {
            query.bind(input.args.map(toSqlValue));
          }

          const started = performance.now();

          while (query.step()) {
            // Rows are read and dropped: only the time matters.
          }

          const elapsed = performance.now() - started;
          samples.push(elapsed);
          spent += elapsed;
        } finally {
          if (options.rollback) {
            this.#database.exec("ROLLBACK TO drizzle_run_timing; RELEASE drizzle_run_timing");
          }
        }

        // One slow run is enough evidence; three keep the median honest for the rest.
        if (samples.length === 1 && samples[0] >= options.budgetMs) {
          break;
        }
      }
    } finally {
      query.finalize();
    }

    return samples;
  }

  #open(flags: "c" | "r", foreignKeys: boolean): Database {
    const database = new this.#sqlite.oo1.DB(this.#filename, flags);

    try {
      executeSql(this.#sqlite, database, foreignKeys ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
      return database;
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  #transaction(mode: TransactionMode, foreignKeys: boolean): SqliteTransaction {
    this.#affirmOpen();
    const database = this.#open(mode === "read" ? "r" : "c", foreignKeys);

    try {
      executeSql(this.#sqlite, database, mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
      const transaction = new SqliteTransaction({
        sqlite: this.#sqlite,
        database,
        release: () => this.#transactions.delete(transaction),
      });
      this.#transactions.add(transaction);

      return transaction;
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  async #batch({
    statements,
    mode,
    foreignKeys,
  }: {
    statements: InStatement[];
    mode: TransactionMode;
    foreignKeys: boolean;
  }): Promise<ResultSet[]> {
    const transaction = this.#transaction(mode, foreignKeys);

    try {
      const results = await transaction.batch(statements);
      await transaction.commit();

      return results;
    } finally {
      transaction.close();
    }
  }

  #affirmOpen(): void {
    if (this.closed) {
      throw new LibsqlError("SQLite client is closed", "CLIENT_CLOSED");
    }
  }
}

/**
 * Run a sqlite-wasm initialization with its OPFS VFS disabled
 *
 * Restores the previous `sqlite3ApiConfig` afterwards, unless something else replaced it meanwhile.
 */
export async function withTransientSqliteVfsConfiguration<Result>(initialize: () => Promise<Result>): Promise<Result> {
  const previousConfiguration = globalThis.sqlite3ApiConfig;
  // sqlite-wasm documents sqlite3ApiConfig as its downstream bootstrap hook.
  const scopedConfiguration: SqliteApiConfiguration = {
    ...previousConfiguration,
    disable: {
      ...previousConfiguration?.disable,
      vfs: {
        ...previousConfiguration?.disable?.vfs,
        opfs: true,
        "opfs-wl": true,
      },
    },
  };

  globalThis.sqlite3ApiConfig = scopedConfiguration;

  try {
    return await initialize();
  } finally {
    if (globalThis.sqlite3ApiConfig === scopedConfiguration || !Object.hasOwn(globalThis, "sqlite3ApiConfig")) {
      if (previousConfiguration === undefined) {
        delete globalThis.sqlite3ApiConfig;
      } else {
        globalThis.sqlite3ApiConfig = previousConfiguration;
      }
    }
  }
}

/** Initialize sqlite-wasm without persistent storage */
export async function initializeTransientSqlite(): Promise<Sqlite3Static> {
  return withTransientSqliteVfsConfiguration(initSqlite);
}

/** Create a SQLite client on a fresh transient database */
export async function createSqliteClient(): Promise<SqliteClient> {
  const sqlite = await initializeTransientSqlite();

  const client = new SqliteClient(sqlite, "/playground.sqlite");

  return client;
}
