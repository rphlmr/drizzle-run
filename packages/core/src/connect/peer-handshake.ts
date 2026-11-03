import { assign, setup, type ActorRefFrom } from "xstate";

import { declareType } from "./declare-type.ts";

/**
 * One peer's handshake on a sealed link. A peer is `unknown` until this side says hello to it (`announced`) or hears
 * its hello (`greeted`). `SecureChannel` runs one machine per peer and only does the crypto: each event leaves its
 * result in `outcome`, read right after the send.
 */

/** Why `SecureChannel.open` refused a sealed message. */
export type OpenFailure = "undecryptable" | "malformed" | "unknown_peer" | "stale_session" | "replayed";

/** This side's sessions for one peer: the one it uses now, and every one it announced to that peer. */
interface LocalSessions {
  current: string;
  announced: ReadonlySet<string>;
}

/** The peer's session as this side heard it, with the counts in both directions. */
interface PeerSession {
  session: string;
  lastSeq: number;
  sentSeq: number;
}

/** The session and acknowledgement fields of an envelope. */
export interface EnvelopeSessions {
  /** The sender's session. */
  s: string;
  /** The receiver's session the sender acknowledges. */
  a?: string;
}

/** What a transition that opens a message decided. */
export type HandshakeVerdict = { ok: true; answerHello: boolean } | { ok: false; reason: OpenFailure };

/** What the last event decided: the envelope fields to seal, that nothing can be sealed yet, or an open's verdict. */
export type HandshakeOutcome =
  | { kind: "sealed"; envelope: EnvelopeSessions & { n: number } }
  | { kind: "not_ready" }
  | { kind: "opened"; verdict: HandshakeVerdict };

interface PeerHandshakeContext {
  /** Minted on the first hello either way. */
  local: LocalSessions | undefined;
  peer: PeerSession | undefined;
  /** The sessions the peer left for a newer one: a real peer never goes back to one, so only a replay brings it back. */
  replaced: ReadonlySet<string>;
  outcome: HandshakeOutcome | undefined;
}

/** What `SecureChannel` asks of a peer's handshake. */
export type PeerHandshakeEvent =
  | { type: "hello.seal" }
  | { type: "message.seal" }
  | { type: "hello.open"; envelope: EnvelopeSessions }
  | { type: "message.open"; envelope: EnvelopeSessions & { n: number } };

/** What a handshake needs from its channel. */
export interface PeerHandshakeServices {
  /** A new random session id. */
  createSession(): string;
}

function assertLocal(context: PeerHandshakeContext): LocalSessions {
  if (context.local === undefined) {
    throw new Error("Expected this side to have announced a session to the peer");
  }

  return context.local;
}

function assertPeer(context: PeerHandshakeContext): PeerSession {
  if (context.peer === undefined) {
    throw new Error("Expected the peer to have said hello");
  }

  return context.peer;
}

function getEnvelope(event: PeerHandshakeEvent): EnvelopeSessions & { n?: number } {
  if (event.type !== "hello.open" && event.type !== "message.open") {
    throw new Error(`Expected an event that opens an envelope, but got '${event.type}'`);
  }

  return event.envelope;
}

/**
 * Build a peer's handshake machine
 *
 * A new session from the peer starts its count again; a repeated hello keeps the count. A greeted peer back under
 * another session, such as a replayed hello, gets a new session from this side unless its hello acknowledges one
 * this side announced, so nothing sealed for the old one opens. A peer heard from for the first time can only hold
 * sessions announced to it since it joined, so hellos crossing on the wire settle in one answer each.
 */
