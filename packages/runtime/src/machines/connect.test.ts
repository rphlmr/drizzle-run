import {
  deriveConnectKeys,
  roomProtocols,
  RELAY_CLOSE,
  SecureChannel,
  type CompanionInfo,
  type ConnectMessage,
  type ConnectToolScope,
  type RelayServerFrame,
} from "@drizzle-run/core/connect";
import { delay } from "es-toolkit";
import { describe, expect, it, vi } from "vitest";
import { createActor, setup, waitFor } from "xstate";

import { createLinkMachine, LINK_ID } from "./connect-actors.ts";
import type {
  ConnectEmitted,
  ConnectOpenProject,
  ConnectPairing,
  ConnectServices,
  ConnectSocketHandlers,
  ConnectToolOutcome,
  ConnectToolRequest,
  LinkCommand,
  LinkEvent,
  PendingEdit,
} from "./connect-contract.ts";
import { connectQuota, connectStatus, createConnectMachine, refusedEditSummary, workingTurn } from "./connect.ts";
import { declareType } from "./declare-type.ts";

const SECRET = "k7Pq-2xZm-9fLw";
const ITERATIONS = 1_000;
const TAB = "tab1";
const COMPANION = "comp1";

type Message = Exclude<ConnectMessage, { type: "hello" }>;

/** The relay and the companion at once: the test plays the companion through a real channel. */
class FakeRoom {
  handlers: ConnectSocketHandlers | undefined;
  url = "";
  closed: { code?: number } | undefined;
  /** Raw frames the tab sent, as the relay sees them. */
  frames: string[] = [];
  received: Message[] = [];
  channel: SecureChannel | undefined;
  /** The relay's id for the companion in the room now. */
  companionId = COMPANION;
  private key: CryptoKey | undefined;

  async keys() {
    this.key ??= (await deriveConnectKeys(SECRET, { iterations: ITERATIONS })).key;
    return this.key;
  }

  protocols: readonly string[] = [];

  open = (url: string, handlers: ConnectSocketHandlers, protocols: readonly string[]) => {
    this.url = url;
    this.protocols = protocols;
    this.handlers = handlers;
    this.closed = undefined;

    return {
      send: (text: string) => {
        this.frames.push(text);
        void this.onTabFrame(text);
      },
      close: (code?: number) => {
        this.closed = { code };
      },
    };
  };

  server(frame: RelayServerFrame) {
    this.handlers?.message(JSON.stringify(frame));
  }

  welcome(withCompanion = false) {
    this.server({
      t: "welcome",
      id: TAB,
      role: "tab",
      peers: withCompanion ? [{ id: COMPANION, role: "companion" }] : [],
      maxFrameBytes: 524_288, // 512 KiB
    });
  }

  /** A companion joins and says hello, as `npx @drizzle-run/connect` does. */
  async join(
    companion: CompanionInfo = { version: "0.1.0", mode: "chat", agents: [{ id: "claude", name: "Claude Code" }] },
    protocol = { min: 1, max: 1 },
    peer = COMPANION,
  ) {
    this.companionId = peer;
    this.channel = new SecureChannel({ key: await this.keys(), role: "companion" });
    this.server({ t: "peer", event: "join", peer: { id: peer, role: "companion" } });

    const hello = await this.channel.hello(TAB, { type: "hello", role: "companion", protocol, companion });
    this.server({ t: "data", from: peer, d: hello });
  }

  async say(message: Message) {
    const sealed = await this.sealed(message);
    this.server({ t: "data", from: this.companionId, d: sealed });

    return sealed;
  }

  sealed(message: Message) {
    if (this.channel === undefined) {
      throw new Error("No companion yet.");
    }

    return this.channel.seal(TAB, message);
  }

  leave() {
    this.server({ t: "peer", event: "leave", peer: { id: this.companionId, role: "companion" } });
    this.channel = undefined;
  }

  private async onTabFrame(text: string) {
    const frame = JSON.parse(text) as { d: string };

    if (this.channel === undefined) {
      return;
    }

    const opened = await this.channel.open(TAB, frame.d);

    if (opened.ok && opened.message.type !== "hello") {
      this.received.push(opened.message);
    }
  }

  async next<Type extends Message["type"]>(type: Type): Promise<Extract<Message, { type: Type }>> {
    await vi.waitFor(() => {
      if (!this.received.some((message) => message.type === type)) {
        throw new Error(`Expected a ${type} message from the browser`);
      }
    });
    const index = this.received.findIndex((message) => message.type === type);
    const [message] = this.received.splice(index, 1);

    return message as Extract<Message, { type: Type }>;
  }
}

const readProject = async (): Promise<ConnectToolOutcome> => ({
  ok: true,
  result: { name: "Bank transfers" },
  summary: { label: "Read the project" },
});

function start(
  options: {
    pairing?: ConnectPairing;
    execute?: (request: ConnectToolRequest) => Promise<ConnectToolOutcome>;
    undo?: ConnectServices["undoEdit"];
    scope?: () => ConnectToolScope;
    /** The project open in the view; none by default. */
    project?: () => ConnectOpenProject | undefined;
    /** Edits a past page left pending. */
    storedEdits?: readonly PendingEdit[];
    /** Holds the save that confirms the pairing, as a busy browser's storage does. */
    confirmSave?: Promise<void>;
    /** Pairing saves that fail first, as a full disk does. */
    failSaves?: number;
  } = {},
) {
  const room = new FakeRoom();
  const savedEdits: (readonly PendingEdit[])[] = [];
  let stored = options.pairing;
  let failedSaves = 0;
  const saved: ConnectPairing[] = [];
  const execute = vi.fn(options.execute ?? readProject);
  const undo = vi.fn(options.undo ?? (async () => undefined));
  const clear = vi.fn(async () => {
    stored = undefined;
  });
  const services: ConnectServices = {
    loadPairing: async () => stored,
    savePairing: async (pairing) => {
      if (failedSaves < (options.failSaves ?? 0)) {
        failedSaves += 1;

        throw new Error("The disk is full.");
      }

      if (pairing.confirmedAt !== undefined) {
        await options.confirmSave;
      }

      stored = pairing;
      saved.push(pairing);
    },
    clearPairing: clear,
    roomUrl: (roomId) => `wss://run.test/api/connect/rooms/${roomId}?role=tab`,
    openSocket: room.open,
    executeTool: execute,
    undoEdit: undo,
    createSecret: () => SECRET,
    kdfIterations: ITERATIONS,
    ...(options.scope ? { toolScope: options.scope } : {}),
    ...(options.project ? { openProject: options.project } : {}),
    loadPendingEdits: async () => options.storedEdits ?? [],
    savePendingEdits: async (edits) => {
      savedEdits.push(edits);
    },
  };
  const emitted: ConnectEmitted[] = [];
  const actor = createActor(createConnectMachine(services));

  const emittedTypes = [
    "activity.added",
    "edit.requested",
    "edit.pending",
    "edit.kept",
    "edit.undone",
    "edit.undo.failed",
    "run.requested",
    "pairing.forgotten",
  ] as const;

  for (const type of emittedTypes) {
    actor.on(type, (event) => emitted.push(event));
  }

  actor.start();

  return { actor, room, saved, savedEdits, execute, undo, clear, emitted, stored: () => stored };
}

