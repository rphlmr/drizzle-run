import type { ConnectActivity, ConnectStatus } from "@drizzle-run/runtime/machines";
import { describe, expect, it } from "vitest";

import { resolveChatTuning } from "./agent-tuning-menu";
import { EMPTY_HISTORY, getChatContext, HISTORY_LIMIT, mergeHistory, readHistory } from "./chat-history";
import { getAgentName, getChatBody, getChatComposer, getChatHead, getQuotaLine, listChatItems } from "./chat-view";
import { getGuideConversation, getProjectConversation } from "./conversations";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

describe("conversation ids", () => {
  it("should name a project's chat, a guided example's, and a guided project's apart", () => {
    const project = "0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e";

    expect(getProjectConversation(project)).toBe(`p-${project}`);
    expect(getGuideConversation("transactions")).toBe("g-transactions");
    expect(getGuideConversation("first-run", project)).toBe(`g-first-run-${project}`);
  });

  it("should keep every id within the protocol's characters and length, and long ids apart", () => {
    const long = "x".repeat(40);
    const first = getGuideConversation(long, "0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e");
    const second = getGuideConversation(long, "0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6f");

    for (const id of [first, second, getProjectConversation("a b/c"), getGuideConversation("ünïcode")]) {
      expect(id).toMatch(ID);
    }

    expect(first).not.toBe(second);
    expect(first.slice(0, 56)).toBe(second.slice(0, 56));
  });
});

function makeUserMessage(id: string, conversation = "p-1"): ConnectActivity {
  return { kind: "user", id, conversation, text: `asked ${id}`, at: 1 };
}

function makeSay(turn: string, text: string, at = 2): ConnectActivity {
  return { kind: "text", conversation: "p-1", turn, text, at };
}

function makeTool(id: string, change: Partial<Extract<ConnectActivity, { kind: "tool" }>> = {}): ConnectActivity {
  return { kind: "tool", id, name: "read_file", conversation: "p-1", status: "done", at: 3, ...change };
}

describe("chat history", () => {
  it("should merge stored rows with live ones: same rows update in place, new ones follow, other chats stay out", () => {
    const stored = [makeUserMessage("u1"), makeSay("t1", "Hel"), makeTool("c1", { status: "running" })];
    const live = [
      makeSay("t1", "Hello"),
      makeTool("c1"),
      makeUserMessage("u2"),
      makeUserMessage("u3", "p-2"),
      { kind: "turn", conversation: "p-1", turn: "t1", state: "done", at: 4 } satisfies ConnectActivity,
    ];

    expect(mergeHistory(stored, live, "p-1")).toEqual([
      makeUserMessage("u1"),
      makeSay("t1", "Hello"),
      makeTool("c1"),
      makeUserMessage("u2"),
      { kind: "turn", conversation: "p-1", turn: "t1", state: "done", at: 4 },
    ]);
  });

  it("should keep a turn's text before and after a tool row as two rows", () => {
    const live = [makeSay("t1", "First", 2), makeTool("c1"), makeSay("t1", "Then", 5)];

    expect(mergeHistory([], live, "p-1")).toHaveLength(3);
  });

  it("should keep the latest rows when a chat grows past its limit", () => {
    const live = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => makeUserMessage(`u${index}`));
    const merged = mergeHistory([], live, "p-1");

    expect(merged).toHaveLength(HISTORY_LIMIT);
    expect(merged[0]).toEqual(makeUserMessage("u5"));
  });

  it("should read what it wrote, and read a history with a row it does not know as none", () => {
    const written = {
      version: 1,
      mode: "edit",
      answers: { c1: "allowed" },
      entries: [
        makeUserMessage("u1"),
        makeTool("c1", { status: "refused", error: { code: "edit_mode_required", message: "Ask mode" } }),
      ],
      tuning: { agent: "codex", model: "gpt-6-luna", effort: "high" },
    };

    expect(readHistory(JSON.parse(JSON.stringify(written)))).toEqual(written);
    expect(
      readHistory({
        ...written,
        entries: [...written.entries, { kind: "tool", id: "x", name: "rm_rf", status: "done", at: 1 }],
      }),
    ).toBeUndefined();
    expect(readHistory({ version: 2, entries: [] })).toBeUndefined();
    expect(readHistory(null)).toBeUndefined();
  });

  it("should give the chat so far as user and agent entries, one answer per turn, without tool rows", () => {
    const entries = [
      makeUserMessage("u1"),
      makeSay("t1", "Reading.", 2),
      makeTool("c1"),
      makeSay("t1", "Ada has 100.", 4),
      makeUserMessage("u2"),
    ];
    const limits = { maxChars: 1_000, maxEntries: 10 };

    expect(getChatContext(entries, limits)).toEqual([
      { from: "user", text: "asked u1" },
      { from: "agent", text: "Reading.\nAda has 100." },
      { from: "user", text: "asked u2" },
    ]);
    expect(getChatContext([makeTool("c1")], limits)).toEqual([]);
  });

  it("should keep the latest whole entries that fit, and the end of one too long alone", () => {
    const entries = [makeUserMessage("u1"), makeSay("t1", "Ada has 100."), makeUserMessage("u2")];

    expect(getChatContext(entries, { maxChars: 20, maxEntries: 10 })).toEqual([
      { from: "agent", text: "Ada has 100." },
      { from: "user", text: "asked u2" },
    ]);
    expect(getChatContext(entries, { maxChars: 1_000, maxEntries: 1 })).toEqual([{ from: "user", text: "asked u2" }]);
    expect(getChatContext(entries, { maxChars: 4, maxEntries: 10 })).toEqual([{ from: "user", text: "d u2" }]);
  });
});

