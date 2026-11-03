import type { AgentId } from "@drizzle-run/core/connect";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, type SnapshotFrom } from "xstate";

import { NO_LOCKDOWN, type PreparedTurn } from "./agents/index.ts";
import { createConversationMachine, type ConversationServices, type TurnRequest } from "./conversation.ts";

function makeServices(): ConversationServices {
  return {
    send: vi.fn(async () => "sent" as const),
    log: vi.fn(),
    prepareTurn: vi.fn(),
    runTurn: vi.fn(),
  };
}

function makeTurn(agent: AgentId): TurnRequest {
  return {
    id: `turn-${agent}`,
    token: `token-${agent}`,
    tab: "tab1",
    agent,
    usableAgent: { ok: true, agent: { id: agent, name: agent }, command: agent, lockdown: NO_LOCKDOWN },
    tuning: {},
    scope: "project",
    message: { type: "chat.send", conversation: "project:p1", text: "Hi", mode: "ask" },
  };
}

const prepared: PreparedTurn = { args: [], stdin: "", cwd: "/tmp/turn" };
const cleanUpTurnOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The turn folder is locked.") };
const outcomes = {
  prepareTurn: { outputs: [prepared], error: new Error("The plugin could not write its files.") },
  cleanUpTurn: cleanUpTurnOutcome,
} satisfies Record<string, ActorOutcome<unknown>>;

const startClaudeTurn = { type: "turn.start", turn: makeTurn("claude") } as const;
const startCodexTurn = { type: "turn.start", turn: makeTurn("codex") } as const;
const endDone = { type: "agent.ended", end: { state: "done" } } as const;
const endStopped = { type: "agent.ended", end: { state: "stopped" } } as const;
const endFailed = { type: "agent.ended", end: { state: "failed", error: "The CLI crashed." } } as const;
const eventLabels = new Map<unknown, string>([
  [startClaudeTurn, "turn.start with Claude Code"],
  [startCodexTurn, "turn.start with Codex"],
  [endDone, "agent.ended done"],
  [endStopped, "agent.ended stopped"],
  [endFailed, "agent.ended failed"],
]);

const conversationMachine = createConversationMachine(makeServices());

function toModelState(snapshot: SnapshotFrom<typeof conversationMachine>) {
  const { agent, first, session, end } = snapshot.context;

  return {
    value: snapshot.value,
    agent: agent ?? "none",
    first,
    session: session !== undefined,
    end: end?.state ?? "none",
  };
}

function startConversation() {
  const settler = createActorSettler();
  const machine = createConversationMachine(makeServices()).provide({
    actors: {
      prepareTurn: settler.fromOutcome(outcomes.prepareTurn),
      agentTurn: fromCallback(() => {}),
      cleanUpTurn: settler.fromOutcome(outcomes.cleanUpTurn),
    },
  });

  return { actor: createActor(machine, { input: { id: "project:p1", tab: "tab1" } }).start(), settler };
}

const paths = getMachinePaths(conversationMachine, {
  input: { id: "project:p1", tab: "tab1" },
  toModelState,
  describeEvent: (event: ModelEvent) => eventLabels.get(event),
  events: (snapshot) => [
    startClaudeTurn,
    startCodexTurn,
    { type: "turn.stop" },
    { type: "agent.session", id: "session-1" },
    endDone,
    endStopped,
    endFailed,
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("conversation machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startConversation();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
