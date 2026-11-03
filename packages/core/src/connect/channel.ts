import { createActor } from "xstate";
import * as z from "zod/mini";

import { openText, sealText, toBase64Url } from "./crypto.ts";
import { readConnectMessage } from "./messages.ts";
import {
  createPeerHandshakeMachine,
  type HandshakeOutcome,
  type OpenFailure,
  type PeerHandshakeActor,
  type PeerHandshakeEvent,
} from "./peer-handshake.ts";
import type { ConnectMessage, ConnectRole } from "./protocol.ts";
import type { RandomBytes } from "./secret.ts";

export type { OpenFailure } from "./peer-handshake.ts";

/**
 * One side's end of the sealed link, per peer. Each connection picks a random session id
 * and says it in a `hello`. Every later message names both sessions and counts up, so a
 * relay that replays, reorders, or reflects sealed messages gets them dropped:
 *
 * - the associated data names the sender's role, so a tab's own message sent back to a tab fails to open;
 * - `ack` must be this side's current session, so messages from an older connection are refused;
 * - `seq` must grow per peer session, so a repeated message is refused.
 */

const ENVELOPE_VERSION = 1;

function getAssociatedData(sender: ConnectRole): string {
  return `drizzle-run/connect/v${ENVELOPE_VERSION}|from:${sender}`;
}

/** The result of `SecureChannel.open`: the message, or why it was refused. */
export type OpenResult =
  | {
      ok: true;
      message: ConnectMessage;
      /** A hello that does not acknowledge this side's session yet: answer with `hello`. */
      answerHello: boolean;
    }
  | { ok: false; reason: OpenFailure };

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const SESSION_ID_BYTES = 16;

/** The sealed JSON. Field names stay one letter because they are part of the wire format. */
const EnvelopeSchema = z.object({
  /** Envelope version. */
  v: z.literal(ENVELOPE_VERSION),
  /** The sender's session id. */
  s: z.string().check(z.regex(SESSION_ID_PATTERN)),
  /** The receiver's session id the sender acknowledges. */
  a: z.optional(z.string()),
  /** The sender's sequence number for this peer session. */
  n: z.number().check(z.int(), z.nonnegative()),
  /** The message. */
  m: z.optional(z.unknown()),
});

type Envelope = z.output<typeof EnvelopeSchema>;

/** Thrown by `SecureChannel.seal` before the peer said hello. */
export class ChannelNotReadyError extends Error {
  override name = "ChannelNotReadyError";
}

/** What a `SecureChannel` seals with: the derived key and this side's role. */
export interface SecureChannelOptions {
  key: CryptoKey;
  role: ConnectRole;
  subtle?: SubtleCrypto;
  random?: RandomBytes;
}

/**
 * One side's end of the sealed link
 *
 * Seals and opens messages for each peer, refusing replayed, reordered, reflected, or stale ones. This side announces
 * its own session to each peer, so messages sealed for one peer, or for an earlier session of the same peer, never
 * open under another peer id the relay makes up.
 */
export class SecureChannel {
  readonly role: ConnectRole;
  private readonly handshakes = new Map<string, PeerHandshakeActor>();
  private readonly options: SecureChannelOptions;
  private readonly getRandomBytes: RandomBytes;
  private readonly handshakeMachine = createPeerHandshakeMachine({ createSession: () => this.createSession() });

  // Sealing and opening are async; chaining them keeps sequence numbers in call order.
  private outgoing: Promise<unknown> = Promise.resolve();
  private incoming: Promise<unknown> = Promise.resolve();

  constructor(options: SecureChannelOptions) {
    this.options = options;
    this.role = options.role;
    this.getRandomBytes = options.random ?? ((bytes) => crypto.getRandomValues(bytes));
  }

  /** The peer said hello, so messages to it can be sealed. */
  ready(peer: string): boolean {
    return this.handshakes.get(peer)?.getSnapshot().matches("greeted") === true;
  }

