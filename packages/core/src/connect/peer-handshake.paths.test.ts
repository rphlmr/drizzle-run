import {
  createActorSettler,
  getMachinePaths,
  type MachinePath,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createPeerHandshakeMachine } from "./peer-handshake.ts";

const FIRST_PEER_SESSION = "peer-1";
const SECOND_PEER_SESSION = "peer-2";

let mintedSessions = 0;

const handshakeMachine = createPeerHandshakeMachine({
  createSession: () => {
    mintedSessions += 1;

    return `local-${mintedSessions}`;
  },
});

type HandshakeSnapshot = SnapshotFrom<typeof handshakeMachine>;

const eventLabels = new WeakMap<object, string>();

function label<TEvent extends object>(event: TEvent, name: string) {
  eventLabels.set(event, name);

  return event;
}

function describeEvent(event: ModelEvent) {
  return eventLabels.get(event);
}

function getHelloOpenEvents(snapshot: HandshakeSnapshot) {
  const { local } = snapshot.context;
  const olderLocal = [...(local?.announced ?? [])].find((session) => session !== local?.current);

  return [
    label(
      { type: "hello.open", envelope: { s: FIRST_PEER_SESSION } } as const,
      "hello.open from the first peer session",
    ),
    label(
      { type: "hello.open", envelope: { s: FIRST_PEER_SESSION, a: local?.current } } as const,
      "hello.open from the first peer session acknowledging the current session",
    ),
    label(
      { type: "hello.open", envelope: { s: SECOND_PEER_SESSION } } as const,
      "hello.open from the second peer session",
    ),
    label(
      { type: "hello.open", envelope: { s: SECOND_PEER_SESSION, a: local?.current } } as const,
      "hello.open from the second peer session acknowledging the current session",
    ),
    ...(olderLocal === undefined
      ? []
      : [
          label(
            { type: "hello.open", envelope: { s: SECOND_PEER_SESSION, a: olderLocal } } as const,
            "hello.open from the second peer session acknowledging an older session",
          ),
        ]),
  ];
}

function getMessageOpenEvents(snapshot: HandshakeSnapshot) {
  const { local, peer } = snapshot.context;
  const lastSeq = peer?.lastSeq ?? 0;
  const session = peer?.session ?? FIRST_PEER_SESSION;
  const current = local?.current ?? "local-unknown";

  return [
    label(
      { type: "message.open", envelope: { s: session, a: current, n: lastSeq + 1 } } as const,
      "message.open the next message",
    ),
    label(
      { type: "message.open", envelope: { s: session, a: current, n: lastSeq } } as const,
      "message.open a replayed message",
    ),
    label(
      { type: "message.open", envelope: { s: session, a: "local-unknown", n: lastSeq + 1 } } as const,
      "message.open for another local session",
    ),
  ];
}

function toOutcomeName(snapshot: HandshakeSnapshot) {
  const { outcome } = snapshot.context;

  if (outcome === undefined || outcome.kind !== "opened") {
    return outcome?.kind ?? "none";
  }

  if (!outcome.verdict.ok) {
    return outcome.verdict.reason;
  }

  return outcome.verdict.answerHello ? "accepted_answer_hello" : "accepted";
}

function toModelState(snapshot: HandshakeSnapshot) {
  const { local, peer, replaced } = snapshot.context;

  return {
    value: snapshot.value,
    announced: Math.min(local?.announced.size ?? 0, 2),
    peer: peer?.session ?? "none",
    replaced: [...replaced].toSorted(),
    outcome: toOutcomeName(snapshot),
  };
}

function getSessionsMinted(path: MachinePath) {
  const sessions: string[] = [];

  for (const step of path.steps) {
    const snapshot: HandshakeSnapshot = step.state;

    for (const session of snapshot.context.local?.announced ?? []) {
      if (!sessions.includes(session)) {
        sessions.push(session);
      }
    }
  }

  return sessions;
}

function startHandshake(path: MachinePath) {
  const sessions = getSessionsMinted(path);
  const machine = createPeerHandshakeMachine({
    createSession: () => {
      const session = sessions.shift();

      if (session === undefined) {
        throw new Error(`Expected '${path.description}' to mint no more sessions`);
      }

      return session;
    },
  });

  return createActor(machine).start();
}

const paths = getMachinePaths(handshakeMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => {
    // Both walks of the graph mint sessions in the same order, so each one restarts the count at the initial state.
    if (snapshot.matches("unknown")) {
      mintedSessions = 0;
    }

    return [
      { type: "hello.seal" },
      { type: "message.seal" },
      ...getHelloOpenEvents(snapshot),
      ...getMessageOpenEvents(snapshot),
    ];
  },
});

describe("peer handshake machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const actor = startHandshake(path);

      await expect(
        replayMachinePath(path, { actor, settler: createActorSettler(), toModelState }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
