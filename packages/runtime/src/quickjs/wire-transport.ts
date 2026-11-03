import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import type { ActorRefFrom } from "xstate";
import { assign, createActor, setup } from "xstate";

import { declareType } from "../machines/declare-type.ts";

type WriteCallback = (cause?: Error) => void;
type WireContext = { sequence: number; pending: Map<number, WriteCallback | undefined> };
type WireEvent =
  | { type: "connection.request" | "connection.ready" | "connection.announce" | "connection.close" }
  | { type: "write.request"; bytes: Uint8Array; callback?: WriteCallback }
  | { type: "exchange.fulfill"; id: number; reply: number[] }
  | { type: "exchange.reject"; id: number; cause: Error };

type WireDependencies = {
  exchange: (bytes: Uint8Array) => Promise<number[]>;
  emit: (event: string, ...values: unknown[]) => void;
  defer?: (callback: () => void) => void;
};

/** Gate connection announcements, writes, and replies; closing settles callbacks once. */
export function createWireTransportMachine({ exchange, emit, defer = queueMicrotask }: WireDependencies) {
  return setup({
    types: { context: declareType<WireContext>(), events: declareType<WireEvent>() },
    guards: { pending: ({ context, event }) => "id" in event && context.pending.has(event.id) },
    actions: {
      queueConnect: ({ self }) => defer(() => self.send({ type: "connection.ready" })),
      queueAnnouncement: ({ self }) => defer(() => self.send({ type: "connection.announce" })),
      connected: () => emit("connect"),
      remember: assign(({ context, event }) =>
        event.type === "write.request"
          ? {
              sequence: context.sequence + 1,
              pending: new Map(context.pending).set(context.sequence + 1, event.callback),
            }
          : {},
      ),
      exchange: ({ context, event, self }) => {
        if (event.type !== "write.request") {
          return;
        }

        const id = context.sequence;

        try {
          void exchange(event.bytes).then(
            (reply) => self.send({ type: "exchange.fulfill", id, reply }),
            (cause: unknown) =>
              self.send({
                type: "exchange.reject",
                id,
                cause: cause instanceof Error ? cause : new Error("PostgreSQL transport exchange failed", { cause }),
              }),
          );
        } catch (cause) {
          self.send({
            type: "exchange.reject",
            id,
            cause: new Error("PostgreSQL transport exchange failed", { cause }),
          });
        }
      },
      deliver: ({ context, event }) => {
        if (event.type !== "exchange.fulfill") {
          return;
        }

        if (event.reply.length > 0) {
          emit("data", Buffer.from(event.reply));
        }

        context.pending.get(event.id)?.();
      },
      fail: ({ context, event }) => {
        if (event.type === "exchange.reject") {
          context.pending.get(event.id)?.(event.cause);
          emit("error", event.cause);
        }
      },
      forget: assign(({ context, event }) => {
        const pending = new Map(context.pending);

        if ("id" in event) {
          pending.delete(event.id);
        }

        return { pending };
      }),
      close: ({ context }) => {
        const callbacks = [...context.pending.values()];
        defer(() => {
          for (const callback of callbacks) {
            callback?.(new Error("PostgreSQL transport is closed"));
          }

          emit("close");
        });
      },
      clear: assign({ pending: () => new Map() }),
    },
  }).createMachine({
    initial: "connecting",
    context: { sequence: 0, pending: new Map() },
    states: {
      connecting: {
        on: {
          "connection.request": { actions: "queueConnect" },
          "connection.ready": { target: "open", actions: "queueAnnouncement" },
          "connection.close": "closed",
        },
      },
      open: {
        on: {
          "connection.announce": { actions: "connected" },
          "write.request": { actions: ["remember", "exchange"] },
          "exchange.fulfill": { guard: "pending", actions: ["deliver", "forget"] },
          "exchange.reject": { guard: "pending", target: "closed", actions: ["fail", "forget"] },
          "connection.close": "closed",
        },
      },
      closed: { entry: ["close", "clear"], type: "final" },
    },
  });
}

declare function hostExchange(encoded: string): Promise<number[]>;

/** Socket interface consumed by the unmodified pg parser and serializer inside the guest. */
export class WireTransport extends EventEmitter {
  private readonly actor: ActorRefFrom<ReturnType<typeof createWireTransportMachine>>;

  constructor({
    exchange = (bytes) => hostExchange(JSON.stringify(Array.from(bytes))),
    connected = false,
  }: Partial<Pick<WireDependencies, "exchange">> & { connected?: boolean } = {}) {
    super();
    this.actor = createActor(
      createWireTransportMachine({
        exchange,
        emit: (...args) => {
          this.emit(...args);
        },
      }),
    ).start();

    if (connected) {
      this.actor.send({ type: "connection.ready" });
    }
  }

  get writable() {
    return this.actor.getSnapshot().matches("open");
  }

  connect() {
    this.actor.send({ type: "connection.request" });

    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  write(bytes: Uint8Array, callback?: WriteCallback) {
    const event = { type: "write.request", bytes, callback } satisfies WireEvent;

    if (!this.actor.getSnapshot().can(event)) {
      throw new Error("PostgreSQL transport is closed or not connected");
    }

    this.actor.send(event);

    return true;
  }

  end(bytes?: Uint8Array) {
    if (bytes) {
      this.write(bytes);
    }

    this.destroy();
  }

  destroy() {
    this.actor.send({ type: "connection.close" });
  }
}