const paired: ConnectPairing = {
  secret: SECRET,
  pairedAt: "2026-10-15T10:00:00.000Z",
  confirmedAt: "2026-10-15T10:01:00.000Z",
};

async function connected(options: Parameters<typeof start>[0] = { pairing: paired }) {
  const started = start(options);

  await vi.waitFor(() => expect(started.room.handlers).toBeDefined());
  started.room.welcome();
  await started.room.join();
  await waitFor(started.actor, (snapshot) => snapshot.matches({ linked: "connected" }));
  await started.room.next("tab.active");

  return started;
}

/**
 * Connects with one pending edit, `edit-e1`, then holds the job queue with a slow tool call, so an Undo waits behind
 * it until `release()`.
 */
async function connectedWithBusyJobs(options: { undo?: ConnectServices["undoEdit"] } = {}) {
  const files = [{ path: "query.ts", before: "a", after: "b", added: 1, removed: 1 }];
  const blocker = Promise.withResolvers<ConnectToolOutcome>();
  const blocking = Promise.withResolvers<void>();
  let calls = 0;
  const started = await connected({
    pairing: paired,
    execute: async () => {
      calls += 1;

      if (calls === 2) {
        blocking.resolve();

        return blocker.promise;
      }

      return {
        ok: true,
        result: { files: ["query.ts"] },
        pendingEdit: { projectId: "p1", projectName: "Bank transfers", files },
      };
    },
    ...(options.undo ? { undo: options.undo } : {}),
  });

  started.actor.send({ type: "chat.mode.set", mode: "edit" });
  await started.room.say({
    type: "tool.call",
    id: "e1",
    name: "apply_edits",
    input: { edits: [{ path: "query.ts", new_text: "b" }] },
  });
  await started.room.next("tool.result");
  await started.room.say({ type: "tool.call", id: "e2", name: "read_file", input: { path: "query.ts" } });
  // The call reaches the queue once its frame is opened, so wait until it runs.
  await blocking.promise;

  return {
    ...started,
    release: async () => {
      blocker.resolve({ ok: true, result: {} });
      await delay(0);
    },
  };
}

function findEditRow(actor: Awaited<ReturnType<typeof connected>>["actor"], toolId: string) {
  return actor.getSnapshot().context.activity.find((entry) => entry.kind === "tool" && entry.id === toolId);
}

/** Chooses Claude Code and sends a chat message, so the chat's turns are bound to `project` in its mode. */
async function startChat(
  { actor, room }: Pick<Awaited<ReturnType<typeof connected>>, "actor" | "room">,
  conversation: string,
  options: { project?: { id: string; name: string; origin?: "community" }; scope?: ConnectToolScope } = {},
) {
  if (actor.getSnapshot().context.companion?.agent === undefined) {
    actor.send({ type: "chat.agent.choose", agent: "claude" });
    await room.next("agent.choose");
  }

  actor.send({ type: "chat.message.send", conversation, text: "Hi", ...options });

  return room.next("chat.send");
}