describe("chat tuning", () => {
  const agents = [
    {
      id: "claude" as const,
      name: "Claude Code",
      models: [
        { id: "opus", name: "Opus", efforts: ["medium", "high"] as const },
        { id: "sonnet", name: "Sonnet", efforts: ["medium"] as const },
      ],
      defaults: { model: "opus", effort: "medium" as const },
    },
    {
      id: "codex" as const,
      name: "Codex",
      models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["medium", "high"] as const }],
      defaults: { model: "gpt-6-luna", effort: "medium" as const },
    },
  ];
  const companion = { agents, agent: "claude" as const };

  it("should keep a chat on its own choice whatever was picked last elsewhere", () => {
    const last = { agent: "claude" as const, byAgent: { claude: { model: "opus", effort: "medium" as const } } };

    expect(resolveChatTuning(companion, { agent: "claude", model: "opus", effort: "high" }, last)).toEqual({
      agent: "claude",
      model: "opus",
      effort: "high",
    });
    expect(resolveChatTuning(companion, { agent: "codex", model: "gpt-6-luna" }, last)).toEqual({
      agent: "codex",
      model: "gpt-6-luna",
    });
  });

  it("should start a new chat on the last pick, else on the companion's agent and its defaults", () => {
    const last = { agent: "codex" as const, byAgent: { codex: { model: "gpt-6-luna", effort: "high" as const } } };

    expect(resolveChatTuning(companion, undefined, last)).toEqual({
      agent: "codex",
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(resolveChatTuning(companion, undefined, { byAgent: {} })).toEqual({
      agent: "claude",
      model: "opus",
      effort: "medium",
    });
  });

  it("should drop a stale effort and keep a model still offered", () => {
    expect(resolveChatTuning(companion, { agent: "claude", model: "sonnet", effort: "high" }, { byAgent: {} })).toEqual(
      {
        agent: "claude",
        model: "sonnet",
      },
    );
  });

  it("should fall back to the defaults when the chat's model or agent is no longer offered", () => {
    const last = { byAgent: {} };

    expect(resolveChatTuning(companion, { agent: "claude", model: "fable", effort: "high" }, last)).toEqual({
      agent: "claude",
      model: "opus",
      effort: "medium",
    });
    expect(resolveChatTuning({ agents: agents.slice(0, 1), agent: "claude" }, { agent: "codex" }, last)).toMatchObject({
      agent: "claude",
    });
  });
});