  /** Drops what is known about a peer that left. */
  forget(peer: string): void {
    this.handshakes.get(peer)?.stop();
    this.handshakes.delete(peer);
  }

  private createSession(): string {
    return toBase64Url(this.getRandomBytes(new Uint8Array(SESSION_ID_BYTES)));
  }

  /** Send an event to the peer's handshake, started on first use, and return what it decided. */
  private decide(peer: string, event: PeerHandshakeEvent): HandshakeOutcome {
    let handshake = this.handshakes.get(peer);

    if (handshake === undefined) {
      handshake = createActor(this.handshakeMachine).start();
      this.handshakes.set(peer, handshake);
    }

    handshake.send(event);

    const { outcome } = handshake.getSnapshot().context;

    if (outcome === undefined) {
      throw new Error(`Expected the handshake to decide '${event.type}' for peer ${peer}`);
    }

    return outcome;
  }

  /** A sealed hello for `peer`, acknowledging its session when this side knows it. */
  async hello(peer: string, message: Extract<ConnectMessage, { type: "hello" }>): Promise<string> {
    const outcome = this.decide(peer, { type: "hello.seal" });

    if (outcome.kind !== "sealed") {
      throw new Error(`Expected a hello for peer ${peer} to be sealed, but got '${outcome.kind}'`);
    }

    return this.sealEnvelope({ v: ENVELOPE_VERSION, ...outcome.envelope, m: message });
  }

  /** Seals a message for `peer`. Throws `ChannelNotReadyError` before its hello. */
  async seal(peer: string, message: Exclude<ConnectMessage, { type: "hello" }>): Promise<string> {
    const outcome = this.decide(peer, { type: "message.seal" });

    if (outcome.kind !== "sealed") {
      throw new ChannelNotReadyError("The other side has not said hello yet.");
    }

    return this.sealEnvelope({ v: ENVELOPE_VERSION, ...outcome.envelope, m: message });
  }

  /** Opens a sealed message from `peer` and checks it belongs to the current sessions, in order. */
  open(peer: string, sealed: string): Promise<OpenResult> {
    const result = this.incoming.then(() => this.openNow(peer, sealed));

    this.incoming = result.catch(() => undefined);

    return result;
  }

  private async openNow(peer: string, sealed: string): Promise<OpenResult> {
    const sender: ConnectRole = this.role === "tab" ? "companion" : "tab";
    let envelopeJson: string;

    try {
      envelopeJson = await openText(this.options.key, sealed, getAssociatedData(sender), {
        subtle: this.options.subtle,
      });
    } catch {
      return { ok: false, reason: "undecryptable" };
    }

    let envelopeValue: unknown;

    try {
      envelopeValue = JSON.parse(envelopeJson);
    } catch {
      return { ok: false, reason: "malformed" };
    }

    const parsedEnvelope = EnvelopeSchema.safeParse(envelopeValue);

    if (!parsedEnvelope.success) {
      return { ok: false, reason: "malformed" };
    }

    const envelope = parsedEnvelope.data;
    const message = readConnectMessage(envelope.m);

    if (message === undefined) {
      return { ok: false, reason: "malformed" };
    }

    if (message.type === "hello" && message.role !== sender) {
      return { ok: false, reason: "malformed" };
    }

    const outcome = this.decide(peer, { type: message.type === "hello" ? "hello.open" : "message.open", envelope });

    if (outcome.kind !== "opened") {
      throw new Error(`Expected a message from peer ${peer} to be opened, but got '${outcome.kind}'`);
    }

    const { verdict } = outcome;

    return verdict.ok ? { ok: true, message, answerHello: verdict.answerHello } : verdict;
  }

  private sealEnvelope(envelope: Envelope): Promise<string> {
    const result = this.outgoing.then(() =>
      sealText(this.options.key, JSON.stringify(envelope), getAssociatedData(this.role), {
        subtle: this.options.subtle,
        random: this.options.random,
      }),
    );

    this.outgoing = result.catch(() => undefined);

    return result;
  }
}
