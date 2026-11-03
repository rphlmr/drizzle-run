import type { Dialect } from "@drizzle-run/core/catalog";

import { DatabaseWorkerClient, type DatabaseWorkerTransport } from "../database/database-rpc-client.ts";

/** The execution container owns its database worker. Closing also terminates the worker after its reply. */
export function createExecutionDatabase({
  transport,
  dialect,
  template,
}: {
  transport: DatabaseWorkerTransport;
  dialect: Dialect;
  template?: Blob;
}) {
  const client = new DatabaseWorkerClient(transport, dialect, { template });

  async function close() {
    try {
      await client.call("close", undefined);
    } finally {
      await client.dispose();
    }
  }

  return {
    call: (operation: string, value: unknown) => client.call(operation, value),
    close,
    terminate: () => client.dispose(),
  };
}
