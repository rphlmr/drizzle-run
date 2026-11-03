import { Client, type ClientConfig } from "pg";

import { serializeValue } from "../packages/core/src/contracts/serialization.ts";
import type { SerializedValue } from "../packages/runtime/src/quickjs/contract.ts";
import type { WireTransport } from "../packages/runtime/src/quickjs/wire-transport.ts";

type PostgresClientConstructor = typeof Client;
interface SocketClientConstructor extends PostgresClientConstructor {
  new (options: Omit<ClientConfig, "stream"> & { stream: WireTransport }): Client;
}

/** Preserve special values while retaining the public serializer's unsupported and circular evidence. */
export function encodeResult(value: unknown): SerializedValue {
  return encodeSerialized(serializeValue(value), value);
}

function readStoredValue(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch {
    return undefined;
  }
}

function encodeSerialized(value: ReturnType<typeof serializeValue>, original?: unknown): SerializedValue {
  if (value.type === "object") {
    try {
      if (original instanceof Uint8Array) {
        return { type: "bytes", value: Array.from(original) };
      }
    } catch {
      return { type: "unsupported", valueType: "object", description: "Could not inspect value" };
    }
  }

  switch (value.type) {
    case "array":
      return {
        type: "array",
        value: value.value.map((item, index) => encodeSerialized(item, readStoredValue(original, String(index)))),
      };
    case "object":
      return {
        type: "object",
        value: Object.entries(value.value).map(([key, item]) => [
          key,
          encodeSerialized(item, readStoredValue(original, key)),
        ]),
      };
    case "bigint":
    case "circular":
    case "date":
    case "primitive":
    case "undefined":
    case "unsupported":
      return value;
  }
}

/** Initialize the selected ORM and a real pg client in the schema's realm. */
export async function createPostgresClient(stream: WireTransport) {
  // pg's connection.js accepts a socket object; @types/pg only declares a factory returning a full Node Duplex.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow correction of the public pg socket option; the client type remains unchanged.
  const SocketClient = Client as SocketClientConstructor;
  const client = new SocketClient({ stream, user: "postgres", database: "postgres", ssl: false });
  await client.connect();
  return client;
}
