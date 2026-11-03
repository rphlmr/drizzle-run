import { createActor } from "xstate";
import * as z from "zod/mini";

import { decodeDatabaseValue, encodeDatabaseValue } from "./database-codec.ts";
import {
  createDatabaseEngine,
  serializeDatabaseError,
  type DatabaseDialect,
  type DatabaseEngine,
  type SerializedDatabaseError,
} from "./database-engine.js";
import { createDatabaseWorkerMachine } from "./database-worker-machine.ts";
import type { WorkerScope } from "./worker-scope.ts";

const MAX_TRANSPORT_BYTES = 2 * 1024 * 1024; // 2 MiB
const textEncoder = new TextEncoder();
const allowedOperations: Record<DatabaseDialect, ReadonlySet<string>> = {
  postgresql: new Set([
    "pg.exchange",
    "pg.connection-exchange",
    "pg.enable-vector",
    "inspect",
    "plan.query",
    "plan.exec",
    "close",
  ]),
  sqlite: new Set([
    "sqlite.execute",
    "sqlite.batch",
    "sqlite.begin",
    "sqlite.commit",
    "sqlite.rollback",
    "sqlite.close-transaction",
    "sqlite.multiple",
    "sqlite.migrate",
    "sqlite.sync",
    "sqlite.reconnect",
    "sqlite.close",
    "inspect",
    "plan.query",
    "plan.exec",
    "plan.time",
    "close",
  ]),
};

/** Starts the database; any other message is a request. */
const InitMessageSchema = z.object({
  kind: z.literal("init"),
  dialect: z.optional(z.unknown()),
  template: z.optional(z.instanceof(Blob)),
});

export function serveDatabase(workerScope: WorkerScope): void {
  const database = createActor(
    createDatabaseWorkerMachine({
      createEngine: (dialect, template) => createDatabaseEngine(dialect, { databaseTemplate: template }),
      resolveRefusal(dialect, { operation, value }) {
        if (!allowedOperations[dialect].has(operation)) {
          return new Error(`Unsupported database operation: ${operation}`);
        }

        if (measureEncodedValue(value) > MAX_TRANSPORT_BYTES) {
          return new RangeError("Database request exceeds 2 MiB");
        }

        return null;
      },
      serve: serveRequest,
      postValue,
      postReady: () => workerScope.postMessage({ kind: "ready" }),
      postStartupError,
      postProtocolError: (error) => postProtocolError(serializeDatabaseError(error)),
      postRequestError,
      closeScope: () => workerScope.close(),
    }),
  );
  database.start();

  workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
    const initMessage = InitMessageSchema.safeParse(event.data);

    if (initMessage.success) {
      database.send({ type: "client.init", dialect: initMessage.data.dialect, template: initMessage.data.template });

      return;
    }

    database.send({ type: "client.request", message: event.data });
  });

  async function serveRequest(
    engine: DatabaseEngine,
    { id, operation, value }: { id: number; operation: string; value?: unknown },
  ): Promise<void> {
    try {
      const result = await engine.call(operation, decodeDatabaseValue(value));
      postValue(id, result);
    } catch (cause) {
      postRequestError(id, cause);
    }
  }

  function postValue(id: number, value: unknown): void {
    try {
      const encoded = encodeDatabaseValue(value);

      if (measureEncodedValue(encoded) > MAX_TRANSPORT_BYTES) {
        throw new RangeError("Database response exceeds 2 MiB");
      }

      workerScope.postMessage({ id, value: encoded });
    } catch (cause) {
      postRequestError(id, cause);
    }
  }

  function postRequestError(id: number, error: unknown): void {
    const details = serializeDatabaseError(error);
    workerScope.postMessage({ id, error: details });
  }

  function postStartupError(error: unknown): void {
    workerScope.postMessage({
      kind: "startup_error",
      error: serializeDatabaseError(error),
    });
  }

  function postProtocolError(error: SerializedDatabaseError): void {
    workerScope.postMessage({ kind: "protocol_error", error });
  }
}

function measureEncodedValue(root: unknown): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let bytes = 0;

  while (stack.length > 0) {
    const item = stack.pop();

    if (item === undefined) {
      break;
    }

    if (item.depth > 64) {
      return MAX_TRANSPORT_BYTES + 1;
    }

    const value = item.value;

    if (typeof value === "string") {
      bytes += textEncoder.encode(value).byteLength;
    } else if (Array.isArray(value)) {
      bytes += value.length * 2;

      for (const entry of value) {
        stack.push({ value: entry, depth: item.depth + 1 });
      }
    } else if (typeof value === "object" && value !== null) {
      // Any object counts, not only plain ones: decoded values such as `Date` and `Uint8Array` use the budget too.
      bytes += 8;

      for (const [key, entry] of Object.entries(value)) {
        bytes += textEncoder.encode(key).byteLength + 2;
        stack.push({ value: entry, depth: item.depth + 1 });
      }
    } else if (value === null || typeof value === "number" || typeof value === "boolean") {
      bytes += 8;
    }

    if (bytes > MAX_TRANSPORT_BYTES) {
      return bytes;
    }
  }

  return bytes;
}
