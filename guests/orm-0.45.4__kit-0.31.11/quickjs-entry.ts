import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type ClientConfig } from "pg";

import type { SerializedValue } from "../../packages/runtime/src/quickjs/contract.ts";
import { WireTransport } from "../../packages/runtime/src/quickjs/wire-transport.ts";

type PostgresClientConstructor = typeof Client;
interface SocketClientConstructor extends PostgresClientConstructor {
  new (options: Omit<ClientConfig, "stream"> & { stream: WireTransport }): Client;
}

/** Encode before JSON so Date.toJSON cannot erase the type. Reject cycles and excessive nesting. */
export function encodeResult(value: unknown): SerializedValue {
  return encodeValue({ value, depth: 0 });
}

function encodeValue({ value, depth }: { value: unknown; depth: number }): SerializedValue {
  if (depth > 64) {
    throw new TypeError("Result nesting exceeds 64 levels");
  }

  if (value === undefined) {
    return { type: "undefined" };
  }

  if (typeof value === "bigint") {
    return { type: "bigint", value: String(value) };
  }

  if (value instanceof Date) {
    return { type: "date", value: value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    return { type: "bytes", value: Array.from(value) };
  }

  if (Array.isArray(value)) {
    return { type: "array", value: value.map((item: unknown) => encodeValue({ value: item, depth: depth + 1 })) };
  }

  if (value !== null && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Result objects must be plain records, arrays, dates or bytes");
    }

    return {
      type: "object",
      value: Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        encodeValue({ value: item, depth: depth + 1 }),
      ]),
    };
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { type: "primitive", value };
  }

  throw new TypeError(`Unsupported result value: ${typeof value}`);
}

/** Initialize the selected ORM and a real pg client in the schema's realm. */
export async function initializeRun(schema: Record<string, unknown>, env: Record<string, string>) {
  // pg's connection.js accepts a socket object; @types/pg only declares a factory returning a full Node Duplex.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow correction of the public pg socket option; the client type remains unchanged.
  const SocketClient = Client as SocketClientConstructor;
  const client = new SocketClient({ stream: new WireTransport(), user: "postgres", database: "postgres", ssl: false });
  await client.connect();
  const db = drizzle(client, { schema });

  return { client, db, schema, env, target: { dialect: "postgresql" } };
}
