import type { Client, InArgs, InStatement, ResultSet, Row, Transaction, TransactionMode } from "@libsql/client";
import * as z from "zod/mini";

import { decodeDatabaseValue, encodeDatabaseValue } from "../packages/runtime/src/database/database-codec.ts";

declare function hostDatabaseCall(operation: string, value: string): Promise<string>;

const DatabaseReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      name: z.string(),
      message: z.string(),
      stack: z.optional(z.string()),
      code: z.optional(z.string()),
      extendedCode: z.optional(z.string()),
      rawCode: z.optional(z.union([z.string(), z.number()])),
    }),
  }),
]);

/** A guest owns no database handle; all operations belong to its disposable host. */
export async function callDatabase(operation: string, value: unknown): Promise<unknown> {
  const reply = DatabaseReplySchema.parse(
    JSON.parse(await hostDatabaseCall(operation, JSON.stringify(encodeDatabaseValue(value)))),
  );

  if (!reply.ok) {
    throw Object.assign(new Error(reply.error.message), reply.error);
  }

  return decodeDatabaseValue(reply.value);
}

const ResultSchema = z.object({
  columns: z.array(z.string()),
  columnTypes: z.array(z.string()),
  rows: z.array(z.array(z.union([z.null(), z.string(), z.number(), z.bigint(), z.instanceof(ArrayBuffer)]))),
  rowsAffected: z.number(),
  lastInsertRowid: z.bigint(),
  closed: z.optional(z.boolean()),
});

type ResultConstructor = new (
  columns: string[],
  columnTypes: string[],
  rows: Row[],
  rowsAffected: number,
  lastInsertRowid: bigint,
) => ResultSet;

/** Adapt the host's SQLite engine to the pinned libSQL contract consumed by Drizzle and Effect. */
export function createSqliteGuestClient(ResultSet: ResultConstructor): Client {
  function resultSet(input: unknown): ResultSet {
    const result = ResultSchema.parse(input);
    const rows = result.rows.map((values) => {
      const row: Row = { length: values.length };
      Object.defineProperty(row, "length", { enumerable: false });

      for (const [index, value] of values.entries()) {
        Object.defineProperty(row, index, { value });
        const name = result.columns[index];

        if (!Object.hasOwn(row, name)) {
          Object.defineProperty(row, name, { value, enumerable: true, configurable: true, writable: true });
        }
      }

      return row;
    });

    return new ResultSet(result.columns, result.columnTypes, rows, result.rowsAffected, result.lastInsertRowid);
  }

  function createScope(transaction?: number) {
    const scope = transaction === undefined ? {} : { transaction };
    let closing: Promise<unknown> | undefined;
    const client = {
      closed: false,
      protocol: "file",
      async execute(input: InStatement, args?: InArgs) {
        const statement = typeof input === "string" ? { sql: input, args: args ?? [] } : input;
        const result = ResultSchema.parse(await callDatabase("sqlite.execute", { ...scope, statement }));

        if (transaction !== undefined) {
          client.closed = result.closed ?? false;
        }

        return resultSet(result);
      },
      async batch(statements: InStatement[], mode?: TransactionMode) {
        return z
          .array(z.unknown())
          .parse(await callDatabase("sqlite.batch", { ...scope, statements, mode }))
          .map(resultSet);
      },
      async executeMultiple(sql: string) {
        await callDatabase("sqlite.multiple", { ...scope, sql });
      },
      close() {
        if (!client.closed) {
          client.closed = true;
          closing = callDatabase(transaction === undefined ? "sqlite.close" : "sqlite.close-transaction", scope);
        }

        return closing;
      },
    };

    return {
      client,
      scope,
      reset() {
        client.closed = false;
        closing = undefined;
      },
    };
  }

  const root = createScope();

  return Object.assign(root.client, {
    async transaction(mode?: TransactionMode): Promise<Transaction> {
      const id = z.number().parse(await callDatabase("sqlite.begin", { mode }));
      const { client, scope } = createScope(id);

      return Object.assign(client, {
        async commit() {
          await callDatabase("sqlite.commit", scope);
          client.closed = true;
        },
        async rollback() {
          await callDatabase("sqlite.rollback", scope);
          client.closed = true;
        },
      });
    },
    async migrate(statements: InStatement[]) {
      return z
        .array(z.unknown())
        .parse(await callDatabase("sqlite.migrate", { statements }))
        .map(resultSet);
    },
    async sync() {
      const result = await callDatabase("sqlite.sync", {});

      return z.optional(z.object({ frames_synced: z.number(), frame_no: z.number() })).parse(result);
    },
    async reconnect() {
      await callDatabase("sqlite.reconnect", {});
      root.reset();
    },
  });
}
