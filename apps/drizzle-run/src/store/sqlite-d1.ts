import type { BindableValue, Database } from "@sqlite.org/sqlite-wasm";

/** What a D1 statement call returns, limited to the fields drizzle-orm/d1 reads. */
export interface SqliteD1Result<Row = Record<string, unknown>> {
  results: Row[];
  success: true;
  meta: { changes: number };
}

/**
 * A D1-shaped database over an open sqlite-wasm database
 *
 * drizzle-orm has no sqlite-wasm driver, and its sqlite-proxy session cannot read the object rows its migrator asks
 * for. drizzle-orm/d1 can, and it only calls `prepare`, `bind`, `first`, `all`, `run`, `raw` and `batch`, which this
 * covers. Every call runs synchronously against the database; the promises only match D1's signatures.
 */
export class SqliteD1Database {
  constructor(private readonly database: Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, query, []);
  }

  /** Runs the statements in one savepoint, so a failed statement undoes the batch, inside a transaction or not. */
  async batch(statements: SqliteD1Statement[]): Promise<SqliteD1Result[]> {
    this.database.exec("SAVEPOINT d1_batch");

    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("RELEASE d1_batch");

      return results;
    } catch (cause) {
      this.database.exec("ROLLBACK TO d1_batch");
      this.database.exec("RELEASE d1_batch");
      throw cause;
    }
  }
}

/** A prepared D1-shaped statement. `bind` returns a new statement, as D1's does. */
export class SqliteD1Statement {
  constructor(
    private readonly database: Database,
    private readonly query: string,
    private readonly values: readonly BindableValue[],
  ) {}

  bind(...values: BindableValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.query, values);
  }

  async first(): Promise<Record<string, unknown> | null> {
    return this.selectObjects()[0] ?? null;
  }

  async all(): Promise<SqliteD1Result> {
    return { results: this.selectObjects(), success: true, meta: { changes: 0 } };
  }

  async run(): Promise<SqliteD1Result> {
    return this.runNow();
  }

  async raw(): Promise<unknown[][]> {
    // Arrays keep every column, even two with the same name from a join.
    return this.database.exec({ sql: this.query, bind: this.values, rowMode: "array", returnValue: "resultRows" });
  }

  /** Runs the statement as D1's batch does: the rows of a statement that returns any, the changes otherwise. */
  execute(): SqliteD1Result {
    const rows = this.selectObjects();

    return { results: rows, success: true, meta: { changes: rows.length === 0 ? this.database.changes() : 0 } };
  }

  private runNow(): SqliteD1Result {
    this.database.exec({ sql: this.query, bind: this.values });

    return { results: [], success: true, meta: { changes: this.database.changes() } };
  }

  private selectObjects(): Record<string, unknown>[] {
    return this.database.exec({ sql: this.query, bind: this.values, rowMode: "object", returnValue: "resultRows" });
  }
}
