import initSqlite, { type Database } from "@sqlite.org/sqlite-wasm";

import { createStoreClient, type StoreClient } from "../../src/store/client";
import { createStoreService, type StoreRequest } from "../../src/store/service";

/** A store client and the in-memory database behind it. */
export interface MemoryStore {
  client: StoreClient;
  database: Database;
}

/**
 * Create a store on an in-memory SQLite database, for tests
 *
 * It runs the store worker's service behind a MessageChannel, so requests and answers are cloned as they are between
 * the page and the worker. Requests run one at a time, as the worker's lock makes them. Only the OPFS file and the
 * cross-tab lock are left out.
 */
export async function createMemoryStore(): Promise<MemoryStore> {
  // No OPFS here: keep sqlite-wasm from trying to install its OPFS VFS.
  Object.assign(globalThis, { sqlite3ApiConfig: { disable: { vfs: { opfs: true, "opfs-wl": true } } } });
  const sqlite = await initSqlite();
  const database = new sqlite.oo1.DB(":memory:");
  let queue: Promise<unknown> = Promise.resolve();
  const service = createStoreService((work) => {
    const next = queue.catch(() => {}).then(() => work(database));
    queue = next;

    return next;
  });
  const channel = new MessageChannel();

  channel.port2.addEventListener("message", (event: MessageEvent<StoreRequest>) => {
    void service.respond(event.data).then((response) => channel.port2.postMessage(response));
  });
  channel.port1.start();
  channel.port2.start();

  return { client: createStoreClient(channel.port1), database };
}
