import type { PGlite } from "@electric-sql/pglite";
import { assign, createActor, fromPromise, setup } from "xstate";
import * as z from "zod/mini";

import { declareType } from "../machines/declare-type.ts";

const maxProtocolBytes = 2 * 1024 * 1024;
const BytesSchema = z.array(z.int().check(z.minimum(0), z.maximum(255))).check(z.maxLength(maxProtocolBytes));
const ServerVersionSchema = z.object({ rows: z.array(z.object({ server_version: z.string() })) });
type ExchangeRequest = {
  bytes: Uint8Array;
  resolve: (bytes: Uint8Array) => void;
  reject: (cause: Error) => void;
};
type ProtocolStage = "startup" | "connected";
type BridgeContext = { queue: ExchangeRequest[]; stage: ProtocolStage };
type BridgeEvent = { type: "database.exchange"; request: ExchangeRequest } | { type: "database.close" };

export const DATABASE_EXCHANGE_ACTOR_ID = "databaseExchange";

function concatenateBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return bytes;
}

function createPacket(type: string, body: Uint8Array) {
  const packet = new Uint8Array(body.length + 5);
  packet[0] = type.charCodeAt(0);
  new DataView(packet.buffer).setUint32(1, body.length + 4);
  packet.set(body, 5);

  return packet;
}

/** Own the protocol queue, startup transition, and refusal after close. */
export function createPostgresBridgeMachine({
  database,
  startupReply,
}: {
  database: Pick<PGlite, "execProtocolRaw">;
  startupReply: Uint8Array;
}) {
  let bufferedInput = new Uint8Array();
  const machine = setup({
    types: { context: declareType<BridgeContext>(), events: declareType<BridgeEvent>() },
    actors: {
      exchange: fromPromise<{ bytes: Uint8Array; stage: ProtocolStage }, { bytes: Uint8Array; stage: ProtocolStage }>(
        async ({ input, signal }) => {
          bufferedInput = concatenateBytes([bufferedInput, input.bytes]);

          if (bufferedInput.length > maxProtocolBytes) {
            throw new RangeError("Buffered PostgreSQL input exceeds 2 MiB");
          }

          const output: Uint8Array[] = [];
          let stage = input.stage;

          while (bufferedInput.length >= (stage === "startup" ? 8 : 5)) {
            const view = new DataView(bufferedInput.buffer, bufferedInput.byteOffset, bufferedInput.length);
            const length = stage === "startup" ? view.getUint32(0) : view.getUint32(1) + 1;

            if (length < (stage === "startup" ? 8 : 5) || length > maxProtocolBytes) {
              throw new Error(`Invalid PostgreSQL frame length: ${length}`);
            }

            if (bufferedInput.length < length) {
              break;
            }

            const frame = bufferedInput.slice(0, length);
            bufferedInput = bufferedInput.slice(length);

            if (stage === "startup") {
              if (view.getUint32(4) !== 196_608) {
                throw new Error("Only PostgreSQL 3.0 plaintext startup is supported");
              }

              stage = "connected";
              output.push(startupReply);
            } else if (frame[0] !== 88) {
              output.push(await database.execProtocolRaw(frame));
              signal.throwIfAborted();
            }
          }

          const bytes = concatenateBytes(output);

          if (bytes.length > maxProtocolBytes) {
            throw new RangeError("PostgreSQL reply exceeds 2 MiB");
          }

          return { bytes, stage };
        },
      ),
    },
    guards: {
      queued: ({ context }) => context.queue.length > 0,
      hasCapacity: ({ context }) => context.queue.length < 32,
    },
    actions: {
      enqueue: assign(({ context, event }) =>
        event.type === "database.exchange" ? { queue: [...context.queue, event.request] } : {},
      ),
      rejectCapacity: ({ event }) => {
        if (event.type === "database.exchange") {
          event.request.reject(new RangeError("PostgreSQL bridge permits at most 32 pending writes"));
        }
      },
      rejectClosed: ({ event }) => {
        if (event.type === "database.exchange") {
          event.request.reject(new Error("PostgreSQL bridge closed"));
        }
      },
      rejectPending: ({ context }) => {
        for (const request of context.queue) {
          request.reject(new Error("PostgreSQL bridge closed"));
        }
      },
      release: assign(() => {
        bufferedInput = new Uint8Array();

        return { queue: [] };
      }),
    },
  }).createMachine({
    id: "postgresBridge",
    initial: "open",
    context: { queue: [], stage: "startup" },
    states: {
      open: {
        on: {
          "database.exchange": [{ guard: "hasCapacity", actions: "enqueue" }, { actions: "rejectCapacity" }],
          "database.close": "closed",
        },
        initial: "idle",
        states: {
          idle: { always: { guard: "queued", target: "busy" } },
          busy: {
            invoke: {
              id: DATABASE_EXCHANGE_ACTOR_ID,
              src: "exchange",
              input: ({ context }) => ({ bytes: context.queue[0].bytes, stage: context.stage }),
              onDone: {
                target: "idle",
                actions: [
                  ({ context, event }) => context.queue[0].resolve(event.output.bytes),
                  assign(({ context, event }) => ({ queue: context.queue.slice(1), stage: event.output.stage })),
                ],
              },
              onError: {
                target: "#postgresBridge.closed",
                actions: [
                  ({ context, event }) =>
                    context.queue[0].reject(new Error("PostgreSQL exchange failed", { cause: event.error })),
                  assign(({ context }) => ({ queue: context.queue.slice(1) })),
                ],
              },
            },
          },
        },
      },
      closed: { entry: ["rejectPending", "release"], on: { "database.exchange": { actions: "rejectClosed" } } },
    },
  });

  return machine;
}

/** Serialize one client's PostgreSQL frames. Closing refuses new requests and rejects pending exchanges. */
export async function createPostgresBridge({ database }: { database: Pick<PGlite, "query" | "execProtocolRaw"> }) {
  const version = ServerVersionSchema.parse(await database.query("SHOW server_version"));
  const startupReply = concatenateBytes([
    createPacket("R", new Uint8Array(4)),
    ...Object.entries({
      server_version: version.rows[0].server_version,
      client_encoding: "UTF8",
      standard_conforming_strings: "on",
    }).map(([key, value]) => createPacket("S", new TextEncoder().encode(`${key}\0${value}\0`))),
    createPacket("Z", Uint8Array.of(73)),
  ]);
  const actor = createActor(createPostgresBridgeMachine({ database, startupReply })).start();

  function exchange(value: unknown): Promise<Uint8Array> {
    const parsed = BytesSchema.safeParse(value);

    if (!parsed.success) {
      return Promise.reject(new Error("Invalid PostgreSQL byte request", { cause: parsed.error }));
    }

    return new Promise((resolve, reject) =>
      actor.send({
        type: "database.exchange",
        request: { bytes: Uint8Array.from(parsed.data), resolve, reject },
      }),
    );
  }

  function close() {
    actor.send({ type: "database.close" });
  }

  return { exchange, close };
}
