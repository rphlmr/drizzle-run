import { createDatabaseEngine, type DatabaseDialect } from "../../src/database/database-engine.ts";
import { createSqliteClient } from "../../src/database/sqlite-client.ts";

export function createTestDatabaseEngine(dialect: DatabaseDialect) {
  return createDatabaseEngine(dialect);
}

export function createTestSqliteClient() {
  return createSqliteClient();
}
