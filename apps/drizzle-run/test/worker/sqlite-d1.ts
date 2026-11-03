import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";

import type { D1Database, D1PreparedStatement, D1Result } from "../../worker/platform";

const migrationsFolder = fileURLToPath(new URL("../../drizzle/", import.meta.url));

/**
 * A D1 stand-in for tests: real SQLite, with the app's Drizzle migrations applied in order. It covers the statement
 * calls drizzle-orm/d1 makes: `first`, `all`, `run`, `raw`, and `batch` in one transaction.
 */
export class SqliteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    // D1 enforces foreign keys.
    this.sqlite.exec("PRAGMA foreign_keys = ON");

    for (const migration of readMigrationFiles({ migrationsFolder })) {
      for (const statement of migration.sql) {
        this.sqlite.exec(statement);
      }
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteStatement(this.sqlite, query, []);
  }

  async batch<Row = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> {
    this.sqlite.exec("BEGIN");

    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement)) {
          throw new TypeError("Batch only accepts statements from this database.");
        }

        return statement.executeNow<Row>();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (cause) {
      this.sqlite.exec("ROLLBACK");
      throw cause;
    }
  }
}

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly query: string,
    private readonly values: SQLInputValue[],
  ) {}

  bind(...values: (string | number | null)[]): D1PreparedStatement {
    return new SqliteStatement(this.sqlite, this.query, values);
  }

  async first<Row = unknown>(): Promise<Row | null> {
    const row = this.sqlite.prepare(this.query).get(...this.values);
    return row === undefined ? null : ({ ...row } as Row);
  }

  async all<Row = unknown>(): Promise<D1Result<Row>> {
    return {
      results: this.sqlite
        .prepare(this.query)
        .all(...this.values)
        .map((row) => ({ ...row }) as Row),
    };
  }

  async run<Row = unknown>(): Promise<D1Result<Row>> {
    return this.runNow<Row>();
  }

  async raw<Row extends unknown[] = unknown[]>(): Promise<Row[]> {
    const statement = this.sqlite.prepare(this.query);
    // Arrays keep every column, even two with the same name from a join.
    statement.setReturnArrays(true);
    const rows: unknown[] = statement.all(...this.values);
    return rows as Row[];
  }

  runNow<Row>(): D1Result<Row> {
    const { changes } = this.sqlite.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(changes) } };
  }

  /** Runs the statement as D1's batch does: the rows of a statement that returns any, the changes otherwise. */
  executeNow<Row>(): D1Result<Row> {
    const statement = this.sqlite.prepare(this.query);

    if (statement.columns().length === 0) {
      return this.runNow<Row>();
    }

    return { results: statement.all(...this.values).map((row) => ({ ...row }) as Row), meta: { changes: 0 } };
  }
}
