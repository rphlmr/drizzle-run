/// <reference lib="webworker" />
import initSqlite, { type Database, type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { createStoreService, type StoreRequest, type WithStoreDatabase } from "./service";
import { exportSnapshot, openSnapshotDatabase } from "./snapshot-database";

// Only one context at a time can hold the opfs-sahpool file handles, so each request takes a Web Lock shared by every
// tab, reopens the pool, runs, and pauses the pool again before the lock is released.
// Private windows in Safari and Firefox offer no OPFS. There the database runs in memory from an IndexedDB copy, under
// the same lock.

declare const self: DedicatedWorkerGlobalScope;

const storeName = self.name || "drizzle-run";
const lockName = `drizzle-run-store:${storeName}`;
const databaseFile = "/store.sqlite3";

/** A database opened for one request; `close` writes it back where it lives. */
interface OpenedDatabase {
  database: Database;
  close(): Promise<void>;
}

async function initializeSqlite(): Promise<Sqlite3Static> {
  // The opfs VFS starts its own nested worker, which this store does not use; opfs-sahpool needs none.
  Object.assign(globalThis, { sqlite3ApiConfig: { disable: { vfs: { opfs: true, "opfs-wl": true } } } });

  return initSqlite();
}

function createPoolBackend(sqlite: Sqlite3Static): () => Promise<OpenedDatabase> {
  let pool: SAHPoolUtil | undefined;

  async function openPool(): Promise<SAHPoolUtil> {
    if (pool === undefined) {
      pool = await sqlite.installOpfsSAHPoolVfs({ name: storeName, directory: `.${storeName}-store` });
      return pool;
    }

    return pool.unpauseVfs();
  }

  return async () => {
    const openedPool = await openPool();
    let database: Database;

    try {
      database = new openedPool.OpfsSAHPoolDb(databaseFile);
    } catch (cause) {
      openedPool.pauseVfs();
      throw cause;
    }

    return {
      database,
      async close() {
        try {
          database.close();
        } finally {
          // Release the file handles before the lock, so the next tab in line can open the pool.
          openedPool.pauseVfs();
        }
      },
    };
  };
}

function requestSnapshotDatabase<Result>(work: (store: IDBObjectStore) => IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(`${storeName}-store`, 1);

    open.addEventListener("upgradeneeded", () => open.result.createObjectStore("files"));
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const transaction = open.result.transaction("files", "readwrite");
      const request = work(transaction.objectStore("files"));

      transaction.addEventListener("complete", () => {
        open.result.close();
        resolve(request.result);
      });
      transaction.addEventListener("abort", () => {
        open.result.close();
        reject(transaction.error ?? new Error("The local store snapshot transaction was aborted."));
      });
    });
  });
}

function createSnapshotBackend(sqlite: Sqlite3Static): () => Promise<OpenedDatabase> {
  return async () => {
    const stored: unknown = await requestSnapshotDatabase((files) => files.get(databaseFile));
    const database = openSnapshotDatabase(sqlite, stored instanceof Uint8Array ? stored : undefined);

    return {
      database,
      async close() {
        // Total changes since this in-memory database opened; migrations insert a row too.
        const changed = database.changes(true) > 0;
        const bytes = changed ? exportSnapshot(sqlite, database) : undefined;
        database.close();

        if (bytes !== undefined) {
          await requestSnapshotDatabase((files) => files.put(bytes, databaseFile));
        }
      },
    };
  };
}

async function hasPrivateFileSystem(): Promise<boolean> {
  try {
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

const openDatabase = (async () => {
  const sqlite = await initializeSqlite();

  return (await hasPrivateFileSystem()) ? createPoolBackend(sqlite) : createSnapshotBackend(sqlite);
})();

const withDatabase: WithStoreDatabase = async (work) => {
  const open = await openDatabase;

  return navigator.locks.request(lockName, async () => {
    const opened = await open();

    try {
      return await work(opened.database);
    } finally {
      await opened.close();
    }
  });
};

const service = createStoreService(withDatabase);

self.addEventListener("message", (event: MessageEvent<StoreRequest>) => {
  void service.respond(event.data).then((response) => self.postMessage(response));
});
