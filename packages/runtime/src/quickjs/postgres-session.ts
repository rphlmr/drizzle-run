import { Buffer } from "node:buffer";

import { createActor } from "xstate";

import {
  createPostgresSessionMachine,
  getConnectionPhase,
  type ConnectionPhase,
  type ReceivedFrame,
} from "./postgres-session-machine.ts";
import { createFrameReader, readUint32 } from "./protocol-frames.ts";
import type { observePostgresWire } from "./wire-observer.ts";
import { WireTransport } from "./wire-transport.ts";

const terminateFrame = Uint8Array.of(0x58, 0, 0, 0, 4);
type Observer = ReturnType<typeof observePostgresWire>;

/** Own logical PostgreSQL connections and release transaction admission after failed or dropped sockets. */
export function createPostgresSession({
  call,
  connectionObserver,
  onWaiting = () => {},
  waitingNoticeMs = 1_000,
}: {
  call: (operation: string, value: unknown) => Promise<unknown>;
  connectionObserver?: () => Observer;
  onWaiting?: (waiting: { connection: number; owner: number }) => void;
  waitingNoticeMs?: number;
}) {
  const session = createActor(createPostgresSessionMachine({ onWaiting, waitingNoticeMs })).start();
  const transports = new Map<number, { transport: WireTransport; drop: () => Promise<void> }>();
  let nextConnection = 0;

  function acquire(connection: number, closing = false) {
    return new Promise<ConnectionPhase>((grant) =>
      session.send({ type: "exchange.requested", connection, closing, grant }),
    );
  }

  function closeConnection(connection: number) {
    session.send({ type: "connection.closed", connection });
    transports.delete(connection);
  }

  function createConnection(id: number, connected: boolean, observer?: Observer) {
    const readSent = createFrameReader(true);
    session.send({ type: "connection.opened", connection: id });
    const send = (bytes: Uint8Array) =>
      call(id === 0 ? "pg.exchange" : "pg.connection-exchange", id === 0 ? bytes : { connection: id, bytes });
    async function drop() {
      const phase = await acquire(id, true);

      try {
        if (phase === "ready") {
          await send(terminateFrame);
        }
      } finally {
        closeConnection(id);
        session.send({ type: "exchange.finished" });
      }
    }

    const transport = new WireTransport({
      connected,
      async exchange(bytes) {
        const closing = bytes.length === 5 && bytes[0] === 0x58;
        const phase = await acquire(id, closing);

        try {
          if (phase === "closed") {
            throw new Error(`PostgreSQL connection ${id} is closed`);
          }

          const sentFrames = readSent(bytes);
          const cancels = phase === "startup" && bytes.length >= 8 && readUint32(bytes, 4) === 80_877_102;
          const terminates = sentFrames.some((frame) => frame.type === 0x58);
          session.send({ type: "frames.sent", connection: id, frames: sentFrames });
          observer?.sent(bytes);
          let reply: Uint8Array;

          try {
            const response = await send(bytes);

            if (!(response instanceof Uint8Array)) {
              throw new TypeError("Invalid PostgreSQL response");
            }

            reply = response;
          } catch (cause) {
            observer?.failed(cause);

            if (phase === "ready" && !terminates) {
              try {
                await send(terminateFrame);
              } catch {
                /* The original exchange failure remains authoritative. */
              }
            }

            closeConnection(id);
            throw cause;
          }

          const frames = reply.length >= 5 ? createFrameReader(false)(reply) : [];
          const typedFrames: ReceivedFrame[] = frames.flatMap((frame) =>
            frame.type === undefined ? [] : [{ type: frame.type, body: frame.body }],
          );
          session.send({ type: "reply.received", connection: id, frames: typedFrames, closes: terminates || cancels });
          observer?.received(reply);

          if (terminates || cancels) {
            transports.delete(id);
          }

          for (const frame of frames) {
            if (frame.type === 0x41) {
              for (const [other, socket] of transports) {
                if (other !== id && getConnectionPhase(session.getSnapshot(), other) === "ready") {
                  socket.transport.emit("data", Buffer.from(frame.bytes));
                }
              }
            }
          }

          if (cancels) {
            queueMicrotask(() => transport.destroy());
          }

          return Array.from(reply);
        } finally {
          session.send({ type: "exchange.finished" });
        }
      },
    });
    transports.set(id, { transport, drop });
    transport.once("close", () => {
      if (transports.has(id)) {
        void drop().catch((cause: unknown) => console.warn("PostgreSQL connection cleanup failed", cause));
      }
    });

    return transport;
  }

  async function close() {
    for (const { transport, drop } of transports.values()) {
      await drop();
      transport.destroy();
    }

    session.stop();
  }

  return {
    main: createConnection(0, false),
    connection: (observer = connectionObserver?.()) => createConnection(++nextConnection, true, observer),
    close,
  };
}
