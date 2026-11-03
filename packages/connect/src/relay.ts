import {
  CONNECT_ROUTE_PREFIX,
  parseRelayServerFrame,
  RELAY_CLOSE,
  type RelayServerFrame,
} from "@drizzle-run/core/connect";
import { assign, createActor, fromCallback, sendTo, setup, type Actor } from "xstate";

import { declareType } from "./declare-type.ts";

/**
 * The companion's socket to its relay room. It reconnects with backoff (1 s, doubling, at
 * most 30 s) until it is closed, a newer companion takes the room, the relay ends the room, or
 * `MAX_RETRY_ATTEMPTS` reconnects in a row fail, so a stranded companion stops calling the relay.
 */

/** The part of `WebSocket` the relay client uses, so tests can pass a fake. */
export interface RelaySocketLike {
  send(text: string): void;
  close(code?: number): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

/** Opens a socket to a relay room URL, offering `protocols` as WebSocket subprotocols. */
export type OpenRelaySocket = (url: string, protocols: readonly string[]) => RelaySocketLike;

/** What the relay client reports to its owner. */
export interface RelayHandlers {
  frame(frame: RelayServerFrame): void;
  /** The socket closed; `retryInMs` is set when it will reconnect, otherwise the client is done. */
  closed(code: number, retryInMs: number | undefined): void;
}

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** Reconnects in a row without a `welcome` before giving up: about two minutes of backoff. */
export const MAX_RETRY_ATTEMPTS = 8;
/** Close codes after which reconnecting cannot help. A rate limited connection (`rateLimited`) retries with backoff. */
const FINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  RELAY_CLOSE.expired,
  RELAY_CLOSE.replaced,
  RELAY_CLOSE.misbehaving,
  RELAY_CLOSE.unproven,
]);
const NORMAL_CLOSE_CODE = 1000;

/** Get the companion's WebSocket URL for a room: `ws:` for an http origin, `wss:` otherwise. */
export function relayUrl(origin: string, roomId: string): string {
  const url = new URL(`${CONNECT_ROUTE_PREFIX}${roomId}`, origin);

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("role", "companion");

  return url.toString();
}

function openWebSocket(url: string, protocols: readonly string[]): RelaySocketLike {
  return new WebSocket(url, [...protocols]);
}

/** What the open socket reports. */
type SocketEvent =
  | { type: "socket.created"; socket: RelaySocketLike }
  | { type: "socket.frame"; frame: RelayServerFrame }
  | { type: "socket.closed"; code: number };

type RelayEvent = SocketEvent | { type: "relay.start" } | { type: "relay.close" };

type SocketCommand = { type: "socket.close" };

interface RelayContext {
  /** Reconnects in a row without a `welcome`. */
  attempt: number;
  /** The socket in use, from its creation until it closes. */
  socket: RelaySocketLike | undefined;
}

interface RelayMachineOptions {
  url: string;
  protocols: readonly string[];
  handlers: RelayHandlers;
  open: OpenRelaySocket;
}

function getRetryDelayMs(attempt: number) {
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** attempt);
}

/**
 * Build the relay client's machine
 *
 * `idle` until started; `connecting` until the relay welcomes it, then `open`; `closing` once closed while a socket is
 * up; `waitingRetry` between sockets; `closed` for good.
 */
