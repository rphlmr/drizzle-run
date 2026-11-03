import * as z from "zod/mini";

import {
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  getEmbedFramePath,
  parseEmbedConnectMessage,
  type EmbedFrameMessage,
  type EmbedTarget,
} from "../embed-loader/protocol";

/** The parent page the embed answers: the nonce it sent and its origin. */
export interface EmbedConnection {
  nonce: string;
  origin: string;
}

type WithoutEnvelope<Message> = Message extends unknown ? Omit<Message, "protocol" | "version" | "nonce"> : never;

/** A message to the parent, without the envelope the bridge adds. */
export type EmbedEvent = WithoutEnvelope<EmbedFrameMessage>;

const BootstrapParametersSchema = z.tuple([z.tuple([z.literal("nonce"), z.string().check(z.regex(/^[a-f0-9]{32}$/))])]);

function readBootstrapNonce(hash: string): string | undefined {
  const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const parsed = BootstrapParametersSchema.safeParse([...parameters.entries()]);

  return parsed.success ? parsed.data[0][1] : undefined;
}

/** What the bridge reports about parents that ask to connect. */
export interface EmbedBridgeListeners {
  /** A parent whose message carries the address's nonce and names this frame's target. */
  onConnect: (connection: EmbedConnection) => void;
  /** Such a parent on an opaque (`"null"`) origin, such as a `file://` page, which cannot be answered by origin. */
  onOpaqueConnect: (nonce: string) => void;
}

/** The embed's side of the parent page protocol: it checks connects and posts messages, and keeps no state. */
export interface EmbedBridge {
  start(listeners: EmbedBridgeListeners): void;
  dispose(): void;
  post(connection: EmbedConnection, event: EmbedEvent): void;
  /** Tells an opaque parent it cannot connect; the message holds only the code and the nonce that parent sent. */
  postUnsupportedHost(nonce: string): void;
}

/**
 * Create the bridge to the parent page
 *
 * Once started, it greets the parent with the nonce from the address and hears connects only from the parent window,
 * carrying that nonce and naming this frame's target.
 */
export function createEmbedBridge(target: EmbedTarget): EmbedBridge {
  const framePath = getEmbedFramePath(target);
  let handleMessage: ((event: MessageEvent<unknown>) => void) | undefined;

  return {
    start(listeners) {
      if (handleMessage !== undefined || typeof window === "undefined") {
        return;
      }

      const bootstrapNonce = readBootstrapNonce(window.location.hash);

      handleMessage = (event) => {
        if (window.parent === window || event.source !== window.parent || bootstrapNonce === undefined) {
          return;
        }

        const message = parseEmbedConnectMessage(event.data);

        if (
          message === null ||
          getEmbedFramePath(message) !== framePath ||
          message.nonce !== bootstrapNonce ||
          window.location.pathname !== framePath
        ) {
          return;
        }

        if (event.origin === "null") {
          listeners.onOpaqueConnect(message.nonce);
          return;
        }

        listeners.onConnect({ nonce: message.nonce, origin: event.origin });
      };
      window.addEventListener("message", handleMessage);

      if (bootstrapNonce !== undefined && window.parent !== window) {
        window.parent.postMessage(
          {
            protocol: EMBED_PROTOCOL,
            version: EMBED_PROTOCOL_VERSION,
            kind: "hello",
            nonce: bootstrapNonce,
          },
          "*",
        );
      }
    },
    dispose() {
      if (handleMessage === undefined || typeof window === "undefined") {
        return;
      }

      window.removeEventListener("message", handleMessage);
      handleMessage = undefined;
    },
    post(connection, event) {
      if (typeof window === "undefined") {
        return;
      }

      const envelope = { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce: connection.nonce } as const;
      window.parent.postMessage({ ...envelope, ...event } satisfies EmbedFrameMessage, connection.origin);
    },
    postUnsupportedHost(nonce) {
      const message = {
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        kind: "error",
        nonce,
        code: "unsupported_host",
      } satisfies EmbedFrameMessage;
      window.parent.postMessage(message, "*");
    },
  };
}