describe("connect machine", () => {
  it("should pair: create and save a secret, open its room, and show the command until a companion comes", async () => {
    const { actor, room, saved } = start();

    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "unpaired", reason: "fresh" });

    actor.send({ type: "pairing.create" });
    await vi.waitFor(() => expect(room.handlers).toBeDefined());

    const { roomId } = await deriveConnectKeys(SECRET, { iterations: ITERATIONS });

    expect(room.url).toBe(`wss://run.test/api/connect/rooms/${roomId}?role=tab`);
    expect(room.protocols).toEqual(
      roomProtocols((await deriveConnectKeys(SECRET, { iterations: ITERATIONS })).roomProof),
    );
    expect(saved).toEqual([{ secret: SECRET, pairedAt: expect.any(String) }]);
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "pairing", secret: SECRET, connecting: true });

    room.welcome();
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "waiting" }));
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "pairing", secret: SECRET, connecting: false });

    await room.join();
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connected" }));
    expect(saved.at(-1)?.confirmedAt).toEqual(expect.any(String));
    expect(connectStatus(actor.getSnapshot())).toMatchObject({
      kind: "choosing",
      companion: { agents: [{ id: "claude" }] },
    });
    expect(await room.next("tab.active")).toEqual({ type: "tab.active" });
    actor.stop();
  });

  it("should take chat while the first companion's confirmation is still saving", async () => {
    const confirmSave = Promise.withResolvers<void>();
    const { actor, room, saved } = start({ confirmSave: confirmSave.promise });

    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    actor.send({ type: "pairing.create" });
    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    room.welcome();
    await room.join({
      version: "0.1.0",
      mode: "chat",
      agents: [{ id: "claude", name: "Claude Code" }],
      agent: "claude",
    });
    await vi.waitFor(() =>
      expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "ready", agent: "claude" }),
    );

    actor.send({ type: "chat.message.send", conversation: "p1", text: "Hi", project: { id: "p1", name: "Bank" } });
    expect(await room.next("chat.send")).toMatchObject({ conversation: "p1", text: "Hi" });

    confirmSave.resolve();
    await vi.waitFor(() => expect(saved.at(-1)?.confirmedAt).toEqual(expect.any(String)));
    expect(actor.getSnapshot().context.pairing?.confirmedAt).toEqual(expect.any(String));
    actor.stop();
  });

  it("should rejoin a remembered pairing on its own and say hello to a companion already there", async () => {
    const { actor, room } = start({ pairing: paired });

    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "waiting", connecting: true });

    room.channel = new SecureChannel({ key: await room.keys(), role: "companion" });
    room.welcome(true);
    await vi.waitFor(() => expect(room.frames).toHaveLength(1));
    expect(await room.channel.open(TAB, (JSON.parse(room.frames[0] ?? "{}") as { d: string }).d)).toMatchObject({
      ok: true,
      message: { type: "hello", role: "tab" },
    });
    actor.stop();
  });

  it("should send the chosen agent's model and effort, and leave out a choice that agent does not offer", async () => {
    const { actor, room } = start({ pairing: paired });

    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    room.welcome();
    await room.join({
      version: "0.1.0",
      mode: "chat",
      agents: [{ id: "claude", name: "Claude Code", models: [{ id: "opus", name: "Opus", efforts: ["high"] }] }],
      agent: "claude",
    });
    await vi.waitFor(() => expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "ready" }));

    actor.send({
      type: "chat.message.send",
      conversation: "p1",
      text: "Hi",
      tuning: { model: "opus", effort: "high" },
    });
    expect(await room.next("chat.send")).toMatchObject({ model: "opus", effort: "high" });

    actor.send({
      type: "chat.message.send",
      conversation: "p1",
      text: "Again",
      tuning: { model: "sonnet", effort: "high" },
    });

    const stale = await room.next("chat.send");

    expect(stale).not.toHaveProperty("model");
    expect(stale).not.toHaveProperty("effort");
    actor.stop();
  });

  it("should send a chat to its own agent with the chat so far, and to the companion's choice when not offered", async () => {
    const { actor, room } = start({ pairing: paired });

    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    room.welcome();
    await room.join({
      version: "0.1.0",
      mode: "chat",
      agents: [
        { id: "claude", name: "Claude Code" },
        { id: "codex", name: "Codex", models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["medium"] }] },
      ],
      agent: "claude",
    });
    await vi.waitFor(() => expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "ready" }));

    actor.send({
      type: "chat.message.send",
      conversation: "p1",
      text: "Hi",
      agent: "codex",
      tuning: { model: "gpt-6-luna", effort: "medium" },
      context: [{ from: "user", text: "One" }],
    });
    expect(await room.next("chat.send")).toMatchObject({
      agent: "codex",
      model: "gpt-6-luna",
      effort: "medium",
      context: [{ from: "user", text: "One" }],
    });
    expect(actor.getSnapshot().context.companion?.agent).toBe("claude");

    await room.join({
      version: "0.1.0",
      mode: "chat",
      agents: [{ id: "claude", name: "Claude Code" }],
      agent: "claude",
    });
    await vi.waitFor(() => expect(actor.getSnapshot().context.companion?.agents).toHaveLength(1));
    actor.send({
      type: "chat.message.send",
      conversation: "p1",
      text: "Again",
      agent: "codex",
      tuning: { model: "gpt-6-luna" },
    });

    const fallback = await room.next("chat.send");

    expect(fallback).toMatchObject({ agent: "claude" });
    expect(fallback).not.toHaveProperty("model");
    actor.stop();
  });

  it("should choose an agent, send chat in the current mode, and stream the answer into one message", async () => {
    const { actor, room, emitted } = await connected();

    actor.send({ type: "chat.agent.choose", agent: "codex" });
    expect(actor.getSnapshot().context.companion?.agent).toBeUndefined();

    actor.send({ type: "chat.agent.choose", agent: "claude" });
    expect(await room.next("agent.choose")).toEqual({ type: "agent.choose", agent: "claude" });
    expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "ready", agent: "claude" });

    actor.send({ type: "chat.mode.set", mode: "edit" });
    actor.send({
      type: "chat.message.send",
      conversation: "p1",
      text: "Move 130 instead",
      project: { id: "p1", name: "Bank transfers" },
    });
    expect(await room.next("chat.send")).toEqual({
      type: "chat.send",
      conversation: "p1",
      text: "Move 130 instead",
      mode: "edit",
      project: { id: "p1", name: "Bank transfers" },
      agent: "claude",
    });

    await room.say({ type: "agent.turn", conversation: "p1", turn: "t1", state: "started" });
    await room.say({ type: "agent.text", conversation: "p1", turn: "t1", text: "Ada starts " });
    await room.say({ type: "agent.text", conversation: "p1", turn: "t1", text: "with 100." });
    await vi.waitFor(() =>
      expect(actor.getSnapshot().context.activity.at(-1)).toMatchObject({ kind: "text", text: "Ada starts with 100." }),
    );
    expect(workingTurn(actor.getSnapshot().context.activity, "p1")).toBe("t1");

    await room.say({ type: "agent.turn", conversation: "p1", turn: "t1", state: "done" });
    await vi.waitFor(() => expect(workingTurn(actor.getSnapshot().context.activity, "p1")).toBeUndefined());

    actor.send({ type: "chat.turn.stop", conversation: "p1" });
    expect(await room.next("chat.stop")).toEqual({ type: "chat.stop", conversation: "p1" });
    expect(
      emitted
        .filter((event) => event.type === "activity.added")
        .map((event) => event.type === "activity.added" && event.activity.kind),
    ).toEqual(["user", "turn", "text", "text", "turn"]);
    actor.stop();
  });

  it("should ignore chat before an agent is chosen, and empty or oversized messages", async () => {
    const { actor, room } = await connected();

    actor.send({ type: "chat.message.send", conversation: "p1", text: "hi" });
    actor.send({ type: "chat.agent.choose", agent: "claude" });
    await room.next("agent.choose");
    actor.send({ type: "chat.message.send", conversation: "p1", text: "  " });
    actor.send({ type: "chat.message.send", conversation: "p1", text: "x".repeat(20_001) });
    await delay(50);
    expect(room.received).toEqual([]);
    actor.stop();
  });

  it("should execute a checked tool call and answer with its result", async () => {
    const { actor, room, execute } = await connected();

    await startChat({ actor, room }, "p1");
    await room.say({
      type: "tool.call",
      id: "call1",
      name: "read_file",
      input: { path: "query.ts" },
      conversation: "p1",
    });
    expect(await room.next("tool.result")).toEqual({
      type: "tool.result",
      id: "call1",
      ok: true,
      result: { name: "Bank transfers" },
    });
    expect(execute).toHaveBeenCalledWith(
      {
        id: "call1",
        call: { name: "read_file", input: { path: "query.ts" } },
        conversation: "p1",
        mode: "ask",
      },
      expect.any(AbortSignal),
    );
    expect(actor.getSnapshot().context.activity.at(-1)).toMatchObject({
      kind: "tool",
      id: "call1",
      status: "done",
      summary: { label: "Read the project" },
    });
    actor.stop();
  });

  it("should answer invalid input and failures without crashing, and refuse results too large to carry", async () => {
    const { actor, room, execute } = await connected({
      pairing: paired,
      execute: async (request) =>
        request.call.name === "get_problems"
          ? { ok: true, result: { text: "x".repeat(400_000) } }
          : Promise.reject(new Error("The editor is not ready.")),
    });

    await room.say({ type: "tool.call", id: "bad", name: "read_file", input: { file: "query.ts" } });
    expect(await room.next("tool.result")).toMatchObject({ id: "bad", ok: false, error: { code: "invalid_input" } });
    expect(execute).not.toHaveBeenCalled();

    await room.say({ type: "tool.call", id: "boom", name: "get_project", input: {} });
    expect(await room.next("tool.result")).toEqual({
      type: "tool.result",
      id: "boom",
      ok: false,
      error: { code: "failed", message: "The editor is not ready." },
    });

    await room.say({ type: "tool.call", id: "big", name: "get_problems", input: {} });
    expect(await room.next("tool.result")).toMatchObject({
      id: "big",
      ok: false,
      error: { code: "failed", message: expect.stringContaining("Ask for less") },
    });
    actor.stop();
  });

  it("should answer a tool a newer companion calls with unknown_tool, without running anything", async () => {
    const { actor, room, execute } = await connected();
    const futureCall = JSON.parse('{ "type": "tool.call", "id": "f1", "name": "future_tool", "input": {} }');

    await room.say(futureCall);

    expect(await room.next("tool.result")).toMatchObject({ id: "f1", ok: false, error: { code: "unknown_tool" } });
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should answer a tool call whose host throws before returning a promise, and run the next one", async () => {
    let calls = 0;
    const { actor, room } = await connected({
      pairing: paired,
      execute: () => {
        calls += 1;

        if (calls === 1) {
          throw new Error("The view is gone.");
        }

        return readProject();
      },
    });

    await room.say({ type: "tool.call", id: "sync", name: "get_project", input: {} });
    expect(await room.next("tool.result")).toMatchObject({
      id: "sync",
      ok: false,
      error: { code: "failed", message: "The view is gone." },
    });

    await room.say({ type: "tool.call", id: "next", name: "get_project", input: {} });
    expect(await room.next("tool.result")).toMatchObject({ id: "next", ok: true });
    actor.stop();
  });

  it("should refuse edit tools in Ask mode and say the chat needs Edit", async () => {
    const { actor, room, execute, emitted } = await connected();

    await startChat({ actor, room }, "p1");
    await room.say({
      type: "tool.call",
      id: "e1",
      name: "apply_edits",
      input: { edits: [{ path: "query.ts", new_text: "x" }] },
      conversation: "p1",
    });
    expect(await room.next("tool.result")).toMatchObject({
      id: "e1",
      ok: false,
      error: { code: "edit_mode_required" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({ type: "edit.requested", tool: "apply_edits", conversation: "p1" });
    expect(actor.getSnapshot().context.activity.at(-1)).toMatchObject({
      kind: "tool",
      status: "refused",
      summary: { label: "Edit", target: "query.ts" },
    });
    actor.stop();
  });

  it("should refuse tools the open view does not offer before anything else, in Edit mode too, without asking for edits", async () => {
    let scope: ConnectToolScope = "guide";
    const { actor, room, execute, emitted } = await connected({ pairing: paired, scope: () => scope });

    actor.send({ type: "chat.mode.set", mode: "edit" });
    await startChat({ actor, room }, "g-transactions", { scope: "guide" });

    for (const [id, name] of [
      ["g1", "apply_edits"],
      ["g2", "run"],
      ["g3", "switch_release"],
      ["g4", "set_query_plans_settings"],
    ] as const) {
      await room.say({
        type: "tool.call",
        id,
        name,
        input:
          name === "apply_edits"
            ? { edits: [{ path: "query.ts", new_text: "x" }] }
            : name === "switch_release"
              ? { orm_version: "0.45.4" }
              : {},
        conversation: "g-transactions",
      });
      expect(await room.next("tool.result")).toMatchObject({
        id,
        ok: false,
        error: { code: "unavailable", message: expect.stringContaining("not available during a guide") },
      });
    }

    await room.say({ type: "tool.call", id: "g5", name: "get_guide", input: {}, conversation: "g-transactions" });
    expect(await room.next("tool.result")).toMatchObject({ id: "g5", ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(emitted.some((event) => event.type === "edit.requested")).toBe(false);

    scope = "project";
    await room.say({
      type: "tool.call",
      id: "p1",
      name: "read_docs",
      input: { url: "/docs/select" },
      conversation: "p-1",
    });
    expect(await room.next("tool.result")).toMatchObject({ id: "p1", ok: false, error: { code: "unavailable" } });
    actor.stop();
  });

  it("should send a guided chat with its scope, always in Ask mode", async () => {
    const { actor, room } = await connected();

    actor.send({ type: "chat.agent.choose", agent: "claude" });
    await room.next("agent.choose");
    actor.send({ type: "chat.mode.set", mode: "edit" });
    actor.send({ type: "chat.message.send", conversation: "g-transactions", text: "Why?", scope: "guide" });
    expect(await room.next("chat.send")).toEqual({
      type: "chat.send",
      conversation: "g-transactions",
      text: "Why?",
      mode: "ask",
      scope: "guide",
      agent: "claude",
    });
    actor.send({ type: "chat.message.send", conversation: "p1", text: "Change it", scope: "project" });
    expect(await room.next("chat.send")).toMatchObject({ mode: "edit", scope: "project" });
    actor.stop();
  });

  it("should refuse a call from a chat this tab never started", async () => {
    const { actor, room, execute } = await connected();

    await room.say({ type: "tool.call", id: "c1", name: "get_project", input: {}, conversation: "p-elsewhere" });
    expect(await room.next("tool.result")).toMatchObject({
      id: "c1",
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("not started in this tab") },
    });
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should keep an injected turn on its own project in its own mode after the user opens another project in Edit mode", async () => {
    let open: ConnectOpenProject = { id: "community", name: "Free tips", origin: "community" };
    const { actor, room, execute } = await connected({ pairing: paired, project: () => open });

    await startChat({ actor, room }, "p-community", {
      project: { id: "community", name: "Free tips", origin: "community" },
    });
    await room.say({ type: "agent.turn", conversation: "p-community", turn: "t1", state: "started" });
    await vi.waitFor(() => expect(workingTurn(actor.getSnapshot().context.activity, "p-community")).toBe("t1"));

    open = { id: "mine", name: "My shop" };
    actor.send({ type: "chat.mode.set", mode: "edit", conversation: "p-mine" });
    actor.send({ type: "view.changed" });
    expect(await room.next("chat.stop")).toEqual({ type: "chat.stop", conversation: "p-community" });

    const edit = { edits: [{ path: "query.ts", new_text: "await fetch('https://evil.example')" }] };

    await room.say({ type: "tool.call", id: "x1", name: "apply_edits", input: edit, conversation: "p-community" });
    expect(await room.next("tool.result")).toMatchObject({
      id: "x1",
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("left this chat's project") },
    });

    open = { id: "community", name: "Free tips", origin: "community" };
    await room.say({ type: "tool.call", id: "x2", name: "apply_edits", input: edit, conversation: "p-community" });
    expect(await room.next("tool.result")).toMatchObject({
      id: "x2",
      ok: false,
      error: { code: "edit_mode_required" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(actor.getSnapshot().context.chats).toEqual({
      "p-community": { projectId: "community", mode: "ask" },
      "p-mine": { projectId: undefined, mode: "edit" },
    });
    actor.stop();
  });

  it("should name the checked project on each request, so the host refuses it if another project opens first", async () => {
    const { actor, room, execute } = await connected({ pairing: paired, project: () => ({ id: "p1" }) });

    await startChat({ actor, room }, "p-1", { project: { id: "p1", name: "Bank" } });
    await room.say({ type: "tool.call", id: "c1", name: "get_project", input: {}, conversation: "p-1" });
    await room.next("tool.result");
    await room.say({ type: "tool.call", id: "c2", name: "get_project", input: {} });
    await room.next("tool.result");
    expect(execute.mock.calls.map(([request]) => request.projectId)).toEqual(["p1", "p1"]);
    actor.stop();
  });

  it("should keep a chat on its project after it created another, and keep the created project on the row", async () => {
    const { actor, room } = await connected({
      pairing: paired,
      project: () => ({ id: "p1", name: "Bank" }),
      execute: async () => ({
        ok: true,
        result: { id: "p2", url: "https://drizzle.run/p/p2" },
        summary: { label: "Created a project", target: "Shop", createdProject: { id: "p2", name: "Shop" } },
      }),
    });

    actor.send({ type: "chat.mode.set", mode: "edit" });
    await startChat({ actor, room }, "p-1", { project: { id: "p1", name: "Bank" } });
    await room.say({ type: "agent.turn", conversation: "p-1", turn: "t1", state: "started" });
    await room.say({
      type: "tool.call",
      id: "c1",
      name: "create_project",
      input: { name: "Shop", dialect: "sqlite" },
      conversation: "p-1",
    });
    expect(await room.next("tool.result")).toMatchObject({ id: "c1", ok: true });
    expect(actor.getSnapshot().context.chats["p-1"]).toEqual({ projectId: "p1", mode: "edit" });
    expect(actor.getSnapshot().context.activity.at(-1)).toMatchObject({
      kind: "tool",
      id: "c1",
      summary: { createdProject: { id: "p2", name: "Shop" } },
    });
    await delay(50);
    expect(room.received.some((message) => message.type === "chat.stop")).toBe(false);
    actor.stop();
  });

  it("should hold an agent's run of a community project until the user runs it, and answer when the user does not", async () => {
    const { actor, room, execute, emitted } = await connected({
      pairing: paired,
      project: () => ({ id: "community", name: "Free tips", origin: "community" }),
    });

    await startChat({ actor, room }, "p-community", {
      project: { id: "community", name: "Free tips", origin: "community" },
    });
    await room.say({ type: "agent.turn", conversation: "p-community", turn: "t1", state: "started" });

    await room.say({ type: "tool.call", id: "r1", name: "run", input: {}, conversation: "p-community" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingRuns.map((run) => run.id)).toEqual(["r1"]));
    expect(execute).not.toHaveBeenCalled();
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "run.requested",
        run: expect.objectContaining({ id: "r1", projectId: "community" }),
      }),
    );
    expect(actor.getSnapshot().context.activity.at(-1)).toMatchObject({ kind: "tool", id: "r1", status: "waiting" });

    actor.send({ type: "run.decline", id: "r1" });
    expect(await room.next("tool.result")).toMatchObject({
      id: "r1",
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("chose not to run") },
    });
    expect(execute).not.toHaveBeenCalled();

    await room.say({ type: "tool.call", id: "r2", name: "run", input: {}, conversation: "p-community" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingRuns).toHaveLength(1));
    actor.send({ type: "run.confirm", id: "r2" });
    expect(await room.next("tool.result")).toMatchObject({ id: "r2", ok: true });
    expect(execute).toHaveBeenCalledTimes(1);

    await room.say({ type: "tool.call", id: "r3", name: "run", input: {}, conversation: "p-community" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingRuns).toHaveLength(1));
    await room.say({ type: "agent.turn", conversation: "p-community", turn: "t1", state: "stopped" });
    expect(await room.next("tool.result")).toMatchObject({ id: "r3", ok: false });
    expect(actor.getSnapshot().context.pendingRuns).toEqual([]);
    actor.send({ type: "run.confirm", id: "r3" });
    await delay(50);
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should run a terminal agent's run of the user's own project at once", async () => {
    const { actor, room, execute } = await connected({ pairing: paired, project: () => ({ id: "mine" }) });

    await room.say({ type: "tool.call", id: "r1", name: "run", input: {} });
    expect(await room.next("tool.result")).toMatchObject({ id: "r1", ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should refuse a terminal agent's edits and runs on an untrusted project, and let it read", async () => {
    const { actor, room, execute } = await connected({
      pairing: paired,
      scope: () => "untrusted",
      project: () => ({ id: "fork", name: "Fork", origin: "community" }),
    });

    actor.send({ type: "chat.mode.set", mode: "edit" });

    for (const [id, name, input] of [
      ["u1", "apply_edits", { edits: [{ path: "query.ts", new_text: "x" }] }],
      ["u2", "run", {}],
      ["u3", "switch_release", { orm_version: "0.45.4" }],
      ["u4", "create_project", { name: "Mine", dialect: "sqlite" }],
    ] as const) {
      await room.say({ type: "tool.call", id, name, input });
      expect(await room.next("tool.result")).toMatchObject({
        id,
        ok: false,
        error: { code: "unavailable", message: expect.stringContaining("until the user presses Allow AI edits") },
      });
    }

    expect(execute).not.toHaveBeenCalled();
    await room.say({ type: "tool.call", id: "u5", name: "get_project", input: {} });
    expect(await room.next("tool.result")).toMatchObject({ id: "u5", ok: true });
    actor.stop();
  });

  it("should bring back edits a past page left pending, and keep each decision for the next page", async () => {
    const files = [{ path: "query.ts", before: "a", after: "b", added: 1, removed: 1 }];
    const stored: PendingEdit = {
      id: "edit-old",
      toolCallId: "old",
      createdAt: 1,
      projectId: "p1",
      projectName: "Bank",
      files,
    };
    const { actor, savedEdits } = start({ pairing: paired, storedEdits: [stored] });

    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingEdits).toEqual([stored]));
    actor.send({ type: "edit.keep", id: "edit-old" });
    await vi.waitFor(() => expect(savedEdits.at(-1)).toEqual([]));
    actor.stop();
  });

  it("should name what a refused edit would change, from its unchecked input", () => {
    expect(
      refusedEditSummary("apply_edits", {
        edits: [{ path: "query.ts" }, { path: "query.ts" }, { path: "schema.ts" }, { nope: 1 }],
      }),
    ).toEqual({ label: "Edit", target: "query.ts, schema.ts" });
    expect(refusedEditSummary("apply_edits", { edits: "all" })).toEqual({ label: "Edit" });
    expect(refusedEditSummary("switch_release", { orm_version: "1.0.0-rc.5" })).toEqual({
      label: "Switch release",
      target: "1.0.0-rc.5",
    });
    expect(refusedEditSummary("create_project", null)).toEqual({ label: "Create a project" });
    expect(refusedEditSummary("read_file", { path: "query.ts" })).toBeUndefined();
  });

  it("should keep an edit pending until Keep, and let Undo put the files back or report why it cannot", async () => {
    let undoFails = false;
    const files = [{ path: "query.ts", before: "a", after: "b", added: 1, removed: 1 }];
    const { actor, room, undo, emitted, savedEdits } = await connected({
      pairing: paired,
      execute: async () => ({
        ok: true,
        result: { files: ["query.ts"] },
        pendingEdit: { projectId: "p1", projectName: "Bank transfers", files },
      }),
      undo: async () => {
        if (undoFails) {
          throw new Error("query.ts changed since the edit.");
        }
      },
    });

    actor.send({ type: "chat.mode.set", mode: "edit" });

    for (const id of ["e1", "e2"]) {
      await room.say({
        type: "tool.call",
        id,
        name: "apply_edits",
        input: { edits: [{ path: "query.ts", new_text: "b" }] },
      });
      expect(await room.next("tool.result")).toEqual({
        type: "tool.result",
        id,
        ok: true,
        result: { files: ["query.ts"], edit_id: `edit-${id}`, status: "pending" },
      });
    }

    expect(actor.getSnapshot().context.pendingEdits.map((edit) => edit.id)).toEqual(["edit-e1", "edit-e2"]);
    expect(emitted.filter((event) => event.type === "edit.pending")).toHaveLength(2);
    await vi.waitFor(() => expect(savedEdits.at(-1)?.map((edit) => edit.id)).toEqual(["edit-e1", "edit-e2"]));

    actor.send({ type: "edit.keep", id: "edit-e1" });
    actor.send({ type: "edit.keep", id: "unknown" });
    expect(actor.getSnapshot().context.pendingEdits.map((edit) => edit.id)).toEqual(["edit-e2"]);
    expect(
      actor.getSnapshot().context.activity.find((entry) => entry.kind === "tool" && entry.id === "e1"),
    ).toMatchObject({ edit: { decision: "kept" } });
    await vi.waitFor(() => expect(savedEdits.at(-1)?.map((edit) => edit.id)).toEqual(["edit-e2"]));

    undoFails = true;
    actor.send({ type: "edit.undo", id: "edit-e2" });
    await vi.waitFor(() => expect(emitted.some((event) => event.type === "edit.undo.failed")).toBe(true));
    expect(actor.getSnapshot().context.pendingEdits).toHaveLength(1);
    expect(Object.keys(actor.getSnapshot().context.undoErrors)).toEqual(["edit-e2"]);

    undoFails = false;
    actor.send({ type: "edit.undo", id: "edit-e2" });
    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingEdits).toEqual([]));
    expect(undo).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().context.undoErrors).toEqual({});
    expect(emitted.some((event) => event.type === "edit.undone")).toBe(true);
    await vi.waitFor(() => expect(savedEdits.at(-1)).toEqual([]));
    actor.stop();
  });

  it("should drop an Undo still waiting behind a job when the edit is kept, and wait for one already running", async () => {
    const files = [{ path: "query.ts", before: "a", after: "b", added: 1, removed: 1 }];
    const blocker = Promise.withResolvers<ConnectToolOutcome>();
    const undoing = Promise.withResolvers<void>();
    let calls = 0;
    const { actor, room, undo, execute } = await connected({
      pairing: paired,
      execute: async () => {
        calls += 1;

        if (calls === 2) {
          return blocker.promise;
        }

        return {
          ok: true,
          result: { files: ["query.ts"] },
          pendingEdit: { projectId: "p1", projectName: "Bank transfers", files },
        };
      },
      undo: () => undoing.promise,
    });

    actor.send({ type: "chat.mode.set", mode: "edit" });
    await room.say({
      type: "tool.call",
      id: "e1",
      name: "apply_edits",
      input: { edits: [{ path: "query.ts", new_text: "b" }] },
    });
    await room.next("tool.result");
    await room.say({ type: "tool.call", id: "e2", name: "read_file", input: { path: "query.ts" } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    actor.send({ type: "edit.undo", id: "edit-e1" });
    actor.send({ type: "edit.keep", id: "edit-e1" });
    blocker.resolve({ ok: true, result: {} });
    await room.next("tool.result");
    await delay(0);

    expect(undo).not.toHaveBeenCalled();
    expect(actor.getSnapshot().context.pendingEdits).toEqual([]);

    await room.say({
      type: "tool.call",
      id: "e3",
      name: "apply_edits",
      input: { edits: [{ path: "query.ts", new_text: "b" }] },
    });
    await room.next("tool.result");
    actor.send({ type: "edit.undo", id: "edit-e3" });
    await vi.waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    actor.send({ type: "edit.keep", id: "edit-e3" });
    expect(actor.getSnapshot().context.pendingEdits.map((edit) => edit.id)).toEqual(["edit-e3"]);

    undoing.resolve();
    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingEdits).toEqual([]));
    expect(actor.getSnapshot().context.runningUndo).toBeUndefined();
    actor.stop();
  });

  it("should put files back once when Undo is pressed again while the first one waits", async () => {
    const { actor, undo, release } = await connectedWithBusyJobs();

    actor.send({ type: "edit.undo", id: "edit-e1" });
    actor.send({ type: "edit.undo", id: "edit-e1" });
    expect(actor.getSnapshot().context.queuedUndos).toEqual(["edit-e1"]);
    await release();

    await vi.waitFor(() => expect(actor.getSnapshot().context.pendingEdits).toEqual([]));
    expect(undo).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should still let Keep cancel a waiting Undo after the pairing is forgotten", async () => {
    const { actor, room, undo, release } = await connectedWithBusyJobs();

    actor.send({ type: "edit.undo", id: "edit-e1" });
    actor.send({ type: "pairing.forget" });
    await room.next("forget");
    await room.say({ type: "forgotten" });
    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    expect(actor.getSnapshot().context.queuedUndos).toEqual(["edit-e1"]);

    actor.send({ type: "edit.keep", id: "edit-e1" });
    await release();

    expect(undo).not.toHaveBeenCalled();
    expect(findEditRow(actor, "e1")).toMatchObject({ edit: { decision: "kept" } });
    actor.stop();
  });

  it("should drop a replayed tool call, so a relay cannot run a tool twice", async () => {
    const { actor, room, execute } = await connected();
    const sealed = await room.say({ type: "tool.call", id: "once", name: "get_project", input: {} });

    await room.next("tool.result");
    room.server({ t: "data", from: COMPANION, d: sealed });
    room.server({ t: "data", from: COMPANION, d: "garbage.payload" });
    room.server({ t: "data", from: "stranger", d: sealed });
    await delay(50);
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should read 'disconnected' when the companion stops, and connect again when it comes back", async () => {
    const { actor, room } = await connected();

    room.leave();
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "waiting" }));
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "disconnected", reconnecting: false });

    await room.join({ version: "0.1.0", mode: "mcp", agents: [] });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connected" }));
    expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "terminal" });
    actor.stop();
  });

  it("should end a turn the companion was answering when it leaves, so the chat can send again", async () => {
    const { actor, room } = await connected();
    await room.say({ type: "agent.turn", conversation: "p1", turn: "t1", state: "started" });
    await vi.waitFor(() => expect(workingTurn(actor.getSnapshot().context.activity, "p1")).toBe("t1"));

    room.leave();

    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "waiting" }));
    expect(workingTurn(actor.getSnapshot().context.activity, "p1")).toBeUndefined();
    expect(actor.getSnapshot().context.activity.at(-1)).toMatchObject({
      kind: "turn",
      turn: "t1",
      state: "failed",
      error: "The chat link closed before the answer ended.",
    });
    actor.stop();
  });

  it("should end a working turn when a new companion joins before the old one leaves", async () => {
    const { actor, room } = await connected();
    await room.say({ type: "agent.turn", conversation: "p1", turn: "t1", state: "started" });
    await vi.waitFor(() => expect(workingTurn(actor.getSnapshot().context.activity, "p1")).toBe("t1"));

    await room.join();

    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connected" }));
    expect(workingTurn(actor.getSnapshot().context.activity, "p1")).toBeUndefined();
    actor.stop();
  });

  it("should end a working turn on Disconnect, on the companion leaving while busy, and on Forget", async () => {
    const startTurn = async (room: Awaited<ReturnType<typeof connected>>["room"], turn: string) => {
      await room.say({ type: "agent.turn", conversation: "p1", turn, state: "started" });
    };

    const disconnected = await connected();
    await startTurn(disconnected.room, "t1");
    await vi.waitFor(() => expect(workingTurn(disconnected.actor.getSnapshot().context.activity, "p1")).toBe("t1"));
    disconnected.actor.send({ type: "link.disconnect" });
    expect(workingTurn(disconnected.actor.getSnapshot().context.activity, "p1")).toBeUndefined();
    disconnected.actor.stop();

    const busy = await connected();
    await startTurn(busy.room, "t2");
    await vi.waitFor(() => expect(workingTurn(busy.actor.getSnapshot().context.activity, "p1")).toBe("t2"));
    busy.room.server({ t: "busy", scope: "daily", retryAt: new Date(Date.now() + 60_000).toISOString() });
    await waitFor(busy.actor, (snapshot) => snapshot.matches({ linked: "busy" }));
    busy.room.leave();
    await vi.waitFor(() => expect(workingTurn(busy.actor.getSnapshot().context.activity, "p1")).toBeUndefined());
    busy.actor.stop();

    const forgotten = await connected();
    await startTurn(forgotten.room, "t3");
    await vi.waitFor(() => expect(workingTurn(forgotten.actor.getSnapshot().context.activity, "p1")).toBe("t3"));
    forgotten.actor.send({ type: "pairing.forget" });
    await forgotten.room.say({ type: "forgotten" });
    await waitFor(forgotten.actor, (snapshot) => snapshot.matches("unpaired"));
    expect(workingTurn(forgotten.actor.getSnapshot().context.activity, "p1")).toBeUndefined();
    forgotten.actor.stop();
  });

  it("should disconnect on request and keep the pairing: the tab's return does not reconnect, Reconnect does", async () => {
    const { actor, room, clear } = await connected();

    actor.send({ type: "link.disconnect" });
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "off" });
    expect(room.closed).toBeDefined();
    expect(actor.getSnapshot().context.pairing?.secret).toBe(SECRET);
    expect(clear).not.toHaveBeenCalled();

    const closed = room.handlers;

    actor.send({ type: "tab.activate" });
    expect(actor.getSnapshot().matches("off")).toBe(true);
    expect(room.handlers).toBe(closed);

    actor.send({ type: "link.retry" });
    await vi.waitFor(() => expect(room.handlers).not.toBe(closed));
    room.welcome();
    await room.join();
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connected" }));
    expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "choosing" });
    actor.stop();
  });

  it("should show busy until the relay's retry time and keep the chat", async () => {
    const { actor, room } = await connected();

    room.server({ t: "busy", scope: "daily", retryAt: new Date(Date.now() + 1_000).toISOString() });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "busy" }));
    expect(connectStatus(actor.getSnapshot())).toMatchObject({ kind: "busy", scope: "daily" });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connected" }), { timeout: 3_000 });
    expect(actor.getSnapshot().context.busy).toBeUndefined();
    actor.stop();
  });

  it("should keep the relay's latest share of the day, and read it full while busy for the day", async () => {
    const { actor, room } = await connected();
    const resetAt = "2026-10-16T00:00:00.000Z";

    expect(connectQuota(actor.getSnapshot())).toBeUndefined();

    room.server({ t: "quota", per: "account", used: 0, limit: 10_000, resetAt });
    room.server({ t: "quota", per: "account", used: 3_800, limit: 10_000, resetAt });
    await vi.waitFor(() => expect(connectQuota(actor.getSnapshot())).toMatchObject({ used: 3_800 }));
    expect(connectQuota(actor.getSnapshot())).toEqual({ per: "account", used: 3_800, limit: 10_000, resetAt });

    const retryAt = new Date(Date.now() + 1_000).toISOString();

    room.server({ t: "busy", scope: "daily", retryAt });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "busy" }));
    expect(connectQuota(actor.getSnapshot())).toEqual({
      per: "account",
      used: 10_000,
      limit: 10_000,
      resetAt: retryAt,
    });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connected" }), { timeout: 3_000 });
    expect(connectQuota(actor.getSnapshot())).toMatchObject({ used: 3_800 });
    actor.stop();
  });

  it("should reconnect after a dropped socket, and wait for the tab's return after an expired room", async () => {
    const { actor, room } = await connected();

    room.handlers?.close(1006, "network");
    await waitFor(actor, (snapshot) => snapshot.matches("reconnecting"));
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "disconnected", reconnecting: true });

    const first = room.handlers;
    actor.send({ type: "link.retry" });
    await vi.waitFor(() => expect(room.handlers).not.toBe(first));

    room.handlers?.close(RELAY_CLOSE.expired, "idle");
    await waitFor(actor, (snapshot) => snapshot.matches("paused"));

    const second = room.handlers;
    actor.send({ type: "tab.activate" });
    await vi.waitFor(() => expect(room.handlers).not.toBe(second));
    expect(actor.getSnapshot().matches({ linked: "connecting" })).toBe(true);
    actor.stop();
  });

  it("should keep the reconnect backoff when the tab comes back to the front", async () => {
    const { actor, room } = await connected();

    room.handlers?.close(1006, "network");
    await waitFor(actor, (snapshot) => snapshot.matches("reconnecting"));

    const dropped = room.handlers;
    actor.send({ type: "tab.activate" });
    actor.send({ type: "tab.activate" });

    expect(actor.getSnapshot().matches("reconnecting")).toBe(true);
    expect(room.handlers).toBe(dropped);
    actor.stop();
  });

  it("should say a rate limited connection is limited, and back off until a connection is welcomed", async () => {
    const { actor, room } = await connected();

    room.handlers?.close(RELAY_CLOSE.rateLimited, "Too many AI chat connections.");
    await waitFor(actor, (snapshot) => snapshot.matches("limited"));
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "limited" });

    const refused = room.handlers;
    actor.send({ type: "tab.activate" });
    actor.send({ type: "link.retry" });
    expect(room.handlers).toBe(refused);

    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connecting" }), { timeout: 3_000 });
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "limited" });
    await vi.waitFor(() => expect(room.handlers).not.toBe(refused));
    room.handlers?.close(RELAY_CLOSE.rateLimited, "Too many AI chat connections.");
    await waitFor(actor, (snapshot) => snapshot.matches("limited"));
    expect(actor.getSnapshot().context.attempt).toBe(1);

    const refusedAgain = room.handlers;
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "connecting" }), { timeout: 4_000 });
    await vi.waitFor(() => expect(room.handlers).not.toBe(refusedAgain));
    room.welcome();
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "waiting" }));
    expect(actor.getSnapshot().context).toMatchObject({ attempt: 0, refusal: undefined });
    expect(connectStatus(actor.getSnapshot()).kind).not.toBe("limited");
    actor.stop();
  }, 10_000);

  it("should stop reconnecting and say why when the relay refuses the tab's proof", async () => {
    const { actor, room } = await connected();

    room.handlers?.close(RELAY_CLOSE.unproven, "This connection does not hold the pairing code.");
    await waitFor(actor, (snapshot) => snapshot.matches("paused"));

    expect(actor.getSnapshot().context.error).toBe("The relay refused this pairing. Reload the page, or pair again.");
    actor.stop();
  });

  it("should refuse a companion that shares no protocol version", async () => {
    const { actor, room } = start({ pairing: paired });

    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    room.welcome();
    await room.join({ version: "9.0.0", mode: "chat", agents: [] }, { min: 7, max: 9 });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "incompatible" }));
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "incompatible", companion: { min: 7, max: 9 } });
    actor.stop();
  });

  it("should forget this computer: tell the companion, wait for its answer, then clear the pairing here", async () => {
    const { actor, room, clear, emitted, stored } = await connected();

    actor.send({ type: "pairing.forget" });
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "forgetting" });
    expect(await room.next("forget")).toEqual({ type: "forget" });
    await room.say({ type: "forgotten" });
    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(stored()).toBeUndefined();
    expect(room.closed?.code).toBe(1000);
    expect(emitted.at(-1)).toEqual({ type: "pairing.forgotten" });
    actor.stop();
  });

  it("should forget at once without a companion", async () => {
    const { actor, room, clear } = start({ pairing: paired });

    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    actor.send({ type: "pairing.forget" });
    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    expect(clear).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should keep forgetting when the relay answers busy for the day meanwhile", async () => {
    const { actor, room, clear } = await connected();

    actor.send({ type: "pairing.forget" });
    await room.next("forget");
    room.server({ t: "busy", scope: "daily", retryAt: new Date(Date.now() + 60_000).toISOString() });
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "forgetting" });
    await room.say({ type: "forgotten" });
    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    expect(clear).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should tell the companion to forget this computer while the relay is busy for the day", async () => {
    const { actor, room, clear } = await connected();

    room.server({ t: "busy", scope: "daily", retryAt: new Date(Date.now() + 60_000).toISOString() });
    await waitFor(actor, (snapshot) => snapshot.matches({ linked: "busy" }));
    actor.send({ type: "pairing.forget" });
    expect(await room.next("forget")).toEqual({ type: "forget" });
    await room.say({ type: "forgotten" });
    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    expect(clear).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should show why a link code could not be made, and make one on Retry", async () => {
    const { actor, room } = start({ failSaves: 1 });

    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    actor.send({ type: "pairing.create" });
    await vi.waitFor(() =>
      expect(connectStatus(actor.getSnapshot())).toEqual({
        kind: "unpaired",
        reason: "failed",
        error: "The disk is full.",
      }),
    );

    actor.send({ type: "pairing.create" });
    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "pairing", secret: SECRET, connecting: true });
    actor.stop();
  });

  it("should not pair again on its own once the user forgot this computer", async () => {
    const { actor, room } = await connected();

    actor.send({ type: "pairing.forget" });
    await room.say({ type: "forgotten" });
    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    actor.send({ type: "dock.open" });
    expect(connectStatus(actor.getSnapshot())).toEqual({ kind: "unpaired", reason: "forgotten" });
    actor.stop();
  });

  it("should not hand a new companion the result of a call the one before it made", async () => {
    const blocker = Promise.withResolvers<ConnectToolOutcome>();
    const { actor, room, execute } = await connected({ pairing: paired, execute: () => blocker.promise });

    await room.say({ type: "tool.call", id: "old1", name: "read_file", input: { path: "query.ts" } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await room.join(undefined, undefined, "comp2");
    await room.next("tab.active");

    blocker.resolve({ ok: true, result: { text: "old" } });
    await vi.waitFor(() => expect(findEditRow(actor, "old1")).toMatchObject({ status: "done" }));
    await delay(50);

    expect(room.received.filter((message) => message.type === "tool.result")).toEqual([]);
    expect(findEditRow(actor, "old1")).toMatchObject({
      error: { code: "unavailable", message: "The companion that asked for this left before it got the result." },
    });
    actor.stop();
  });

  it("should ignore events that do not apply where it is", async () => {
    const { actor } = start();

    await waitFor(actor, (snapshot) => snapshot.matches("unpaired"));
    actor.send({ type: "chat.message.send", conversation: "p1", text: "hi" });
    actor.send({ type: "chat.agent.choose", agent: "claude" });
    actor.send({ type: "link.retry" });
    actor.send({ type: "edit.undo", id: "nothing" });
    actor.send({ type: "pairing.forget" });
    expect(actor.getSnapshot().value).toEqual({ unpaired: "fresh" });
    actor.stop();
  });
});

