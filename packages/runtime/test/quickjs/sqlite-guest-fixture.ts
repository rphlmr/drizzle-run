import type { ResultSet, Row } from "@libsql/client";

/** Minimal result container for testing guest operations without a database. */
export class GuestResultSet implements ResultSet {
  constructor(
    readonly columns: string[],
    readonly columnTypes: string[],
    readonly rows: Row[],
    readonly rowsAffected: number,
    readonly lastInsertRowid: bigint,
  ) {}

  toJSON() {
    return {};
  }
}