export function createPeerHandshakeMachine(services: PeerHandshakeServices) {
  return setup({
    types: {
      context: declareType<PeerHandshakeContext>(),
      events: declareType<PeerHandshakeEvent>(),
    },
    guards: {
      isReplacedSession: ({ context, event }) => context.replaced.has(getEnvelope(event).s),
      isSamePeerSession: ({ context, event }) => context.peer?.session === getEnvelope(event).s,
      isAcknowledged: ({ context, event }) => {
        const acknowledged = getEnvelope(event).a;

        return acknowledged !== undefined && assertLocal(context).announced.has(acknowledged);
      },
      isForOtherSessions: ({ context, event }) => {
        const envelope = getEnvelope(event);

        return envelope.s !== assertPeer(context).session || envelope.a !== assertLocal(context).current;
      },
      isReplayed: ({ context, event }) => (getEnvelope(event).n ?? 0) <= assertPeer(context).lastSeq,
    },
    actions: {
      announce: assign({
        local: ({ context }) => {
          const session = services.createSession();

          return { current: session, announced: new Set([...(context.local?.announced ?? []), session]) };
        },
      }),
      greet: assign({
        peer: ({ event }) => ({ session: getEnvelope(event).s, lastSeq: 0, sentSeq: 0 }),
      }),
      replacePeerSession: assign({
        replaced: ({ context }) => new Set([...context.replaced, assertPeer(context).session]),
        peer: ({ event }) => ({ session: getEnvelope(event).s, lastSeq: 0, sentSeq: 0 }),
      }),
      countSent: assign({
        peer: ({ context }) => {
          const peer = assertPeer(context);

          return { ...peer, sentSeq: peer.sentSeq + 1 };
        },
      }),
      countReceived: assign({
        peer: ({ context, event }) => ({ ...assertPeer(context), lastSeq: getEnvelope(event).n ?? 0 }),
      }),
      sayHello: assign({
        outcome: ({ context }) => ({
          kind: "sealed" as const,
          envelope: {
            s: assertLocal(context).current,
            ...(context.peer ? { a: context.peer.session } : {}),
            n: 0,
          },
        }),
      }),
      sayMessage: assign({
        outcome: ({ context }) => {
          const peer = assertPeer(context);

          return {
            kind: "sealed" as const,
            envelope: { s: assertLocal(context).current, a: peer.session, n: peer.sentSeq },
          };
        },
      }),
      refuseSeal: assign({ outcome: { kind: "not_ready" } }),
      acceptHello: assign({
        outcome: ({ context, event }) => ({
          kind: "opened" as const,
          verdict: { ok: true as const, answerHello: getEnvelope(event).a !== assertLocal(context).current },
        }),
      }),
      acceptMessage: assign({ outcome: { kind: "opened", verdict: { ok: true, answerHello: false } } }),
      refuseOpen: assign({
        outcome: (_, params: { reason: OpenFailure }) => ({
          kind: "opened" as const,
          verdict: { ok: false as const, reason: params.reason },
        }),
      }),
    },
  }).createMachine({
    id: "peerHandshake",
    initial: "unknown",
    context: { local: undefined, peer: undefined, replaced: new Set(), outcome: undefined },
    on: {
      "message.seal": { actions: "refuseSeal" },
      "message.open": { actions: { type: "refuseOpen", params: { reason: "unknown_peer" } } },
    },
    states: {
      unknown: {
        on: {
          "hello.seal": { target: "announced", actions: ["announce", "sayHello"] },
          "hello.open": { target: "greeted", actions: ["announce", "greet", "acceptHello"] },
        },
      },
      announced: {
        on: {
          "hello.seal": { actions: "sayHello" },
          "hello.open": { target: "greeted", actions: ["greet", "acceptHello"] },
        },
      },
      greeted: {
        on: {
          "hello.seal": { actions: "sayHello" },
          "hello.open": [
            { guard: "isReplacedSession", actions: { type: "refuseOpen", params: { reason: "stale_session" } } },
            { guard: "isSamePeerSession", actions: "acceptHello" },
            { guard: "isAcknowledged", actions: ["replacePeerSession", "acceptHello"] },
            { actions: ["announce", "replacePeerSession", "acceptHello"] },
          ],
          "message.seal": { actions: ["countSent", "sayMessage"] },
          "message.open": [
            { guard: "isForOtherSessions", actions: { type: "refuseOpen", params: { reason: "stale_session" } } },
            { guard: "isReplayed", actions: { type: "refuseOpen", params: { reason: "replayed" } } },
            { actions: ["countReceived", "acceptMessage"] },
          ],
        },
      },
    },
  });
}

/** A running peer handshake. */
export type PeerHandshakeActor = ActorRefFrom<ReturnType<typeof createPeerHandshakeMachine>>;