export function createRelayMachine(options: RelayMachineOptions) {
  return setup({
    types: {
      context: declareType<RelayContext>(),
      events: declareType<RelayEvent>(),
    },
    actors: {
      socket: fromCallback<SocketCommand, undefined, SocketEvent>(({ sendBack, receive }) => {
        const socket = options.open(options.url, options.protocols);
        let isStopped = false;

        sendBack({ type: "socket.created", socket });
        socket.addEventListener("message", (event) => {
          if (isStopped || typeof event.data !== "string") {
            return;
          }

          const frame = parseRelayServerFrame(event.data);

          if (frame !== undefined) {
            sendBack({ type: "socket.frame", frame });
          }
        });
        socket.addEventListener("close", (event) => {
          if (!isStopped) {
            sendBack({ type: "socket.closed", code: event.code });
          }
        });
        socket.addEventListener("error", () => undefined);

        receive(() => socket.close(NORMAL_CLOSE_CODE));

        return () => {
          isStopped = true;
        };
      }),
    },
    delays: {
      retry: ({ context }) => getRetryDelayMs(context.attempt - 1),
    },
    guards: {
      isFinal: ({ context, event }) =>
        event.type === "socket.closed" && (FINAL_CLOSE_CODES.has(event.code) || context.attempt >= MAX_RETRY_ATTEMPTS),
      isWelcome: ({ event }) => event.type === "socket.frame" && event.frame.t === "welcome",
    },
    actions: {
      passFrame: ({ event }) => {
        if (event.type === "socket.frame") {
          options.handlers.frame(event.frame);
        }
      },
      reportClosed: ({ event }) => {
        if (event.type === "socket.closed") {
          options.handlers.closed(event.code, undefined);
        }
      },
      reportRetry: ({ context, event }) => {
        if (event.type === "socket.closed") {
          options.handlers.closed(event.code, getRetryDelayMs(context.attempt - 1));
        }
      },
    },
  }).createMachine({
    id: "relay",
    initial: "idle",
    context: { attempt: 0, socket: undefined },
    states: {
      idle: {
        on: { "relay.start": "socket", "relay.close": "closed" },
      },
      socket: {
        initial: "connecting",
        invoke: { id: "socket", src: "socket" },
        exit: assign({ socket: undefined }),
        on: {
          "socket.created": { actions: assign({ socket: ({ event }) => event.socket }) },
          "socket.frame": [
            { guard: "isWelcome", target: ".open", actions: [assign({ attempt: 0 }), "passFrame"] },
            { actions: "passFrame" },
          ],
          "socket.closed": [
            { guard: "isFinal", target: "closed", actions: "reportClosed" },
            {
              target: "waitingRetry",
              actions: [assign({ attempt: ({ context }) => context.attempt + 1 }), "reportRetry"],
            },
          ],
          "relay.close": ".closing",
        },
        states: {
          connecting: {},
          open: {},
          /** Closed by its owner: the socket's close is the last thing it reports. */
          closing: {
            entry: sendTo("socket", { type: "socket.close" } satisfies SocketCommand),
            on: {
              "socket.frame": {},
              "socket.closed": { target: "#relay.closed", actions: "reportClosed" },
              "relay.close": {},
            },
          },
        },
      },
      waitingRetry: {
        after: { retry: "socket" },
        on: { "relay.close": "closed" },
      },
      closed: { type: "final" },
    },
  });
}

/**
 * Relay client
 *
 * Passes every valid server frame to `handlers.frame` until `close()`, and ignores binary or unreadable ones.
 * A `welcome` frame resets the backoff. A final close code (replaced, expired, misbehaving, unproven) or
 * `MAX_RETRY_ATTEMPTS` failed reconnects in a row stop reconnecting.
 */
export class RelayClient {
  private readonly actor: Actor<ReturnType<typeof createRelayMachine>>;

  constructor(options: {
    url: string;
    /** WebSocket subprotocols to offer, such as `roomProtocols(proof)`. */
    protocols?: readonly string[];
    handlers: RelayHandlers;
    open?: OpenRelaySocket;
  }) {
    this.actor = createActor(
      createRelayMachine({
        url: options.url,
        protocols: options.protocols ?? [],
        handlers: options.handlers,
        open: options.open ?? openWebSocket,
      }),
    );
    this.actor.start();
  }

  /** Open the socket. Does nothing once closed. */
  start(): void {
    this.actor.send({ type: "relay.start" });
  }

  /** Send to one tab. Returns false unless the relay welcomed the socket and it takes the frame. */
  send(to: string, sealed: string): boolean {
    const snapshot = this.actor.getSnapshot();
    const { socket } = snapshot.context;

    // A closing socket drops frames without an error, so only an open one counts as sent.
    if (!snapshot.matches({ socket: "open" }) || socket === undefined) {
      return false;
    }

    try {
      socket.send(JSON.stringify({ t: "send", to, d: sealed }));
      return true;
    } catch {
      return false;
    }
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.actor.send({ type: "relay.close" });
  }
}