const companion = { version: "0.1.0", mode: "chat" as const, agents: [{ id: "claude" as const, name: "Claude Code" }] };

describe("chat view", () => {
  it("should give heads and bodies that follow the Chat boards for every status", () => {
    const cases: [ConnectStatus, string, string, ReturnType<typeof getChatBody>][] = [
      [{ kind: "unpaired", reason: "fresh" }, "AI chat", "Not connected", "setup"],
      [{ kind: "unpaired", reason: "failed", error: "The disk is full." }, "AI chat", "Not connected", "setup"],
      [{ kind: "pairing", secret: "k7Pq", connecting: true }, "AI chat", "Not connected", "setup"],
      [{ kind: "waiting", connecting: true }, "AI chat", "Not connected", "return"],
      [{ kind: "choosing", companion }, "AI chat", "Companion connected", "pair"],
      [{ kind: "ready", companion, agent: "claude" }, "Claude Code", "Connected · this project only", "empty"],
      [
        { kind: "terminal", companion: { ...companion, mode: "mcp" } },
        "Claude Code",
        "Connected from your terminal",
        "messages",
      ],
      [{ kind: "disconnected", reconnecting: true }, "Claude Code", "Companion stopped", "return"],
      [{ kind: "off" }, "Claude Code", "Disconnected", "off"],
      [{ kind: "incompatible", companion: { min: 2, max: 2 } }, "AI chat", "Update the companion", "incompatible"],
      [{ kind: "forgetting" }, "AI chat", "Forgetting this computer", "forgetting"],
    ];

    for (const [status, name, line, body] of cases) {
      expect(getChatHead(status, "Claude Code")).toMatchObject({ name, status: line });
      expect(getChatBody(status, false)).toBe(body);
    }

    expect(getChatBody({ kind: "disconnected", reconnecting: false }, true)).toBe("messages");
    expect(getChatBody({ kind: "off" }, true)).toBe("messages");
    expect(getChatHead({ kind: "busy", scope: "daily", retryAt: "2026-10-17T02:00:00Z" }, "Codex")).toMatchObject({
      name: "Codex",
      status: expect.stringMatching(/^Busy · try again after \d\d:\d\d$/),
      tone: "warn",
    });
    expect(getChatHead({ kind: "limited" }, "Codex")).toEqual({
      name: "Codex",
      status: "Too many connections · retrying",
      tone: "warn",
    });
    expect(getChatBody({ kind: "limited" }, false)).toBe("messages");
    expect(getAgentName({ kind: "limited" }, "Codex")).toBe("Codex");
  });

  it("should say how much of today's AI chat is used, rounding down, and the reset time once it is full", () => {
    const resetAt = "2026-10-16T00:00:00.000Z";
    const time = /\d\d:\d\d/;

    expect(getQuotaLine(undefined)).toBeUndefined();
    expect(getQuotaLine({ per: "account", used: 3_850, limit: 10_000, resetAt })).toEqual({
      text: "38% of today's AI chat used",
      resetTime: expect.stringMatching(time),
      holder: "account",
    });
    expect(getQuotaLine({ per: "connection", used: 9_999, limit: 10_000, resetAt })?.text).toBe(
      "99% of today's AI chat used",
    );
    expect(getQuotaLine({ per: undefined, used: 0, limit: 0, resetAt })).toEqual({
      text: expect.stringMatching(/^100% of today's AI chat used · resets at \d\d:\d\d$/),
      resetTime: expect.stringMatching(time),
      holder: "connection",
    });
  });

  it("should say in the composer who is working, and turn it off while stopped or busy", () => {
    const ready: ConnectStatus = { kind: "ready", companion, agent: "claude" };

    expect(getChatComposer(ready, false, "Claude Code", "Ask about this project, or ask for a change")).toEqual({
      placeholder: "Ask about this project, or ask for a change",
      disabled: false,
    });
    expect(getChatComposer(ready, true, "Claude Code", "idle")).toEqual({
      placeholder: "Claude Code is working",
      disabled: false,
    });
    expect(getChatComposer({ kind: "disconnected", reconnecting: false }, false, undefined, "idle")).toEqual({
      placeholder: "Not connected",
      disabled: true,
    });
    expect(getChatComposer({ kind: "off" }, false, undefined, "idle")).toEqual({
      placeholder: "Not connected",
      disabled: true,
    });
    expect(getChatComposer({ kind: "busy", scope: "daily", retryAt: "" }, false, undefined, "idle")).toEqual({
      placeholder: "AI chat is busy",
      disabled: true,
    });
    expect(getChatComposer({ kind: "limited" }, false, undefined, "idle")).toEqual({
      placeholder: "Reconnecting",
      disabled: true,
    });
    expect(getChatComposer({ kind: "terminal", companion }, false, undefined, "idle")).toBeUndefined();
  });

  it("should draw rows: bubbles, tool rows with their chip, the Ask card until answered, and turn endings", () => {
    const entries: ConnectActivity[] = [
      makeUserMessage("u1"),
      makeTool("c1", { summary: { label: "Read", target: "query.ts", meta: "15 lines" } }),
      makeSay("t1", "  Ada starts with 100.  "),
      makeTool("c2", {
        name: "apply_edits",
        status: "refused",
        error: { code: "edit_mode_required", message: "Ask mode" },
        summary: { label: "Edit", target: "query.ts" },
      }),
      makeTool("c3", {
        name: "apply_edits",
        summary: { label: "Edited", target: "query.ts", meta: "+8 -3" },
        edit: { id: "e1", decision: "pending" },
      }),
      makeTool("c4", { name: "apply_edits", edit: { id: "e2", decision: "pending" } }),
      makeTool("c5", { name: "run", status: "running" }),
      { kind: "turn", conversation: "p-1", turn: "t1", state: "failed", error: "Claude Code exited", at: 9 },
    ];
    const items = listChatItems(entries, { pendingEdits: new Set(["e1"]), working: "t2", answers: {} });

    expect(items.map((item) => item.kind)).toEqual(["user", "tool", "say", "ask", "tool", "tool", "tool", "notice"]);
    expect(items[1]).toMatchObject({
      label: "Read",
      target: "query.ts",
      meta: "15 lines",
      tone: "ok",
      spinning: false,
    });
    expect(items[2]).toMatchObject({ text: "Ada starts with 100." });
    expect(items[3]).toMatchObject({ kind: "ask", toolId: "c2", target: "query.ts" });
    expect(items[4]).toMatchObject({ chip: "pending" });
    expect(items[5]).toMatchObject({ label: "Edited", chip: "kept" });
    expect(items[6]).toMatchObject({ label: "Running the project", spinning: true });
    expect(items[7]).toMatchObject({ tone: "err", text: "Claude Code exited" });
    expect(
      listChatItems([makeTool("c6", { name: "run", summary: { label: "Ran the project", rolledBack: true } })], {
        pendingEdits: new Set(),
        working: undefined,
        answers: {},
      })[0],
    ).toMatchObject({ label: "Ran the project", chip: "rolled back" });

    expect(
      listChatItems(entries, { pendingEdits: new Set(), working: undefined, answers: { c2: "allowed" } })[3],
    ).toMatchObject({ kind: "allowed" });
    expect(
      listChatItems(entries, { pendingEdits: new Set(), working: undefined, answers: { c2: "dismissed" } })[3],
    ).toMatchObject({ kind: "tool", label: "Edit", meta: "not available", tone: "faint" });
    expect(listChatItems(entries, { pendingEdits: new Set(), working: undefined, answers: {} })[6]).toMatchObject({
      spinning: false,
    });
  });

  it("should show why a finished tool's result never reached a companion that left", () => {
    const unanswered = makeTool("c1", {
      name: "apply_edits",
      error: { code: "unavailable", message: "The companion that asked for this left before it got the result." },
    });

    const [item] = listChatItems([unanswered], { pendingEdits: new Set(), working: undefined, answers: {} });

    expect(item).toMatchObject({
      kind: "tool",
      label: "Edited",
      error: "The companion that asked for this left before it got the result.",
      tone: "warn",
    });
  });

  it("should end a working turn with a thinking row until a tool runs", () => {
    const options = { pendingEdits: new Set<string>(), working: "t1", answers: {} };

    expect(listChatItems([makeUserMessage("u1")], options).map((item) => item.kind)).toEqual(["user", "thinking"]);
    expect(listChatItems([makeUserMessage("u1"), makeSay("t1", "Reading")], options).map((item) => item.kind)).toEqual([
      "user",
      "say",
      "thinking",
    ]);
    expect(
      listChatItems([makeUserMessage("u1"), makeTool("c1", { status: "running" })], options).map((item) => item.kind),
    ).toEqual(["user", "tool"]);
    expect(listChatItems([makeUserMessage("u1")], { ...options, working: undefined }).map((item) => item.kind)).toEqual(
      ["user"],
    );
  });

  it("should mark an answer streaming only while it is the last row of the working turn", () => {
    const options = { pendingEdits: new Set<string>(), answers: {} };
    const answers = (entries: ConnectActivity[], working: string | undefined) =>
      listChatItems(entries, { ...options, working }).flatMap((item) => (item.kind === "say" ? [item.streaming] : []));

    expect(answers([makeSay("t1", "Done before."), makeUserMessage("u2"), makeSay("t2", "Writing now")], "t2")).toEqual(
      [false, true],
    );
    expect(answers([makeSay("t2", "Reading first"), makeTool("c1", { status: "running" })], "t2")).toEqual([false]);
    expect(answers([makeSay("t2", "All done")], undefined)).toEqual([false]);
  });

  it("should name the tool of guided rows, as ChatGuided draws them", () => {
    const items = listChatItems(
      [
        makeTool("c1", {
          name: "read_docs",
          summary: { label: "Read docs", target: "orm.drizzle.team/docs/transactions" },
        }),
      ],
      { pendingEdits: new Set(), working: undefined, answers: {}, guided: true },
    );

    expect(items[0]).toMatchObject({
      label: "Read docs",
      target: "orm.drizzle.team/docs/transactions",
      link: "https://orm.drizzle.team/docs/transactions",
      meta: "read_docs",
    });
  });

  it("should keep a failed call's error for its details, and no link outside the docs", () => {
    const items = listChatItems(
      [
        makeTool("c1", {
          status: "failed",
          summary: { label: "Read", target: "missing.ts" },
          error: { code: "not_found", message: "No file at missing.ts" },
        }),
        makeTool("c2", { summary: { label: "Read", target: "schema.ts" } }),
      ],
      { pendingEdits: new Set(), working: undefined, answers: {} },
    );

    expect(items[0]).toMatchObject({ tone: "err", target: "missing.ts", error: "No file at missing.ts" });
    expect(items[0]).not.toHaveProperty("link");
    expect(items[1]).not.toHaveProperty("error");
  });

  it("should link a created project to open in a new tab, after a reload too, and only once it is saved", () => {
    const summary = { label: "Created a project", target: "Shop", createdProject: { id: "p/2", name: "Shop" } };
    const created = makeTool("c1", { name: "create_project", summary });
    const stored = readHistory({ ...EMPTY_HISTORY, entries: [created] });
    const options = { pendingEdits: new Set<string>(), working: undefined, answers: {} };

    expect(listChatItems(stored?.entries ?? [], options)[0]).toMatchObject({
      label: "Created a project",
      opens: { href: "/p/p%2F2", name: "Shop" },
    });
    expect(
      listChatItems([makeTool("c1", { name: "create_project", summary, status: "running" })], options)[0],
    ).not.toHaveProperty("opens");
  });
});