/** The link under a parent that keeps what it reports. */
function startLink() {
  const room = new FakeRoom();
  const reported: LinkEvent[] = [];
  const services: ConnectServices = {
    loadPairing: async () => undefined,
    savePairing: async () => undefined,
    clearPairing: async () => undefined,
    roomUrl: (roomId) => `wss://run.test/api/connect/rooms/${roomId}?role=tab`,
    openSocket: room.open,
    executeTool: readProject,
    undoEdit: async () => undefined,
    kdfIterations: ITERATIONS,
  };
  const parent = createActor(
    setup({
      types: { events: declareType<LinkEvent>() },
      actors: { link: createLinkMachine(services) },
    }).createMachine({
      invoke: { id: LINK_ID, src: "link", input: { secret: SECRET } },
      on: { "*": { actions: ({ event }) => reported.push(event) } },
    }),
  );

  parent.start();

  const send = (command: LinkCommand) => parent.getSnapshot().children[LINK_ID]?.send(command);

  return { parent, room, reported, send };
}

describe("connect link", () => {
  it("should refuse a send to a companion that has not said hello, or to one that is gone", async () => {
    const { parent, room, reported, send } = startLink();

    await vi.waitFor(() => expect(room.handlers).toBeDefined());
    room.welcome(true);
    send({ type: "link.send", peer: COMPANION, message: { type: "tab.active" } });
    expect(reported.at(-1)).toEqual({
      type: "link.send.refused",
      peer: COMPANION,
      message: { type: "tab.active" },
    });

    room.leave();
    await room.join(undefined, undefined, "comp2");
    await vi.waitFor(() => expect(reported.at(-1)).toMatchObject({ type: "companion.greeted", peer: "comp2" }));
    send({ type: "link.send", peer: COMPANION, message: { type: "tab.active" } });
    send({ type: "link.send", peer: "comp2", message: { type: "tab.active" } });

    expect(reported.at(-1)).toMatchObject({ type: "link.send.refused", peer: COMPANION });
    expect(await room.next("tab.active")).toEqual({ type: "tab.active" });
    parent.stop();
  });
});
