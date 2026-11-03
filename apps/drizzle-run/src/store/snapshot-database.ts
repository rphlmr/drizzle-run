import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

/**
 * Open an in-memory SQLite database from a file's bytes
 *
 * Without bytes it opens an empty database. The store uses this where the browser offers no origin private file
 * system, such as a private window, and keeps the bytes in IndexedDB instead.
 */
export function openSnapshotDatabase(sqlite: Sqlite3Static, bytes: Uint8Array | undefined): Database {
  const database = new sqlite.oo1.DB(":memory:");

  if (bytes === undefined || bytes.byteLength === 0) {
    return database;
  }

  // SQLite owns the copy: it may grow it, and frees it when the database closes or when deserializing fails.
  const pointer = sqlite.wasm.allocFromTypedArray(bytes);
  const flags = sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const resultCode = sqlite.capi.sqlite3_deserialize(
    database,
    "main",
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    flags,
  );

  if (resultCode !== sqlite.capi.SQLITE_OK) {
    database.close();
    throw new Error(`Expected the stored database to open, but SQLite returned code ${resultCode}.`);
  }

  return database;
}

/** The bytes of an open database's file, to open again with `openSnapshotDatabase`. */
export function exportSnapshot(sqlite: Sqlite3Static, database: Database): Uint8Array {
  return sqlite.capi.sqlite3_js_db_export(database);
}
