import { describe, expect, it } from "vitest";

import {
  applyFileEdits,
  checkDocsUrl,
  connectCommand,
  CONNECT_KDF_ITERATIONS,
  CONNECT_TOOLS,
  connectTool,
  connectToolsFor,
  DOCS_TEXT_MAX_CHARS,
  docsText,
  isLocalOrigin,
  isToolInScope,
  scopeRefusal,
  countLineChanges,
  createPairingSecret,
  deriveConnectKeys,
  toRoomId,
  fromBase64Url,
  nextUtcMidnight,
  normalizePairingSecret,
  openText,
  parseRelayClientFrame,
  parseRelayServerFrame,
  parseToolInput,
  readConnectMessage,
  resolveAgentTuning,
  fitAgentTuning,
  ROOM_ID_PATTERN,
  sealText,
  SecureChannel,
  sharedProtocolVersion,
  toBase64Url,
  type CompanionAgent,
  type ConnectMessage,
} from "./index.ts";

const FAST = { iterations: 1_000 };
const SECRET = "k7Pq-2xZm-9fLw";
const OTHER = "k7Pq-2xZm-9fLx";

describe("pairing secrets", () => {
  it("should create twelve characters in three groups, from the unambiguous alphabet", () => {
    for (let index = 0; index < 50; index += 1) {
      const secret = createPairingSecret();

      expect(secret).toMatch(/^[2-9A-HJ-NP-Za-km-z]{4}-[2-9A-HJ-NP-Za-km-z]{4}-[2-9A-HJ-NP-Za-km-z]{4}$/);
      expect(normalizePairingSecret(secret)).toBe(secret);
    }
  });

  it("should skip biased bytes instead of folding them", () => {
    let callCount = 0;
    const secret = createPairingSecret((bytes) => {
      callCount += 1;

      return bytes.fill(callCount === 1 ? 250 : 0);
    });

    expect(secret).toBe("2222-2222-2222");
  });

  it("should normalize pasted codes and refuse others", () => {
    expect(normalizePairingSecret(" k7Pq 2xZm-9fLw ")).toBe(SECRET);
    expect(normalizePairingSecret("k7Pq2xZm9fLw")).toBe(SECRET);
    expect(normalizePairingSecret("k7Pq-2xZm-9fL0")).toBeUndefined();
    expect(normalizePairingSecret("short")).toBeUndefined();
  });
});

describe("connect crypto", () => {
  it("should round-trip base64url", () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);

      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("should derive the same room id on both sides, a different one for another code, and a key apart from it", async () => {
    const tab = await deriveConnectKeys(SECRET, FAST);
    const companion = await deriveConnectKeys("k7Pq2xZm9fLw", FAST);
    const other = await deriveConnectKeys(OTHER, FAST);

    expect(tab.roomId).toMatch(ROOM_ID_PATTERN);
    expect(companion.roomId).toBe(tab.roomId);
    expect(other.roomId).not.toBe(tab.roomId);
    expect(tab.roomId).not.toContain(SECRET.replaceAll("-", ""));
    expect(tab.key.extractable).toBe(false);
  });

  it("should make the room id the SHA-256 of the companion proof, which shares nothing with the room id", async () => {
    const keys = await deriveConnectKeys(SECRET, FAST);

    expect(keys.roomProof).toMatch(ROOM_ID_PATTERN);
    expect(keys.roomProof).not.toBe(keys.roomId);
    expect(await toRoomId(keys.roomProof)).toBe(keys.roomId);
    expect(await toRoomId(keys.roomId)).not.toBe(keys.roomId);
  });

  it("should use the full PBKDF2 count by default", async () => {
    const full = await deriveConnectKeys(SECRET);
    const fast = await deriveConnectKeys(SECRET, FAST);

    expect(CONNECT_KDF_ITERATIONS).toBeGreaterThanOrEqual(100_000);
    expect(full.roomId).not.toBe(fast.roomId);
  });

  it("should open with the same key and refuse a wrong key, other associated data, or a changed byte", async () => {
    const { key } = await deriveConnectKeys(SECRET, FAST);
    const { key: wrong } = await deriveConnectKeys(OTHER, FAST);
    const sealed = await sealText(key, "select * from accounts", "from:tab");

    expect(await openText(key, sealed, "from:tab")).toBe("select * from accounts");
    await expect(openText(wrong, sealed, "from:tab")).rejects.toThrow("could not be decrypted");
    await expect(openText(key, sealed, "from:companion")).rejects.toThrow("could not be decrypted");

    const [iv, body] = sealed.split(".");
    const flippedBody = fromBase64Url(body ?? "");
    flippedBody[0] = (flippedBody[0] ?? 0) ^ 1;
    const tampered = `${iv}.${toBase64Url(flippedBody)}`;

    await expect(openText(key, tampered, "from:tab")).rejects.toThrow("could not be decrypted");
    await expect(openText(key, "nonsense", "from:tab")).rejects.toThrow("Not a sealed message");
  });

  it("should refuse something that is not a pairing code", async () => {
    await expect(deriveConnectKeys("hello", FAST)).rejects.toThrow("not a Drizzle Run pairing code");
  });
});

function makeHello(role: "tab" | "companion"): Extract<ConnectMessage, { type: "hello" }> {
  return { type: "hello", role, protocol: { min: 1, max: 1 } };
}

