import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { createPeerHandshakeMachine, type PeerHandshakeEvent } from "./peer-handshake.ts";

/** A handshake whose sessions come from `sessions`, in order. Throws when it asks for one more. */
function startHandshake(...sessions: string[]) {
  const queue = [...sessions];
  const actor = createActor(
    createPeerHandshakeMachine({
      createSession: () => {
        const session = queue.shift();

        if (session === undefined) {
          throw new Error("Expected no more sessions to be made");
        }

        return session;
      },
    }),
  ).start();
  const decide = (event: PeerHandshakeEvent) => {
    actor.send(event);

    return actor.getSnapshot().context.outcome;
  };

  return { actor, decide };
}

/** A handshake that announced `local-1` and heard `peer-1` acknowledge it, with `later` sessions left to make. */
function startGreeted(...later: string[]) {
  const handshake = startHandshake("local-1", ...later);

  handshake.decide({ type: "hello.seal" });
  handshake.decide({ type: "hello.open", envelope: { s: "peer-1", a: "local-1" } });

  return handshake;
}

describe("peer handshake", () => {
  it("should announce once, then seal nothing but hellos until the peer answers", () => {
    const { actor, decide } = startHandshake("local-1");

    expect(decide({ type: "hello.seal" })).toEqual({ kind: "sealed", envelope: { s: "local-1", n: 0 } });
    expect(decide({ type: "hello.seal" })).toEqual({ kind: "sealed", envelope: { s: "local-1", n: 0 } });
    expect(actor.getSnapshot().matches("announced")).toBe(true);
    expect(decide({ type: "message.seal" })).toEqual({ kind: "not_ready" });
    expect(decide({ type: "message.open", envelope: { s: "peer-1", a: "local-1", n: 1 } })).toEqual({
      kind: "opened",
      verdict: { ok: false, reason: "unknown_peer" },
    });
  });

  it("should greet a peer that acknowledges this side's session, and count messages both ways", () => {
    const { actor, decide } = startGreeted();

    expect(actor.getSnapshot().matches("greeted")).toBe(true);
    expect(decide({ type: "message.seal" })).toEqual({ kind: "sealed", envelope: { s: "local-1", a: "peer-1", n: 1 } });
    expect(decide({ type: "message.open", envelope: { s: "peer-1", a: "local-1", n: 1 } })).toEqual({
      kind: "opened",
      verdict: { ok: true, answerHello: false },
    });
    expect(decide({ type: "message.open", envelope: { s: "peer-1", a: "local-1", n: 1 } })).toEqual({
      kind: "opened",
      verdict: { ok: false, reason: "replayed" },
    });
  });

  it("should ask for an answer from a peer heard first, minting this side's session then", () => {
    const { actor, decide } = startHandshake("local-1");

    expect(decide({ type: "hello.open", envelope: { s: "peer-1" } })).toEqual({
      kind: "opened",
      verdict: { ok: true, answerHello: true },
    });
    expect(actor.getSnapshot().context.local?.current).toBe("local-1");
  });

  it("should keep the count on a repeated hello, and refuse the session a peer left", () => {
    const { decide } = startGreeted();

    decide({ type: "message.open", envelope: { s: "peer-1", a: "local-1", n: 3 } });

    expect(decide({ type: "hello.open", envelope: { s: "peer-1", a: "local-1" } })).toEqual({
      kind: "opened",
      verdict: { ok: true, answerHello: false },
    });
    expect(decide({ type: "message.open", envelope: { s: "peer-1", a: "local-1", n: 3 } })).toMatchObject({
      verdict: { reason: "replayed" },
    });
    expect(decide({ type: "hello.open", envelope: { s: "peer-2", a: "local-1" } })).toEqual({
      kind: "opened",
      verdict: { ok: true, answerHello: false },
    });
    expect(decide({ type: "hello.open", envelope: { s: "peer-1", a: "local-1" } })).toEqual({
      kind: "opened",
      verdict: { ok: false, reason: "stale_session" },
    });
  });

  it("should take a new session of its own when a greeted peer comes back without acknowledging one", () => {
    const { actor, decide } = startGreeted("local-2");

    expect(decide({ type: "hello.open", envelope: { s: "peer-2" } })).toEqual({
      kind: "opened",
      verdict: { ok: true, answerHello: true },
    });
    expect(actor.getSnapshot().context.local?.current).toBe("local-2");
    expect(decide({ type: "message.open", envelope: { s: "peer-2", a: "local-1", n: 1 } })).toEqual({
      kind: "opened",
      verdict: { ok: false, reason: "stale_session" },
    });
  });
});
