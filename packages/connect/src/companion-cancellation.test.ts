import { CONNECT_PROTOCOL, deriveConnectKeys } from "@drizzle-run/core/connect";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { NO_LOCKDOWN, type PreparedTurn } from "./agents/index.ts";
import { createCompanionMachine, type CompanionServices } from "./companion-machine.ts";

describe("companion cancellation", () => {
  it("should revoke a stopped turn and settle and remove its queued tool calls", async () => {
    const preparation = Promise.withResolvers<PreparedTurn>();
    const dropFrames = vi.fn();
    const services: CompanionServices = {
      mode: "chat",
      agents: [{ ok: true, agent: { id: "claude", name: "Claude" }, command: "claude", lockdown: NO_LOCKDOWN }],
      toolTimeoutMs: 60_000,
      send: async () => new Promise(() => {}),
      dropFrames,
      clearFrames: vi.fn(),
      forgetPeer: vi.fn(),
      closeRelay: vi.fn(),
      clearPairing: async () => {},
      log: vi.fn(),
      exit: vi.fn(),
      deriveKeys: () => deriveConnectKeys("k7Pq-2xZm-9fLw", { iterations: 1 }),
      joinRelay: vi.fn(),
      conversation: {
        send: async () => "sent",
        log: vi.fn(),
        prepareTurn: () => preparation.promise,
        runTurn: () => {
          throw new Error("cancelled preparation must not launch");
        },
      },
    };
    const actor = createActor(createCompanionMachine(services), { input: { agent: "claude" } }).start();

    try {
      actor.send({ type: "companion.start" });
      await waitFor(actor, (snapshot) => snapshot.matches({ starting: "joining" }));
      actor.send({ type: "relay.welcome", tabs: ["tab"] });
      actor.send({ type: "tab.hello", tab: "tab", protocol: CONNECT_PROTOCOL, answerHello: false });
      actor.send({
        type: "tab.chat.send",
        tab: "tab",
        message: {
          type: "chat.send",
          conversation: "chat",
          text: "Run",
          mode: "ask",
        },
      });
      const conversation = actor.getSnapshot().context.conversations.get("chat");
      const token = conversation?.getSnapshot().context.turn?.token;
      expect(token).toBeTypeOf("string");
      const resolve = vi.fn();
      actor.send({ type: "tool.call", token, name: "run", input: {}, resolve });
      const callIds = new Set(actor.getSnapshot().context.calls.keys());
      expect(callIds.size).toBe(1);

      actor.send({ type: "tab.chat.stop", tab: "tab", conversation: "chat" });

      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      expect(actor.getSnapshot().context.calls.size).toBe(0);
      expect(dropFrames).toHaveBeenCalledWith("tab", callIds);
      const rejected = vi.fn();
      actor.send({ type: "tool.call", token, name: "run", input: {}, resolve: rejected });
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      preparation.resolve({ args: [], stdin: "", cwd: "/unused" });
      if (conversation !== undefined) {
        await waitFor(conversation, (snapshot) => snapshot.matches("idle"));
      }
    } finally {
      actor.stop();
    }
  });
});