/** Open a tab and a companion channel under one key, each having said hello to the other. */
async function createPairedChannels() {
  const { key } = await deriveConnectKeys(SECRET, FAST);
  const tab = new SecureChannel({ key, role: "tab" });
  const companion = new SecureChannel({ key, role: "companion" });
  const toCompanion = "c1";
  const toTab = "t1";

  const first = await companion.open(toTab, await tab.hello(toCompanion, makeHello("tab")));

  expect(first).toMatchObject({ ok: true, answerHello: true });

  const answer = await tab.open(toCompanion, await companion.hello(toTab, makeHello("companion")));

  expect(answer).toMatchObject({ ok: true, answerHello: false });

  return { key, tab, companion, toCompanion, toTab };
}

describe("secure channel", () => {
  it("should carry messages both ways once each side said hello, without plaintext on the relay", async () => {
    const { tab, companion, toCompanion, toTab } = await createPairedChannels();
    const secretCode = "await db.select().from(accounts) // SECRET-MARKER";
    const chatMessage = { type: "chat.send", conversation: "c", text: secretCode, mode: "ask" } as const;
    const sealed = await tab.seal(toCompanion, chatMessage);
    const frame = JSON.stringify({ t: "send", d: sealed });

    expect(frame).not.toContain("SECRET-MARKER");
    expect(frame).not.toContain("accounts");
    expect(frame).not.toContain("chat.send");
    expect(await companion.open(toTab, sealed)).toEqual({
      ok: true,
      answerHello: false,
      message: { type: "chat.send", conversation: "c", text: secretCode, mode: "ask" },
    });

    const reply = await companion.seal(toTab, { type: "agent.text", conversation: "c", turn: "t1", text: "Hi" });

    expect(await tab.open(toCompanion, reply)).toMatchObject({
      ok: true,
      message: { type: "agent.text", text: "Hi" },
    });
  });

  it("should refuse to seal before the peer said hello", async () => {
    const { key } = await deriveConnectKeys(SECRET, FAST);
    const tab = new SecureChannel({ key, role: "tab" });

    await expect(tab.seal("c1", { type: "tab.active" })).rejects.toThrow("not said hello");
  });

  it("should drop a replayed message, a message reflected to its sender, and one from an older session", async () => {
    const { key, tab, companion, toCompanion, toTab } = await createPairedChannels();
    const sealed = await tab.seal(toCompanion, { type: "tab.active" });

    expect(await companion.open(toTab, sealed)).toMatchObject({ ok: true });
    expect(await companion.open(toTab, sealed)).toEqual({ ok: false, reason: "replayed" });
    expect(await tab.open(toCompanion, sealed)).toEqual({ ok: false, reason: "undecryptable" });

    const restarted = new SecureChannel({ key, role: "companion" });
    await restarted.open(toTab, await tab.hello(toCompanion, makeHello("tab")));

    const stale = await tab.seal(toCompanion, { type: "tab.active" });

    expect(await restarted.open(toTab, stale)).toEqual({ ok: false, reason: "stale_session" });
  });

  it("should not open a tab's earlier messages replayed under a peer id the relay made up", async () => {
    const { key } = await deriveConnectKeys(SECRET, FAST);
    const tab = new SecureChannel({ key, role: "tab" });
    const companion = new SecureChannel({ key, role: "companion" });
    const tabHello = await tab.hello("c1", makeHello("tab"));
    await companion.open("t1", tabHello);
    await tab.open("c1", await companion.hello("t1", makeHello("companion")));
    const chat = await tab.seal("c1", { type: "chat.send", conversation: "c", text: "Run it again", mode: "ask" });
    expect(await companion.open("t1", chat)).toMatchObject({ ok: true });

    expect(await companion.open("fake", tabHello)).toMatchObject({ ok: true, answerHello: true });
    expect(await companion.open("fake", chat)).toEqual({ ok: false, reason: "stale_session" });
  });

  it("should settle when both sides say hello at once, and carry messages both ways", async () => {
    const { key } = await deriveConnectKeys(SECRET, FAST);
    const tab = new SecureChannel({ key, role: "tab" });
    const companion = new SecureChannel({ key, role: "companion" });
    const tabHello = await tab.hello("c1", makeHello("tab"));
    const companionHello = await companion.hello("t1", makeHello("companion"));

    const atCompanion = await companion.open("t1", tabHello);
    const atTab = await tab.open("c1", companionHello);

    expect(atCompanion).toMatchObject({ ok: true, answerHello: true });
    expect(atTab).toMatchObject({ ok: true, answerHello: true });

    let companionAnswers = atCompanion.ok && atCompanion.answerHello;
    let tabAnswers = atTab.ok && atTab.answerHello;
    let rounds = 0;

    while (tabAnswers || companionAnswers) {
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(3);

      const companionAnswer = companionAnswers ? await companion.hello("t1", makeHello("companion")) : undefined;
      const tabAnswer = tabAnswers ? await tab.hello("c1", makeHello("tab")) : undefined;
      const atTabNow = companionAnswer === undefined ? undefined : await tab.open("c1", companionAnswer);
      const atCompanionNow = tabAnswer === undefined ? undefined : await companion.open("t1", tabAnswer);

      tabAnswers = atTabNow?.ok === true && atTabNow.answerHello;
      companionAnswers = atCompanionNow?.ok === true && atCompanionNow.answerHello;
    }

    const chat = await tab.seal("c1", { type: "chat.send", conversation: "c", text: "Hi", mode: "ask" });
    const reply = await companion.seal("t1", { type: "agent.text", conversation: "c", turn: "t1", text: "Hello" });

    expect(await companion.open("t1", chat)).toMatchObject({ ok: true, message: { type: "chat.send" } });
    expect(await tab.open("c1", reply)).toMatchObject({ ok: true, message: { type: "agent.text" } });
  });

  it("should not reopen a companion's earlier messages by switching between two recorded hellos", async () => {
    const { key } = await deriveConnectKeys(SECRET, FAST);
    const tab = new SecureChannel({ key, role: "tab" });
    const first = new SecureChannel({ key, role: "companion" });
    const tabHello = await tab.hello("c1", makeHello("tab"));
    await first.open("t1", tabHello);
    const firstHello = await first.hello("t1", makeHello("companion"));
    await tab.open("c1", firstHello);
    const earlier = await first.seal("t1", { type: "agent.text", conversation: "c", turn: "t1", text: "Once" });
    expect(await tab.open("c1", earlier)).toMatchObject({ ok: true });

    const second = new SecureChannel({ key, role: "companion" });
    await second.open("t1", tabHello);
    expect(await tab.open("c1", await second.hello("t1", makeHello("companion")))).toMatchObject({ ok: true });

    expect(await tab.open("c1", firstHello)).toEqual({ ok: false, reason: "stale_session" });
    expect(await tab.open("c1", earlier)).toEqual({ ok: false, reason: "stale_session" });
  });

  it("should refuse messages from a peer that never said hello and ones under another key", async () => {
    const { tab, companion, toCompanion } = await createPairedChannels();
    const { key: wrong } = await deriveConnectKeys(OTHER, FAST);
    const stranger = new SecureChannel({ key: wrong, role: "companion" });

    const fromUnknownPeer = await companion.seal("t1", { type: "forgotten" });
    const underOtherKey = await stranger.hello("t1", makeHello("companion"));

    expect(await tab.open("unknown", fromUnknownPeer)).toEqual({ ok: false, reason: "unknown_peer" });
    expect(await tab.open(toCompanion, underOtherKey)).toEqual({ ok: false, reason: "undecryptable" });
  });

  it("should refuse a hello that claims the wrong role", async () => {
    const { key } = await deriveConnectKeys(SECRET, FAST);
    const tab = new SecureChannel({ key, role: "tab" });
    const companion = new SecureChannel({ key, role: "companion" });

    const wrongRoleHello = await tab.hello("c1", makeHello("companion"));

    expect(await companion.open("t1", wrongRoleHello)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("protocol readers", () => {
  it("should pick the highest shared version", () => {
    expect(sharedProtocolVersion({ min: 1, max: 2 }, { min: 1, max: 1 })).toBe(1);
    expect(sharedProtocolVersion({ min: 2, max: 3 }, { min: 1, max: 1 })).toBeUndefined();
  });

  it("should read known messages, keep a newer peer's tool calls and error codes answerable, and drop the rest", () => {
    const toolCall = { type: "tool.call", id: "x1", name: "read_file", input: { path: "query.ts" } };
    const companionHello = {
      type: "hello",
      role: "companion",
      protocol: { min: 1, max: 1 },
      companion: { version: "0.1.0", mode: "chat", agents: [{ id: "claude", name: "Claude Code" }] },
    };

    expect(readConnectMessage(toolCall)).toEqual({
      type: "tool.call",
      id: "x1",
      name: "read_file",
      input: { path: "query.ts" },
    });
    expect(readConnectMessage({ type: "tool.call", id: "x1", name: "bash", input: {}, conversation: "c1" })).toEqual({
      type: "tool.unknown",
      id: "x1",
      name: "bash",
      conversation: "c1",
    });
    expect(readConnectMessage({ type: "tool.call", id: "", name: "read_file", input: {} })).toBeUndefined();
    expect(
      readConnectMessage({ type: "tool.result", id: "x1", ok: false, error: { code: "conflict", message: "m" } }),
    ).toMatchObject({ ok: false });
    expect(
      readConnectMessage({ type: "tool.result", id: "x1", ok: false, error: { code: "other", message: "m" } }),
    ).toEqual({ type: "tool.result", id: "x1", ok: false, error: { code: "failed", message: "m" } });
    expect(readConnectMessage({ type: "chat.send", conversation: "c", text: "t", mode: "root" })).toBeUndefined();
    expect(readConnectMessage({ type: "nope" })).toBeUndefined();
    expect(readConnectMessage(companionHello)).toMatchObject({ companion: { agents: [{ id: "claude" }] } });
  });

  it("should read relay frames", () => {
    const busyFrame = JSON.stringify({ t: "busy", scope: "daily", retryAt: "2026-10-16T00:00:00.000Z" });
    const unknownRoleFrame = JSON.stringify({ t: "peer", event: "join", peer: { id: "a", role: "admin" } });

    expect(parseRelayServerFrame(busyFrame)).toEqual({
      t: "busy",
      scope: "daily",
      retryAt: "2026-10-16T00:00:00.000Z",
    });
    expect(parseRelayServerFrame("{")).toBeUndefined();
    expect(parseRelayServerFrame(unknownRoleFrame)).toBeUndefined();
    expect(
      parseRelayServerFrame(
        JSON.stringify({ t: "quota", per: "account", used: 3_800, limit: 10_000, resetAt: "2026-10-16T00:00:00.000Z" }),
      ),
    ).toEqual({ t: "quota", per: "account", used: 3_800, limit: 10_000, resetAt: "2026-10-16T00:00:00.000Z" });

    for (const quota of [
      { used: -1, limit: 10_000, resetAt: "2026-10-16T00:00:00.000Z" },
      { used: 1.5, limit: 10_000, resetAt: "2026-10-16T00:00:00.000Z" },
      { used: 1, limit: "10000", resetAt: "2026-10-16T00:00:00.000Z" },
      { used: 1, limit: 10_000, resetAt: "tomorrow" },
      { used: 1, limit: 10_000 },
    ]) {
      expect(parseRelayServerFrame(JSON.stringify({ t: "quota", per: "connection", ...quota }))).toBeUndefined();
    }

    for (const per of ["user", undefined]) {
      expect(
        parseRelayServerFrame(
          JSON.stringify({ t: "quota", per, used: 1, limit: 10_000, resetAt: "2026-10-16T00:00:00.000Z" }),
        ),
      ).toBeUndefined();
    }
    expect(parseRelayClientFrame(JSON.stringify({ t: "send", d: "x.y", to: "p1" }))).toEqual({
      t: "send",
      d: "x.y",
      to: "p1",
    });
    expect(parseRelayClientFrame(JSON.stringify({ t: "send", d: 3 }))).toBeUndefined();
  });

  it("should find the next UTC midnight and build the command", () => {
    expect(nextUtcMidnight(Date.parse("2026-10-15T23:59:00Z")).toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(connectCommand({ secret: SECRET })).toBe("npx @drizzle-run/connect k7Pq-2xZm-9fLw");
    expect(connectCommand()).toBe("npx @drizzle-run/connect");
    expect(connectCommand({ origin: "https://drizzle.run", mcp: true })).toBe("npx @drizzle-run/connect --mcp");
    expect(connectCommand({ origin: "https://drizzle.run", latest: true })).toBe("npx @drizzle-run/connect@latest");
    expect(connectCommand({ origin: "https://preview.drizzle.run" })).toBe(
      "npx @drizzle-run/connect --relay https://preview.drizzle.run",
    );
  });

  it("should run a preview's own companion build, pinned even when asked for the latest", () => {
    const packageCommand = "npx https://pkg.pr.new/rphlmr/drizzle-run/@drizzle-run/connect@0123abc";

    expect(connectCommand({ secret: SECRET, origin: "https://next.drizzle.run", packageCommand })).toBe(
      `${packageCommand} k7Pq-2xZm-9fLw --relay https://next.drizzle.run`,
    );
    expect(connectCommand({ origin: "https://next.drizzle.run", latest: true, packageCommand })).toBe(
      `${packageCommand} --relay https://next.drizzle.run`,
    );
    expect(connectCommand({ origin: "http://127.0.0.1:4173", packageCommand })).toBe(
      "node packages/connect/dist/cli.js --relay http://127.0.0.1:4173",
    );
  });

  it("should run the checkout's own build on a local server", () => {
    const nonLocalOrigins = ["https://drizzle.run", "http://localhost.example.com", "not a url"];

    expect(connectCommand({ secret: SECRET, origin: "http://127.0.0.1:4173" })).toBe(
      "node packages/connect/dist/cli.js k7Pq-2xZm-9fLw --relay http://127.0.0.1:4173",
    );
    expect(connectCommand({ origin: "http://localhost:4173", latest: true })).toBe(
      "node packages/connect/dist/cli.js --relay http://localhost:4173",
    );
    expect(connectCommand({ origin: "http://[::1]:4173", mcp: true })).toBe(
      "node packages/connect/dist/cli.js --mcp --relay http://[::1]:4173",
    );
    expect(nonLocalOrigins.map((origin) => isLocalOrigin(origin))).toEqual([false, false, false]);
  });
});

describe("tool inputs", () => {
  it("should define every tool with an object schema, edit tools marked", () => {
    expect(CONNECT_TOOLS.map((tool) => tool.name)).toEqual([
      "get_project",
      "read_file",
      "get_problems",
      "get_latest_run",
      "apply_edits",
      "run",
      "switch_release",
      "create_project",
      "fork_project",
      "get_query_plans_settings",
      "set_query_plans_settings",
      "get_query_plans",
      "get_guide",
      "read_docs",
    ]);
    expect(CONNECT_TOOLS.filter((tool) => tool.edits).map((tool) => tool.name)).toEqual([
      "apply_edits",
      "switch_release",
      "create_project",
    ]);
    expect(CONNECT_TOOLS.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("should accept valid input and explain invalid input", () => {
    expect(parseToolInput("read_file", { path: "query.ts", side: 1 })).toEqual({
      ok: true,
      call: { name: "read_file", input: { path: "query.ts", side: 1 } },
    });
    expect(parseToolInput("read_file", { path: "query.ts", side: 2 })).toEqual({
      ok: false,
      message: "side must be 0 or 1.",
    });
    expect(parseToolInput("read_file", { path: "../secrets.ts" })).toEqual({
      ok: false,
      message: 'path must be a project file path such as "schema.ts", not "../secrets.ts".',
    });
    expect(parseToolInput("get_project", { extra: true })).toEqual({ ok: false, message: "Unknown field extra." });
    expect(parseToolInput("run", undefined)).toEqual({ ok: true, call: { name: "run", input: {} } });
    expect(parseToolInput("apply_edits", { edits: [] })).toMatchObject({ ok: false });
    expect(parseToolInput("apply_edits", { edits: [{ path: "query.ts", new_text: "x", mode: "rm" }] })).toMatchObject({
      ok: false,
    });
    expect(parseToolInput("set_query_plans_settings", { on: true, size: "1m" })).toEqual({
      ok: true,
      call: { name: "set_query_plans_settings", input: { on: true, size: "1m" } },
    });
    expect(parseToolInput("set_query_plans_settings", { size: "10m" })).toMatchObject({ ok: false });
    expect(parseToolInput("get_query_plans", { view: "raw", query: 0 })).toEqual({
      ok: true,
      call: { name: "get_query_plans", input: { view: "raw", query: 0 } },
    });
    expect(parseToolInput("get_query_plans", { view: "reading", side: 1 })).toEqual({
      ok: true,
      call: { name: "get_query_plans", input: { view: "reading", side: 1 } },
    });
    expect(parseToolInput("get_query_plans", { view: "reading", side: 3 })).toEqual({
      ok: false,
      message: "side must be 0 or 1.",
    });
    expect(parseToolInput("create_project", { name: " Bank ", dialect: "sqlite" })).toEqual({
      ok: true,
      call: { name: "create_project", input: { name: "Bank", dialect: "sqlite" } },
    });
    expect(parseToolInput("create_project", { name: "Bank", dialect: "mysql" })).toMatchObject({ ok: false });
  });

  it("should list each tool's input schema with the limits its parser checks", () => {
    const applyEdits = connectTool("apply_edits").inputSchema;

    expect(applyEdits).toMatchObject({
      type: "object",
      required: ["edits"],
      additionalProperties: false,
      properties: {
        edits: {
          minItems: 1,
          maxItems: 20,
          items: { required: ["path", "new_text"], properties: { new_text: { maxLength: 200_000 } } },
        },
        summary: { maxLength: 300 },
      },
    });
    expect(connectTool("get_query_plans").inputSchema).toMatchObject({
      properties: { query: { type: "integer", minimum: 0 } },
    });
    expect(applyEdits).not.toHaveProperty("$schema");
  });

  it("should name the edit that is not an object, and an edit's unknown field", () => {
    expect(parseToolInput("apply_edits", { edits: [{ path: "query.ts", new_text: "x" }, 3] })).toEqual({
      ok: false,
      message: "edits[1] needs path and new_text, and old_text when replacing.",
    });
    expect(parseToolInput("apply_edits", { edits: [{ path: "query.ts", new_text: "x", mode: "rm" }] })).toEqual({
      ok: false,
      message: "edits[0] has an unknown field mode.",
    });
    expect(parseToolInput("apply_edits", { edits: [{ path: "../a.ts", new_text: "x" }] })).toEqual({
      ok: false,
      message: 'edits[0].path must be a project file path such as "schema.ts", not "../a.ts".',
    });
  });

  it("should take an optional guest_flavor on switch_release and create_project, and refuse any other flavor", () => {
    expect(parseToolInput("switch_release", { orm_version: "1.0.0-rc.5", guest_flavor: "effect" })).toEqual({
      ok: true,
      call: { name: "switch_release", input: { orm_version: "1.0.0-rc.5", guest_flavor: "effect" } },
    });
    expect(parseToolInput("create_project", { name: "Fx", dialect: "postgresql", guest_flavor: "slim" })).toEqual({
      ok: true,
      call: { name: "create_project", input: { name: "Fx", dialect: "postgresql", guest_flavor: "slim" } },
    });

    for (const name of ["switch_release", "create_project"] as const) {
      expect(
        parseToolInput(name, { name: "Fx", dialect: "sqlite", orm_version: "1.0.0-rc.5", guest_flavor: "full" }),
      ).toEqual({ ok: false, message: "guest_flavor must be one of slim, effect." });
    }
  });

  it("should take an optional database on switch_release, to move a side to the other one", () => {
    expect(parseToolInput("switch_release", { orm_version: "1.0.0-rc.5", side: 1, database: "sqlite" })).toEqual({
      ok: true,
      call: { name: "switch_release", input: { orm_version: "1.0.0-rc.5", side: 1, database: "sqlite" } },
    });
    expect(parseToolInput("switch_release", { orm_version: "1.0.0-rc.5", database: "mysql" })).toMatchObject({
      ok: false,
    });
  });
});

describe("tool scopes", () => {
  it("should offer a guided tour only reads, the guide, and the docs: no edit, no run, no release switch, no Query plans setter", () => {
    const outOfScopeTools = [
      "apply_edits",
      "run",
      "switch_release",
      "create_project",
      "set_query_plans_settings",
      "get_query_plans_settings",
      "get_query_plans",
    ] as const;

    expect(connectToolsFor("guide").map((tool) => tool.name)).toEqual([
      "get_project",
      "read_file",
      "get_problems",
      "get_latest_run",
      "get_guide",
      "read_docs",
    ]);
    expect(connectToolsFor("guide").some((tool) => tool.edits)).toBe(false);

    for (const name of outOfScopeTools) {
      expect(isToolInScope(name, "guide")).toBe(false);
    }
  });

  it("should offer a shared link reads only, and a project everything but the guided tools and fork_project", () => {
    expect(connectToolsFor("snapshot").map((tool) => tool.name)).toEqual([
      "get_project",
      "read_file",
      "get_problems",
      "get_latest_run",
      "fork_project",
    ]);
    expect(connectToolsFor("project").map((tool) => tool.name)).not.toContain("get_guide");
    expect(connectToolsFor("project").map((tool) => tool.name)).not.toContain("read_docs");
    expect(connectToolsFor("project").map((tool) => tool.name)).not.toContain("fork_project");
    expect(connectToolsFor("project")).toHaveLength(CONNECT_TOOLS.length - 3);
  });

  it("should offer an untrusted project the same read-only tools as a shared link", () => {
    expect(connectToolsFor("untrusted")).toEqual(connectToolsFor("snapshot"));
    expect(connectToolsFor("untrusted").some((tool) => tool.edits)).toBe(false);

    for (const name of [
      "apply_edits",
      "run",
      "switch_release",
      "create_project",
      "set_query_plans_settings",
    ] as const) {
      expect(isToolInScope(name, "untrusted")).toBe(false);
      expect(scopeRefusal(name, "untrusted")).toMatch(/until the user presses Allow AI edits/);
    }
  });

  it("should read fork_project input and refuse anything but a name", () => {
    expect(parseToolInput("fork_project", {})).toEqual({ ok: true, call: { name: "fork_project", input: {} } });
    expect(parseToolInput("fork_project", { name: " Mine " })).toEqual({
      ok: true,
      call: { name: "fork_project", input: { name: "Mine" } },
    });
    expect(parseToolInput("fork_project", { name: "" })).toMatchObject({ ok: false });
    expect(parseToolInput("fork_project", { name: "Mine", trust: "trusted" })).toEqual({
      ok: false,
      message: "Unknown field trust.",
    });
  });

  it("should read read_docs and get_guide inputs", () => {
    expect(parseToolInput("read_docs", {})).toEqual({ ok: true, call: { name: "read_docs", input: {} } });
    expect(parseToolInput("read_docs", { url: " /docs/select " })).toEqual({
      ok: true,
      call: { name: "read_docs", input: { url: "/docs/select" } },
    });
    expect(parseToolInput("read_docs", { url: 3 })).toMatchObject({ ok: false });
    expect(parseToolInput("read_docs", { url: "https://orm.drizzle.team/docs/select", follow: true })).toEqual({
      ok: false,
      message: "Unknown field follow.",
    });
    expect(parseToolInput("get_guide", { step: 2 })).toMatchObject({ ok: false });
  });

  it("should carry the chat's scope in chat.send, and read an unknown one as read only", () => {
    const chatSend = { type: "chat.send", conversation: "g-transactions", text: "Why?", mode: "ask" };

    expect(readConnectMessage({ ...chatSend, scope: "guide" })).toMatchObject({ scope: "guide" });
    expect(readConnectMessage(chatSend)).not.toHaveProperty("scope");
    expect(readConnectMessage({ ...chatSend, scope: "exercise" })).toMatchObject({ scope: "untrusted" });
    expect(readConnectMessage({ ...chatSend, scope: 3 })).toMatchObject({ scope: "untrusted" });
  });

  it("should carry a side-by-side project's two sides in chat.send and drop malformed ones", () => {
    const sides = [
      { side: 0, name: "0.45", orm: "0.45.4" },
      { side: 1, name: "rc.5", orm: "1.0.0-rc.5" },
    ];
    const chatSend = { type: "chat.send", conversation: "p-upgrade", text: "Why?", mode: "ask" };

    expect(readConnectMessage({ ...chatSend, project: { id: "p", name: "Upgrade", sides } })).toMatchObject({
      project: { id: "p", name: "Upgrade", sides },
    });
    expect(
      readConnectMessage({ ...chatSend, project: { id: "p", name: "Upgrade", sides: [sides[1], sides[0]] } }),
    ).toMatchObject({ project: { id: "p", name: "Upgrade" } });
    expect(
      readConnectMessage({ ...chatSend, project: { id: "p", name: "Upgrade", sides: [sides[0]] } }),
    ).not.toHaveProperty("project.sides");
  });

  it("should carry a community project's origin in chat.send and drop any other origin", () => {
    const chatSend = { type: "chat.send", conversation: "p-forked", text: "Why?", mode: "ask" };

    expect(
      readConnectMessage({ ...chatSend, project: { id: "p", name: "Forked", origin: "community" } }),
    ).toMatchObject({ project: { origin: "community" } });
    expect(
      readConnectMessage({ ...chatSend, project: { id: "p", name: "Forked", origin: "trusted" } }),
    ).not.toHaveProperty("project.origin");
  });
});

describe("agent tuning", () => {
  const agent: CompanionAgent = {
    id: "codex",
    name: "Codex",
    models: [
      { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"] },
      { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", efforts: ["medium"] },
    ],
    defaults: { model: "gpt-6-luna", effort: "medium" },
  };
  const chatSend = { type: "chat.send", conversation: "p-chat", text: "Why?", mode: "ask" };

  it("should carry the chat's agent and its context in chat.send, and refuse an unknown agent or a longer context", () => {
    const context = [
      { from: "user", text: "Hi" },
      { from: "agent", text: "Hello." },
    ];

    expect(readConnectMessage({ ...chatSend, agent: "codex", context })).toMatchObject({ agent: "codex", context });
    expect(readConnectMessage({ ...chatSend, agent: "grok" })).toMatchObject({ agent: "grok" });
    expect(readConnectMessage({ ...chatSend, agent: "gemini" })).toBeUndefined();
    expect(readConnectMessage({ ...chatSend, context: "User: Hi" })).toBeUndefined();
    expect(readConnectMessage({ ...chatSend, context: [{ from: "system", text: "Hi" }] })).toBeUndefined();
    expect(
      readConnectMessage({
        ...chatSend,
        context: [
          { from: "user", text: "x".repeat(30_000) },
          { from: "agent", text: "x".repeat(30_001) },
        ],
      }),
    ).toBeUndefined();
  });

  it("should carry a model and an effort in chat.send, and refuse a malformed one", () => {
    expect(readConnectMessage({ ...chatSend, model: "claude-opus-5-5[1m]", effort: "xhigh" })).toMatchObject({
      model: "claude-opus-5-5[1m]",
      effort: "xhigh",
    });
    expect(readConnectMessage({ ...chatSend, model: "--dangerously-skip-permissions" })).toBeUndefined();
    expect(readConnectMessage({ ...chatSend, effort: "ultra" })).toBeUndefined();
  });

  it("should read a companion's models and defaults, and drop malformed ones", () => {
    const hello = { type: "hello", role: "companion", protocol: { min: 1, max: 1 } };
    const companion = { version: "0.1.0", mode: "chat" };

    expect(readConnectMessage({ ...hello, companion: { ...companion, agents: [agent] } })).toMatchObject({
      companion: { agents: [agent] },
    });
    expect(
      readConnectMessage({
        ...hello,
        companion: { ...companion, agents: [{ ...agent, models: [{ id: "-x", name: "X", efforts: [] }] }] },
      }),
    ).not.toHaveProperty("companion.agents.0.models");
    expect(
      readConnectMessage({
        ...hello,
        companion: { ...companion, agents: [{ ...agent, defaults: { model: "gpt-6-luna", effort: "ultra" } }] },
      }),
    ).not.toHaveProperty("companion.agents.0.defaults");
  });

  it("should keep only the model and effort the agent offers together", () => {
    expect(resolveAgentTuning(agent, {})).toEqual({});
    expect(resolveAgentTuning(agent, { model: "gpt-6-luna", effort: "high" })).toEqual({
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(resolveAgentTuning(agent, { model: "gpt-5.6-terra" })).toEqual({ model: "gpt-5.6-terra" });
    expect(resolveAgentTuning(agent, { model: "gpt-5.6-terra", effort: "high" })).toBeNull();
    expect(resolveAgentTuning(agent, { effort: "medium" })).toBeNull();
    expect(resolveAgentTuning(agent, { model: "o3" })).toBeNull();
    expect(fitAgentTuning(agent, { model: "gpt-5.6-terra", effort: "high" })).toEqual({ model: "gpt-5.6-terra" });
    expect(fitAgentTuning(agent, { model: "o3", effort: "high" })).toEqual({});
  });
});

describe("read_docs allowlist", () => {
  const sources = [
    "https://orm.drizzle.team/docs/upgrade-v1",
    "https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.4",
  ];

  it("should allow docs pages for both databases, the index, and paths on the docs site", () => {
    expect(checkDocsUrl("https://orm.drizzle.team/docs/transactions", sources)).toEqual({
      ok: true,
      url: "https://orm.drizzle.team/docs/transactions",
      kind: "docs",
    });
    expect(checkDocsUrl("https://orm.drizzle.team/docs/sqlite/select", sources)).toEqual({
      ok: true,
      url: "https://orm.drizzle.team/docs/sqlite/select",
      kind: "docs",
    });
    expect(checkDocsUrl("/docs/get-started/postgresql-new", sources)).toMatchObject({ ok: true, kind: "docs" });
    expect(checkDocsUrl("https://orm.drizzle.team/llms.txt", sources)).toEqual({
      ok: true,
      url: "https://orm.drizzle.team/llms.txt",
      kind: "index",
    });
    expect(checkDocsUrl("https://orm.drizzle.team/docs/select/#limit", sources)).toMatchObject({
      ok: true,
      url: "https://orm.drizzle.team/docs/select",
    });
  });

  it("should allow a guide's own sources exactly as listed, and mark docs pages it lists", () => {
    expect(checkDocsUrl("https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.4", sources)).toMatchObject({
      ok: true,
      kind: "source",
    });
    expect(checkDocsUrl("https://orm.drizzle.team/docs/upgrade-v1", sources)).toMatchObject({
      ok: true,
      kind: "source",
    });
    expect(checkDocsUrl("https://github.com/drizzle-team/drizzle-orm/releases", sources)).toMatchObject({ ok: false });
  });

  it("should refuse everything else", () => {
    for (const url of [
      "http://orm.drizzle.team/docs/select",
      "https://orm.drizzle.team.example.com/docs/select",
      "https://evil.example/docs/select",
      "https://user:pass@orm.drizzle.team/docs/select",
      "https://orm.drizzle.team:8443/docs/select",
      "https://orm.drizzle.team/docs/select?redirect=https://evil.example",
      "https://orm.drizzle.team/blog/hello",
      "https://orm.drizzle.team/docs",
      "https://orm.drizzle.team/docs/../admin",
      "https://orm.drizzle.team/docs/Select",
      "https://orm.drizzle.team/docs/a%2Fb",
      "//evil.example/docs/select",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "docs/select",
    ]) {
      expect(checkDocsUrl(url, sources), url).toMatchObject({ ok: false });
    }
  });

  it("should turn a docs page into text: the main content, no scripts or navigation", () => {
    const html = [
      "<html><head><script>steal()</script></head><body><nav>Menu</nav><main>",
      "<h1>Transactions</h1><p>Use <code>db.transaction</code> &amp; savepoints.</p>",
      "<pre><code>await db.transaction(async (tx) =&gt; {\n});</code></pre>",
      "<ul><li>One</li><li>Two</li></ul><script>more()</script>",
      "</main><footer>Footer</footer></body></html>",
    ].join("");
    const { text, truncated } = docsText(html);

    expect(truncated).toBe(false);
    expect(text).toContain("# Transactions");
    expect(text).toContain("Use db.transaction & savepoints.");
    expect(text).toContain("await db.transaction(async (tx) => {");
    expect(text).toContain("- One");
    expect(text).not.toMatch(/steal|more\(\)|Menu|Footer/);
    expect(docsText(`<main>${"a".repeat(DOCS_TEXT_MAX_CHARS + 10)}</main>`)).toMatchObject({ truncated: true });
    expect(docsText("<main>&#x110000; &#99999999; &#x41;</main>").text).toBe("&#x110000; &#99999999; A");
  });
});

describe("file edits", () => {
  const files = { "query.ts": "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n" };

  it("should replace text that matches once and count lines", () => {
    const result = applyFileEdits(files, [
      { path: "query.ts", old_text: "const b = 2;", new_text: "const b = 3;\nconst c = 4;" },
    ]);

    expect(result).toMatchObject({ ok: true, changes: [{ path: "query.ts", added: 2, removed: 1 }] });
    expect(result.ok && result.files["query.ts"]).toBe(
      "const a = 1;\nconst b = 3;\nconst c = 4;\nconsole.log(a + b);\n",
    );
  });

  it("should write and create whole files, keeping `$&` literal", () => {
    const result = applyFileEdits(files, [
      { path: "helpers.ts", new_text: "export const x = 1;\n" },
      { path: "query.ts", old_text: "a + b", new_text: "`$&`" },
    ]);

    expect(result.ok && result.files["helpers.ts"]).toBe("export const x = 1;\n");
    expect(result.ok && result.files["query.ts"]).toContain("console.log(`$&`);");
    expect(result.ok && result.changes.find((change) => change.path === "helpers.ts")?.before).toBeUndefined();
  });

  it("should refuse missing, ambiguous, absent-file and no-op edits, changing nothing", () => {
    const notFound = applyFileEdits(files, [{ path: "query.ts", old_text: "nope", new_text: "x" }]);
    const ambiguous = applyFileEdits(files, [{ path: "query.ts", old_text: "const", new_text: "let" }]);
    const missingFile = applyFileEdits(files, [{ path: "seed.ts", old_text: "x", new_text: "y" }]);
    const unchanged = applyFileEdits(files, [{ path: "query.ts", new_text: files["query.ts"] }]);

    expect(notFound).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "ambiguous" } });
    expect(missingFile).toMatchObject({ ok: false, error: { code: "missing_file" } });
    expect(unchanged).toMatchObject({ ok: false, error: { code: "unchanged" } });
    expect(files["query.ts"]).toBe("const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");
  });

  it("should refuse an old_text that matches twice where the matches overlap", () => {
    const result = applyFileEdits({ "query.ts": "x\n});\n});\n});\n" }, [
      { path: "query.ts", old_text: "});\n});", new_text: "end" },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: "ambiguous" } });
  });

  it("should write a file named like an object key as a file, leaving the prototype alone", () => {
    const result = applyFileEdits(files, [{ path: "__proto__", new_text: "polluted" }]);

    expect(result.ok && Object.hasOwn(result.files, "__proto__")).toBe(true);
    expect(result.ok && Object.getPrototypeOf(result.files)).toBe(Object.prototype);
    expect(parseToolInput("apply_edits", { edits: [{ path: "__proto__", new_text: "x" }] })).toMatchObject({
      ok: false,
    });
    expect(parseToolInput("apply_edits", { edits: [{ path: "toString", new_text: "x" }] })).toMatchObject({
      ok: false,
    });
  });

  it("should count line changes from the common subsequence", () => {
    expect(countLineChanges("a\nb\nc", "a\nx\nc")).toEqual({ added: 1, removed: 1 });
    expect(countLineChanges("", "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(countLineChanges("a\nb\nc\nd", "a\nd")).toEqual({ added: 0, removed: 2 });
  });
});
