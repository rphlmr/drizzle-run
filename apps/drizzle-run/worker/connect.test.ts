import {
  CONNECT_ROOM_PROTOCOL,
  CONNECT_LIMITS,
  deriveConnectKeys,
  RELAY_CLOSE,
  SecureChannel,
  toRoomId,
  type RelayServerFrame,
} from "@drizzle-run/core/connect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fetchWorker } from "../test/worker/worker-app";
import {
  CONNECT_QUOTA_KEY_HEADER,
  hasRoomProof,
  type DurableObjectStateLike,
  type RelaySocket,
} from "./connect-platform";
import {
  CLIENT_DAILY_MESSAGES,
  ConnectQuota,
  DEFAULT_DAILY_MESSAGES,
  getDailyMessageLimit,
  grantMessages,
  reserveDailyMessages,
  type QuotaGrant,
} from "./connect-quota";
import { ConnectRoom, ConnectRoomCore, ROOM_LIMITS } from "./connect-room";
import { closeUpgrade, type ConnectRouteServices } from "./connect-route";
import { toRateLimitAddress } from "./http";
import type { WorkerEnvironment } from "./platform";

class FakeSocket implements RelaySocket {
  sent: RelayServerFrame[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private attachment: unknown;

  send(message: string): void {
    if (this.closed) {
      throw new Error("closed");
    }

    this.sent.push(JSON.parse(message) as RelayServerFrame);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  frames<Type extends RelayServerFrame["t"]>(type: Type): Extract<RelayServerFrame, { t: Type }>[] {
    return this.sent.filter((frame): frame is Extract<RelayServerFrame, { t: Type }> => frame.t === type);
  }
}

function makeFakeState({ waitBeforePut = async () => {} }: { waitBeforePut?: () => Promise<void> } = {}) {
  const storage = new Map<string, unknown>();
  let alarm: number | null = null;
  const sockets: FakeSocket[] = [];
  const state: DurableObjectStateLike = {
    storage: {
      async get<Value>(key: string) {
        return storage.get(key) as Value | undefined;
      },
      async put(key, value) {
        await waitBeforePut();
        storage.set(key, structuredClone(value));
      },
      async deleteAll() {
        storage.clear();
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(time) {
        alarm = time;
      },
    },
    acceptWebSocket(socket) {
      if (socket instanceof FakeSocket) {
        sockets.push(socket);
      }
    },
    getWebSockets() {
      return sockets.filter((socket) => socket.closed === undefined);
    },
    blockConcurrencyWhile: (callback) => callback(),
  };

  return { state, storage, alarm: () => alarm };
}

function createRoom(
  options: {
    reserve?: (amount: number, key: string) => Promise<QuotaGrant>;
    now?: () => number;
    waitBeforePut?: () => Promise<void>;
  } = {},
) {
  const clock = { time: Date.parse("2026-10-15T10:00:00Z") };
  let ids = 0;
  const fake = makeFakeState({ waitBeforePut: options.waitBeforePut });
  const core = new ConnectRoomCore(fake.state, options.reserve ?? (async (amount) => ({ granted: amount })), {
    now: options.now ?? (() => clock.time),
    randomId: () => `peer${++ids}`,
  });

  return { core, clock, ...fake };
}

const CLIENT_KEY = "address:203.0.113.5";

function send(d: string, to?: string) {
  return JSON.stringify({ t: "send", d, ...(to ? { to } : {}) });
}

describe("AI chat room", () => {
  it("should welcome peers, announce joins and leaves, and forward sealed payloads between the tab and the companion", async () => {
    const { core } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    const tabId = await core.join(tab, "tab", CLIENT_KEY);
    const companionId = await core.join(companion, "companion", CLIENT_KEY);

    expect(tab.sent[0]).toEqual({
      t: "welcome",
      id: tabId,
      role: "tab",
      peers: [],
      maxFrameBytes: CONNECT_LIMITS.maxFrameBytes,
    });
    expect(companion.sent[0]).toEqual({
      t: "welcome",
      id: companionId,
      role: "companion",
      peers: [{ id: tabId, role: "tab" }],
      maxFrameBytes: CONNECT_LIMITS.maxFrameBytes,
    });
    expect(tab.frames("peer")).toEqual([{ t: "peer", event: "join", peer: { id: companionId, role: "companion" } }]);

    await core.message(tab, send("iv.payload"));
    await core.message(companion, send("iv.reply", tabId));

    expect(companion.frames("data")).toEqual([{ t: "data", from: tabId, d: "iv.payload" }]);
    expect(tab.frames("data")).toEqual([{ t: "data", from: companionId, d: "iv.reply" }]);

    core.leave(companion);
    expect(tab.frames("peer").at(-1)).toEqual({
      t: "peer",
      event: "leave",
      peer: { id: companionId, role: "companion" },
    });
  });

  it("should relay only ciphertext: the frames it forwards carry no plaintext", async () => {
    const { core } = createRoom();
    const { key } = await deriveConnectKeys("k7Pq-2xZm-9fLw", { iterations: 1_000 });
    const tabChannel = new SecureChannel({ key, role: "tab" });
    const companionChannel = new SecureChannel({ key, role: "companion" });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    const tabId = await core.join(tab, "tab", CLIENT_KEY);
    const companionId = await core.join(companion, "companion", CLIENT_KEY);

    await core.message(
      tab,
      send(await tabChannel.hello(companionId ?? "", { type: "hello", role: "tab", protocol: { min: 1, max: 1 } })),
    );
    await companionChannel.open(tabId ?? "", companion.frames("data")[0]?.d ?? "");
    await core.message(
      companion,
      send(
        await companionChannel.hello(tabId ?? "", { type: "hello", role: "companion", protocol: { min: 1, max: 1 } }),
        tabId,
      ),
    );
    await tabChannel.open(companionId ?? "", tab.frames("data")[0]?.d ?? "");
    await core.message(
      tab,
      send(
        await tabChannel.seal(companionId ?? "", {
          type: "chat.send",
          conversation: "c1",
          text: "Move 130 from Ada to Grace",
          mode: "edit",
        }),
      ),
    );

    const forwarded = JSON.stringify(companion.sent);

    expect(forwarded).not.toContain("Ada");
    expect(forwarded).not.toContain("chat.send");
    expect(await companionChannel.open(tabId ?? "", companion.frames("data")[1]?.d ?? "")).toMatchObject({
      ok: true,
      message: { text: "Move 130 from Ada to Grace" },
    });
  });

  it("should answer no_peer when the other side is not there, and route a companion's `to`", async () => {
    const { core } = createRoom();
    const tab = new FakeSocket();
    const otherTab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.message(tab, send("x.y"));
    expect(tab.frames("error")).toEqual([{ t: "error", code: "no_peer", message: "The companion is not connected." }]);

    const otherId = await core.join(otherTab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    await core.message(companion, send("x.only", otherId));
    await core.message(companion, send("x.all"));

    expect(tab.frames("data").map((frame) => frame.d)).toEqual(["x.all"]);
    expect(otherTab.frames("data").map((frame) => frame.d)).toEqual(["x.only", "x.all"]);
  });

  it("should close a socket that keeps sending with no peer to receive it", async () => {
    const { core } = createRoom();
    const tab = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);

    for (let index = 0; index <= ROOM_LIMITS.maxStrikes; index += 1) {
      await core.message(tab, send(`x.${index}`));
    }

    expect(tab.frames("error")).toHaveLength(ROOM_LIMITS.maxStrikes);
    expect(tab.closed?.code).toBe(RELAY_CLOSE.misbehaving);
  });

  it("should refuse frames over the size cap, binary frames, and malformed frames", async () => {
    const { core } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    await core.message(tab, send("x".repeat(CONNECT_LIMITS.maxFrameBytes)));
    await core.message(tab, send("é".repeat(Math.ceil(CONNECT_LIMITS.maxFrameBytes / 2))));
    await core.message(tab, new ArrayBuffer(4));
    await core.message(tab, '{"t":"shout"}');

    expect(tab.frames("error").map((frame) => frame.code)).toEqual([
      "too_large",
      "too_large",
      "bad_frame",
      "bad_frame",
    ]);
    expect(companion.frames("data")).toEqual([]);
  });

  it("should rate limit each socket, refill over time, and close one that keeps breaking the rules", async () => {
    const { core, clock } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    for (let index = 0; index < ROOM_LIMITS.burst + 5; index += 1) {
      await core.message(tab, send(`m.${index}`));
    }

    expect(companion.frames("data")).toHaveLength(ROOM_LIMITS.burst);
    expect(tab.frames("error").filter((frame) => frame.code === "rate_limited")).toHaveLength(5);

    clock.time += 1_000;
    await core.message(tab, send("m.later"));
    expect(companion.frames("data").at(-1)?.d).toBe("m.later");

    for (let index = 0; index <= ROOM_LIMITS.maxStrikes; index += 1) {
      await core.message(tab, "nope");
    }

    expect(tab.closed?.code).toBe(RELAY_CLOSE.misbehaving);
  });

  it("should forgive strikes over time, so a socket that slows down after bursts stays open", async () => {
    const { core, clock } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    for (let round = 0; round < 10; round += 1) {
      for (let index = 0; index < ROOM_LIMITS.burst + 10; index += 1) {
        await core.message(tab, send(`r${round}.${index}`));
      }

      clock.time += 10_000;
    }

    expect(tab.frames("error").filter((frame) => frame.code === "rate_limited")).toHaveLength(100);
    expect(tab.closed).toBeUndefined();
  });

  it("should log a quota reservation that fails, and grant nothing for it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quotaFailure = new Error("The quota object is unreachable");
    const { core } = createRoom({
      reserve: async () => {
        throw quotaFailure;
      },
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    await core.message(tab, send("m.0"));

    expect(companion.frames("data")).toHaveLength(0);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      event: "quota_reservation_failed",
      err: { message: quotaFailure.message },
    });
    consoleError.mockRestore();
  });

  it("should be busy for the day when the daily quota is spent, tell each socket once, and reset at midnight UTC", async () => {
    let left = 3;
    const { core, clock } = createRoom({
      reserve: async (amount) => {
        const granted = Math.min(amount, left);
        left -= granted;

        return { granted };
      },
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    for (let index = 0; index < 5; index += 1) {
      await core.message(tab, send(`m.${index}`));
    }

    expect(companion.frames("data")).toHaveLength(3);
    expect(tab.frames("busy")).toEqual([{ t: "busy", scope: "daily", retryAt: "2026-10-16T00:00:00.000Z" }]);
    expect(companion.frames("busy")).toHaveLength(1);
    expect(tab.closed).toBeUndefined();

    clock.time = Date.parse("2026-10-16T00:00:01Z");
    left = 10;
    await core.message(tab, send("m.tomorrow"));
    expect(companion.frames("data").at(-1)?.d).toBe("m.tomorrow");
  });

  it("should be busy once the room alone reaches its daily cap", async () => {
    const { core, storage } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    storage.set("usage", {
      day: "2026-10-15",
      count: ROOM_LIMITS.roomDailyMessages,
      allowance: 10,
      lastActivity: Date.now(),
    });

    const restored = new ConnectRoomCore(
      {
        storage: {
          get: async <Value>(key: string) => storage.get(key) as Value | undefined,
          put: async () => undefined,
          deleteAll: async () => undefined,
          getAlarm: async () => 1,
          setAlarm: async () => undefined,
        },
        acceptWebSocket: () => undefined,
        getWebSockets: () => [tab, companion],
        blockConcurrencyWhile: (callback) => callback(),
      },
      async (amount) => ({ granted: amount }),
      { now: () => Date.parse("2026-10-15T12:00:00Z"), randomId: () => "x" },
    );

    await restored.message(tab, send("m.over"));
    expect(tab.frames("busy")).toEqual([{ t: "busy", scope: "room", retryAt: "2026-10-16T00:00:00.000Z" }]);
    expect(companion.frames("data")).toEqual([]);
  });

  it("should reserve again after eviction instead of replaying the unspent allowance", async () => {
    const asked: number[] = [];
    const reserve = async (amount: number) => {
      asked.push(amount);
      return { granted: amount };
    };
    const { core, state, storage } = createRoom({ reserve });
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    for (let index = 0; index < 3; index += 1) {
      await core.message(tab, send(`m.${index}`));
    }

    expect(asked).toEqual([0, 10]);
    expect(storage.get("usage")).toMatchObject({ count: 10, allowance: 0 });

    const restored = new ConnectRoomCore(state, reserve, {
      now: () => Date.parse("2026-10-15T10:05:00Z"),
      randomId: () => "x",
    });

    await restored.message(tab, send("m.after"));

    expect(asked).toEqual([0, 10, 10]);
    expect(companion.frames("data").map((frame) => frame.d)).toEqual(["m.0", "m.1", "m.2", "m.after"]);
    expect(storage.get("usage")).toMatchObject({ count: 20, allowance: 0 });
  });

  it("should keep one companion: a newer one replaces the older", async () => {
    const { core } = createRoom();
    const tab = new FakeSocket();
    const first = new FakeSocket();
    const second = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    const firstId = await core.join(first, "companion", CLIENT_KEY);
    await core.join(second, "companion", CLIENT_KEY);

    expect(first.closed?.code).toBe(RELAY_CLOSE.replaced);
    expect(tab.frames("peer").map((frame) => [frame.event, frame.peer.id])).toContainEqual(["leave", firstId]);
    await core.message(tab, send("x.y"));
    expect(second.frames("data")).toHaveLength(1);
    expect(first.frames("data")).toHaveLength(0);
  });

  it("should take a limited number of tabs", async () => {
    const { core } = createRoom();

    for (let index = 0; index < ROOM_LIMITS.maxTabs; index += 1) {
      expect(await core.join(new FakeSocket(), "tab", CLIENT_KEY)).toBeDefined();
    }

    const extra = new FakeSocket();

    expect(await core.join(extra, "tab", CLIENT_KEY)).toBeUndefined();
    expect(extra.closed?.code).toBe(RELAY_CLOSE.full);
  });

  it("should expire an idle room by closing its sockets and clearing its storage, and check an active room again later", async () => {
    const { core, clock, storage, alarm } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    expect(alarm()).toBe(clock.time + ROOM_LIMITS.idleMs);

    clock.time += ROOM_LIMITS.idleMs / 2;
    await core.message(tab, send("x.y"));
    await core.alarm();
    expect(tab.closed).toBeUndefined();
    expect(alarm()).toBe(clock.time + ROOM_LIMITS.idleMs);

    clock.time += ROOM_LIMITS.idleMs;
    await core.alarm();
    expect(tab.closed?.code).toBe(RELAY_CLOSE.expired);
    expect(companion.closed?.code).toBe(RELAY_CLOSE.expired);
    expect(storage.size).toBe(0);
  });
});

describe("AI chat rooms sharing one daily quota", () => {
  it("should not let rooms that forward one frame reserve the whole day's quota", async () => {
    const now = Date.parse("2026-10-15T10:00:00Z");
    const quota = makeFakeState();
    const reserve = (amount: number, key: string) =>
      grantMessages(quota.state, DEFAULT_DAILY_MESSAGES, { amount, key }, now);
    const clock = { now: () => now, randomId: () => crypto.randomUUID() };
    const openRoom = async () => {
      const core = new ConnectRoomCore(makeFakeState().state, reserve, clock);
      const tab = new FakeSocket();
      const companion = new FakeSocket();

      await core.join(tab, "tab", CLIENT_KEY);
      await core.join(companion, "companion", CLIENT_KEY);
      await core.message(tab, send("x"));

      return { core, tab, companion };
    };

    for (let index = 0; index < 800; index += 1) {
      const { core, tab, companion } = await openRoom();

      expect(companion.frames("data")).toHaveLength(1);
      tab.close();
      companion.close();
      core.leave(tab);
      core.leave(companion);
      await core.alarm();
    }

    expect(quota.storage.get("quota")).toEqual({ day: "2026-10-15", used: 800 * ROOM_LIMITS.firstQuotaBlock });

    const { tab, companion } = await openRoom();

    expect(companion.frames("data")).toHaveLength(1);
    expect(tab.frames("busy")).toEqual([]);
  });

  it("should keep one client's rooms to its daily share, so another client's room still forwards", async () => {
    let now = Date.parse("2026-10-15T10:00:00Z");
    const quota = makeFakeState();
    const reserve = (amount: number, key: string) =>
      grantMessages(quota.state, DEFAULT_DAILY_MESSAGES, { amount, key }, now);
    const clock = { now: () => now, randomId: () => crypto.randomUUID() };
    const openRoom = async (key: string) => {
      const core = new ConnectRoomCore(makeFakeState().state, reserve, clock);
      const tab = new FakeSocket();
      const companion = new FakeSocket();

      await core.join(tab, "tab", key);
      await core.join(companion, "companion", key);

      return { core, tab, companion };
    };

    const clientKey = "address:2001:db8:1:2::/64";
    const remainingMessages = 2 * ROOM_LIMITS.firstQuotaBlock;

    for (let left = CLIENT_DAILY_MESSAGES - remainingMessages; left > 0; left -= 10_000) {
      await reserve(Math.min(left, 10_000), clientKey);
    }

    for (let room = 0; room < 2; room += 1) {
      const { core, tab, companion } = await openRoom(clientKey);

      for (let index = 0; index < ROOM_LIMITS.firstQuotaBlock; index += 1) {
        now += 50;
        await core.message(tab, send("x"));
      }

      expect(companion.frames("data")).toHaveLength(ROOM_LIMITS.firstQuotaBlock);
    }

    expect(quota.storage.get("quota")).toEqual({ day: "2026-10-15", used: CLIENT_DAILY_MESSAGES });

    const exhausted = await openRoom(clientKey);
    await exhausted.core.message(exhausted.tab, send("x"));

    expect(exhausted.companion.frames("data")).toEqual([]);
    expect(exhausted.tab.frames("busy")).toHaveLength(1);

    const { core, tab, companion } = await openRoom("address:198.51.100.7");

    await core.message(tab, send("x"));
    expect(companion.frames("data")).toHaveLength(1);
    expect(tab.frames("busy")).toEqual([]);
  });

  it("should grow a busy room's reservation with its use, up to the full block", async () => {
    const asked: number[] = [];
    const { core, clock } = createRoom({
      reserve: async (amount) => {
        asked.push(amount);
        return { granted: amount };
      },
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    for (let index = 0; index < 2_000; index += 1) {
      clock.time += 100;
      await core.message(tab, send(`m.${index}`));
    }

    expect(companion.frames("data")).toHaveLength(2_000);
    expect(asked).toEqual([0, 10, 10, 20, 40, 80, 160, 320, 500, 500, 500]);
  });

  it("should tell a tab its share when it joins, then again after each reservation, and no one else", async () => {
    const now = Date.parse("2026-10-15T10:00:00Z");
    const quota = makeFakeState();
    const reserve = (amount: number, key: string) =>
      grantMessages(quota.state, DEFAULT_DAILY_MESSAGES, { amount, key }, now);
    const core = new ConnectRoomCore(makeFakeState().state, reserve, {
      now: () => now,
      randomId: () => crypto.randomUUID(),
    });
    const tab = new FakeSocket();
    const signedOutTab = new FakeSocket();
    const companion = new FakeSocket();
    const resetAt = "2026-10-16T00:00:00.000Z";

    await core.join(tab, "tab", "user:u1");
    await core.join(signedOutTab, "tab", "address:203.0.113.5");
    await core.join(companion, "companion", "address:198.51.100.7");

    expect(tab.frames("quota")).toEqual([
      { t: "quota", per: "account", used: 0, limit: CLIENT_DAILY_MESSAGES, resetAt },
    ]);
    expect(signedOutTab.frames("quota")).toEqual([
      { t: "quota", per: "connection", used: 0, limit: CLIENT_DAILY_MESSAGES, resetAt },
    ]);

    await core.message(companion, send("x"));

    expect(tab.frames("quota").at(-1)).toEqual({
      t: "quota",
      per: "account",
      used: 10,
      limit: CLIENT_DAILY_MESSAGES,
      resetAt,
    });
    expect(signedOutTab.frames("quota")).toHaveLength(1);
    expect(companion.frames("quota")).toEqual([]);
    expect(quota.storage.get("share:user:u1")).toEqual({ day: "2026-10-15", used: 10 });
    expect(quota.storage.has("share:address:198.51.100.7")).toBe(false);
  });

  it("should forward no more messages than a reservation granted, when several waited for it", async () => {
    const reservation = Promise.withResolvers<QuotaGrant>();
    const { core } = createRoom({
      reserve: (amount) => (amount === 0 ? Promise.resolve({ granted: 0 }) : reservation.promise),
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    const fromTab = core.message(tab, send("from-tab"));
    const fromCompanion = core.message(companion, send("from-companion"));
    reservation.resolve({ granted: 1 });
    await Promise.all([fromTab, fromCompanion]);

    expect(companion.frames("data").map((frame) => frame.d)).toEqual(["from-tab"]);
    expect(tab.frames("data")).toEqual([]);
    expect(tab.frames("busy")).toHaveLength(1);
  });

  it("should reserve for each key on its own, so a spent client never answers for another one's message", async () => {
    const spentReservation = Promise.withResolvers<QuotaGrant>();
    const { core } = createRoom({
      reserve: (amount, key) =>
        key === "address:spent" && amount > 0 ? spentReservation.promise : Promise.resolve({ granted: amount }),
    });
    const spentTab = new FakeSocket();
    const otherTab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(spentTab, "tab", "address:spent");
    await core.join(otherTab, "tab", "address:other");
    await core.join(companion, "companion", "address:companion");

    const fromSpent = core.message(spentTab, send("spent.1"));
    const fromOther = core.message(otherTab, send("other.1"));
    spentReservation.resolve({ granted: 0 });
    await Promise.all([fromSpent, fromOther]);

    expect(companion.frames("data").map((frame) => frame.d)).toContain("other.1");
    expect(otherTab.frames("busy")).toEqual([]);
  });

  it("should keep a peer's messages in order when its first one waits for its own key's reservation", async () => {
    const reservations = new Map<string, PromiseWithResolvers<QuotaGrant>>();
    const { core } = createRoom({
      reserve: (amount, key) => {
        if (amount === 0) {
          return Promise.resolve({ granted: 0 });
        }

        const reservation = Promise.withResolvers<QuotaGrant>();
        reservations.set(key, reservation);

        return reservation.promise;
      },
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(tab, "tab", "address:tab");
    await core.join(companion, "companion", "address:companion");

    const companionFirst = core.message(companion, send("companion.1"));
    const tabFirst = core.message(tab, send("tab.1"));
    await vi.waitFor(() => expect(reservations.size).toBe(2));
    reservations.get("address:tab")?.resolve({ granted: 10 });
    await tabFirst;
    const companionSecond = core.message(companion, send("companion.2"));
    reservations.get("address:companion")?.resolve({ granted: 10 });
    await Promise.all([companionFirst, companionSecond]);

    expect(tab.frames("data").map((frame) => frame.d)).toEqual(["companion.1", "companion.2"]);
  });

  it("should keep a companion's messages in order when its quota key changes while the first one waits", async () => {
    const firstReservation = Promise.withResolvers<QuotaGrant>();
    const { core } = createRoom({
      reserve: (amount, key) =>
        amount > 0 && key === "address:shared" ? firstReservation.promise : Promise.resolve({ granted: amount }),
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(tab, "tab", "address:shared");
    await core.join(companion, "companion", "address:shared");

    const first = core.message(companion, send("companion.1"));
    await core.join(new FakeSocket(), "tab", "user:1");
    const second = core.message(companion, send("companion.2"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstReservation.resolve({ granted: 10 });
    await Promise.all([first, second]);

    expect(tab.frames("data").map((frame) => frame.d)).toEqual(["companion.1", "companion.2"]);
  });

  it("should keep a peer's messages in order when saving the room's usage takes a while", async () => {
    const reservations = new Map<string, PromiseWithResolvers<QuotaGrant>>();
    const { core } = createRoom({
      reserve: (amount, key) => {
        if (amount === 0) {
          return Promise.resolve({ granted: 0 });
        }

        const reservation = Promise.withResolvers<QuotaGrant>();
        reservations.set(key, reservation);

        return reservation.promise;
      },
      waitBeforePut: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(tab, "tab", "address:tab");
    await core.join(companion, "companion", "address:companion");

    const companionFirst = core.message(companion, send("companion.1"));
    const tabFirst = core.message(tab, send("tab.1"));
    await vi.waitFor(() => expect(reservations.size).toBe(2));
    reservations.get("address:tab")?.resolve({ granted: 10 });
    await tabFirst;
    const companionSecond = core.message(companion, send("companion.2"));
    reservations.get("address:companion")?.resolve({ granted: 10 });
    await Promise.all([companionFirst, companionSecond]);

    expect(tab.frames("data").map((frame) => frame.d)).toEqual(["companion.1", "companion.2"]);
  });

  it("should not ask the quota again for a key spent for the day until midnight UTC", async () => {
    const reserved: number[] = [];
    let left = 0;
    const { core, clock } = createRoom({
      reserve: async (amount) => {
        if (amount > 0) {
          reserved.push(amount);
        }

        const granted = Math.min(amount, left);
        left -= granted;

        return { granted };
      },
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);

    for (let index = 0; index < 5; index += 1) {
      await core.message(tab, send(`m.${index}`));
    }

    expect(reserved).toHaveLength(1);
    expect(companion.frames("data")).toEqual([]);

    clock.time = Date.parse("2026-10-16T00:00:01Z");
    left = 10;
    await core.message(tab, send("m.tomorrow"));

    expect(reserved).toHaveLength(2);
    expect(companion.frames("data").map((frame) => frame.d)).toEqual(["m.tomorrow"]);
  });

  it("should not expire a room while a message waits for its reservation", async () => {
    const reservation = Promise.withResolvers<QuotaGrant>();
    const reserving = Promise.withResolvers<void>();
    const { core, clock, storage } = createRoom({
      reserve: (amount) => {
        if (amount === 0) {
          return Promise.resolve({ granted: 0 });
        }

        reserving.resolve();

        return reservation.promise;
      },
    });
    const tab = new FakeSocket();
    const companion = new FakeSocket();
    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    clock.time += ROOM_LIMITS.idleMs;

    const waiting = core.message(tab, send("late.1"));
    await reserving.promise;
    await core.alarm();
    const closedWhileWaiting = tab.closed;
    reservation.resolve({ granted: 10 });
    await waiting;

    expect(closedWhileWaiting).toBeUndefined();
    expect(companion.frames("data").map((frame) => frame.d)).toEqual(["late.1"]);
    expect(storage.size).toBeGreaterThan(0);
  });

  it("should send no share without a quota binding, and still forward", async () => {
    const { core } = createRoom();
    const tab = new FakeSocket();
    const companion = new FakeSocket();

    await core.join(tab, "tab", CLIENT_KEY);
    await core.join(companion, "companion", CLIENT_KEY);
    await core.message(tab, send("x"));

    expect(companion.frames("data")).toHaveLength(1);
    expect(tab.frames("quota")).toEqual([]);
  });
});

describe("AI chat daily quota", () => {
  it("should grant up to the day's limit, then nothing, and start again the next UTC day", async () => {
    const { state } = makeFakeState();
    const day = Date.parse("2026-10-15T10:00:00Z");

    const grant = (key: string, at = day) => grantMessages(state, 1_000, { amount: 600, key }, at);

    expect(await grant("address:a")).toEqual({ granted: 600, share: { used: 600, limit: 1_000 } });
    expect(await grant("address:b")).toEqual({ granted: 400, share: { used: 400, limit: 1_000 } });
    expect(await grant("address:c")).toEqual({ granted: 0, share: { used: 0, limit: 1_000 } });
    expect(await grant("address:a", Date.parse("2026-10-16T00:00:00Z"))).toEqual({
      granted: 600,
      share: { used: 600, limit: 1_000 },
    });
  });

  it("should grant one client up to its daily share, read it without spending, and start it again the next UTC day", async () => {
    const { state, storage } = makeFakeState();
    const day = Date.parse("2026-10-15T10:00:00Z");
    const nextDay = Date.parse("2026-10-16T00:00:00Z");
    const grant = (amount: number, key: string, at = day) =>
      grantMessages(state, DEFAULT_DAILY_MESSAGES, { amount, key }, at);

    for (let index = 0; index < CLIENT_DAILY_MESSAGES / 500; index += 1) {
      await grant(500, "user:u1");
    }

    const share = { limit: CLIENT_DAILY_MESSAGES };

    expect(CLIENT_DAILY_MESSAGES).toBe(100_000);
    expect(await grant(500, "user:u1")).toEqual({ granted: 0, share: { ...share, used: CLIENT_DAILY_MESSAGES } });
    expect(await grant(0, "user:u1")).toEqual({ granted: 0, share: { ...share, used: CLIENT_DAILY_MESSAGES } });
    expect(await grant(500, "address:a")).toEqual({ granted: 500, share: { ...share, used: 500 } });
    expect(await grant(500, "user:u1", nextDay)).toEqual({ granted: 500, share: { ...share, used: 500 } });
    expect([...storage.keys()].toSorted()).toEqual(["quota", "share:user:u1"]);
  });

  it("should read its limit from the environment and serve reservations", async () => {
    expect(getDailyMessageLimit({})).toBe(DEFAULT_DAILY_MESSAGES);
    expect(getDailyMessageLimit({ CONNECT_DAILY_MESSAGES: "50" })).toBe(50);
    expect(getDailyMessageLimit({ CONNECT_DAILY_MESSAGES: "lots" })).toBe(DEFAULT_DAILY_MESSAGES);
    expect(getDailyMessageLimit({ CONNECT_DAILY_MESSAGES: "" })).toBe(DEFAULT_DAILY_MESSAGES);
    expect(getDailyMessageLimit({ CONNECT_DAILY_MESSAGES: " " })).toBe(DEFAULT_DAILY_MESSAGES);
    expect(getDailyMessageLimit({ CONNECT_DAILY_MESSAGES: "0" })).toBe(0);

    const quota = new ConnectQuota(makeFakeState().state, { CONNECT_DAILY_MESSAGES: "50" });
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => quota.fetch(request) }),
    };

    expect(await reserveDailyMessages({ CONNECT_QUOTA: namespace }, 40, "address:a")).toEqual({
      granted: 40,
      share: { used: 40, limit: 50 },
    });
    expect(await reserveDailyMessages({ CONNECT_QUOTA: namespace }, 40, "address:a")).toEqual({
      granted: 10,
      share: { used: 50, limit: 50 },
    });
    expect(await reserveDailyMessages({}, 40, "address:a")).toEqual({ granted: 40 });

    for (const body of [
      "{}",
      JSON.stringify({ amount: 1, key: "a" }),
      JSON.stringify({ amount: -1, key: "user:u1" }),
    ]) {
      expect((await quota.fetch(new Request("https://quota.internal/reserve", { method: "POST", body }))).status).toBe(
        400,
      );
    }
  });
});

/** Room proofs by the room id they open, for the rooms `makeRoom` made. */
const roomProofs = new Map<string, string>();

/** Make a room whose proof a join can show: its id is the SHA-256 of a proof built from `seed`. */
async function makeRoom(seed: string): Promise<string> {
  const proof = seed.padStart(43, "p");
  const roomId = await toRoomId(proof);

  roomProofs.set(roomId, proof);

  return roomId;
}

/** An upgrade to `path`, offering the room's proof when `makeRoom` made it and `headers` offer no protocols. */
const upgrade = (path: string, headers: Record<string, string> = {}) => {
  const roomId = new URL(path, "https://run.test").pathname.split("/").at(-1) ?? "";
  const proof = roomProofs.get(roomId);
  const protocols: Record<string, string> =
    proof === undefined ? {} : { "sec-websocket-protocol": `${CONNECT_ROOM_PROTOCOL}, ${proof}` };

  return new Request(`https://run.test${path}`, { headers: { upgrade: "websocket", ...protocols, ...headers } });
};

const signedOut: ConnectRouteServices = { currentUserId: async () => null };

/**
 * Make a rate limiter that allows `limit` calls per key within one window, as a Cloudflare limiter does within one
 * period, and records every key it is asked for.
 */
function makeCountingLimiter({ limit }: { limit: number }) {
  const keys: string[] = [];
  const counts = new Map<string, number>();

  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      const count = (counts.get(key) ?? 0) + 1;

      keys.push(key);
      counts.set(key, count);

      return { success: count <= limit };
    },
  };
}

/** A distinct room per index, with a proof a join can show. */
function makeIndexedRoom(index: number): Promise<string> {
  return makeRoom(String(index));
}

/** The bindings no connect route reaches. */
const unreachedBindings: Pick<WorkerEnvironment, "PLAYGROUNDS" | "RUNTIME_ASSETS" | "ASSETS"> = {
  PLAYGROUNDS: {
    prepare() {
      throw new Error("A connect route must not access D1.");
    },
    batch() {
      throw new Error("A connect route must not access D1.");
    },
  },
  RUNTIME_ASSETS: {
    async get() {
      throw new Error("A connect route must not access R2.");
    },
  },
  ASSETS: {
    async fetch() {
      throw new Error("A connect route must not reach the assets.");
    },
  },
};

function route(request: Request, environment: Partial<WorkerEnvironment>, services = signedOut) {
  return fetchWorker(request, { ...unreachedBindings, ...environment }, { connect: services });
}

function makeCompanionJoin(room: string, protocols?: string): Request {
  return new Request(`https://run.test/api/connect/rooms/${room}?role=companion`, {
    headers: protocols === undefined ? {} : { "sec-websocket-protocol": protocols },
  });
}

describe("room proof", () => {
  it("should let in only a client whose proof hashes to the room it asks for", async () => {
    const { roomId, roomProof } = await deriveConnectKeys("k7Pq-2xZm-9fLw", { iterations: 1_000 });
    const other = await deriveConnectKeys("Hn4R-8sVb-3tYc", { iterations: 1_000 });
    expect(await hasRoomProof(makeCompanionJoin(roomId, `${CONNECT_ROOM_PROTOCOL}, ${roomProof}`), roomId)).toBe(true);
    expect(await hasRoomProof(makeCompanionJoin(roomId), roomId)).toBe(false);
    expect(await hasRoomProof(makeCompanionJoin(roomId, CONNECT_ROOM_PROTOCOL), roomId)).toBe(false);
    expect(await hasRoomProof(makeCompanionJoin(roomId, `${CONNECT_ROOM_PROTOCOL}, ${roomId}`), roomId)).toBe(false);
    expect(await hasRoomProof(makeCompanionJoin(roomId, `${CONNECT_ROOM_PROTOCOL}, ${other.roomProof}`), roomId)).toBe(
      false,
    );
    expect(await hasRoomProof(makeCompanionJoin(roomId, `other, ${roomProof}`), roomId)).toBe(false);
  });
});

/**
 * Stand in for the Workers globals an upgrade answer needs: `WebSocketPair`, and a `Response` that takes status 101,
 * which Node's refuses. Undone by `vi.unstubAllGlobals()`.
 */
function stubUpgradeGlobals() {
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new FakeSocket();
      1 = Object.assign(new FakeSocket(), { accept: () => undefined });
    },
  );
  vi.stubGlobal(
    "Response",
    class {
      readonly status: number;
      readonly headers: Headers;

      constructor(_body: unknown, init: ResponseInit = {}) {
        this.status = init.status ?? 200;
        this.headers = new Headers(init.headers);
      }
    },
  );
}

describe("upgrade answers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should name the room protocol on a refusal only when the client offered it", () => {
    stubUpgradeGlobals();

    const offered = closeUpgrade(RELAY_CLOSE.unproven, "Refused.", CONNECT_ROOM_PROTOCOL);
    const plain = closeUpgrade(RELAY_CLOSE.rateLimited, "Too many.");

    expect(offered.status).toBe(101);
    expect(offered.headers.get("sec-websocket-protocol")).toBe(CONNECT_ROOM_PROTOCOL);
    expect(plain.headers.get("sec-websocket-protocol")).toBeNull();
  });

  it("should name the room protocol when a room lets a tab or a companion in", async () => {
    const { roomId, roomProof } = await deriveConnectKeys("k7Pq-2xZm-9fLw", { iterations: 1_000 });

    stubUpgradeGlobals();

    for (const role of ["tab", "companion"]) {
      const room = new ConnectRoom(makeFakeState().state, {});
      const response = await room.fetch(
        new Request(`https://run.test/api/connect/rooms/${roomId}?role=${role}`, {
          headers: { upgrade: "websocket", "sec-websocket-protocol": `${CONNECT_ROOM_PROTOCOL}, ${roomProof}` },
        }),
      );

      expect(response.status).toBe(101);
      expect(response.headers.get("sec-websocket-protocol")).toBe(CONNECT_ROOM_PROTOCOL);
    }
  });
});

describe("Durable Object error boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should turn an unexpected quota storage failure into one logged JSON 500", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state } = makeFakeState();
    vi.spyOn(state, "blockConcurrencyWhile").mockRejectedValue(new Error("Quota storage unavailable"));
    const quota = new ConnectQuota(state, {});

    const response = await quota.fetch(
      new Request("https://quota.internal/reserve", {
        method: "POST",
        body: JSON.stringify({ amount: 1, key: "user:u1" }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      event: "request_failed",
      request_id: response.headers.get("X-Request-Id"),
      err: { message: "Quota storage unavailable" },
    });
  });

  it("should log and rethrow an alarm failure so the runtime can retry it", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state } = makeFakeState();
    const failure = new Error("Room storage unavailable");
    vi.spyOn(state.storage, "get").mockRejectedValue(failure);
    const room = new ConnectRoom(state, {});

    await expect(room.alarm()).rejects.toBe(failure);

    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      event: "connect_alarm_failed",
      err: { message: failure.message },
    });
  });

  it("should log and rethrow an unexpected WebSocket callback failure", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state } = makeFakeState();
    const room = new ConnectRoom(state, {});
    const socket = new FakeSocket();
    const failure = new Error("Socket attachment unavailable");
    vi.spyOn(socket, "deserializeAttachment").mockImplementation(() => {
      throw failure;
    });

    await expect(room.webSocketMessage(socket, "{}")).rejects.toBe(failure);

    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      event: "connect_message_failed",
      err: { message: failure.message },
    });
  });
});

describe("AI chat route", () => {
  let roomId = "";
  const forwarded: Request[] = [];
  const environment = {
    CONNECT_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          forwarded.push(request);
          return new Response("joined");
        },
      }),
    },
  };

  beforeAll(async () => {
    roomId = await makeRoom("main");
  });

  /** Join the room from an IPv6 address with a forged quota key, and get the headers the room receives. */
  async function joinWithForgedQuotaKey(role: "tab" | "companion", services: ConnectRouteServices) {
    forwarded.length = 0;
    await route(
      upgrade(`/api/connect/rooms/${roomId}?role=${role}`, {
        ...(role === "tab" ? { origin: "https://run.test" } : {}),
        "cf-connecting-ip": "2001:db8:85a3:42::1",
        [CONNECT_QUOTA_KEY_HEADER]: "user:someone-else",
      }),
      environment,
      services,
    );

    return forwarded[0]?.headers;
  }

  it("should forward a tab from the app's origin and a companion without one to the room", async () => {
    expect(
      await (
        await route(upgrade(`/api/connect/rooms/${roomId}?role=tab`, { origin: "https://run.test" }), environment)
      ).text(),
    ).toBe("joined");
    expect(await (await route(upgrade(`/api/connect/rooms/${roomId}?role=companion`), environment)).text()).toBe(
      "joined",
    );
    expect(forwarded).toHaveLength(2);
  });

  it("should tell the room the client's quota key, overwriting one the client sent", async () => {
    const signedIn: ConnectRouteServices = { currentUserId: async () => "u1" };
    const unreadable: ConnectRouteServices = {
      currentUserId: async () => {
        throw new Error("D1 is unavailable");
      },
    };

    expect((await joinWithForgedQuotaKey("tab", signedIn))?.get(CONNECT_QUOTA_KEY_HEADER)).toBe("user:u1");
    expect((await joinWithForgedQuotaKey("companion", signedIn))?.get(CONNECT_QUOTA_KEY_HEADER)).toBe(
      "address:2001:db8:85a3:42::/64",
    );
    expect((await joinWithForgedQuotaKey("tab", signedOut))?.get(CONNECT_QUOTA_KEY_HEADER)).toBe(
      "address:2001:db8:85a3:42::/64",
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await joinWithForgedQuotaKey("tab", unreadable))?.get(CONNECT_QUOTA_KEY_HEADER)).toBe(
      "address:2001:db8:85a3:42::/64",
    );
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      event: "connect_session_failed",
      err: { message: "D1 is unavailable" },
    });
    consoleError.mockRestore();
    expect((await joinWithForgedQuotaKey("tab", signedIn))?.get("upgrade")).toBe("websocket");
  });

  it("should refuse bad rooms, roles, methods, plain requests, other origins, and a missing binding", async () => {
    const statuses = await Promise.all([
      route(upgrade("/api/connect/rooms/short?role=tab", { origin: "https://run.test" }), environment),
      route(upgrade(`/api/connect/rooms/${roomId}?role=admin`), environment),
      route(new Request(`https://run.test/api/connect/rooms/${roomId}?role=tab`, { method: "POST" }), environment),
      route(new Request(`https://run.test/api/connect/rooms/${roomId}?role=companion`), environment),
      route(upgrade(`/api/connect/rooms/${roomId}?role=tab`, { origin: "https://evil.test" }), environment),
      route(upgrade(`/api/connect/rooms/${roomId}?role=tab`), environment),
      route(upgrade(`/api/connect/rooms/${roomId}?role=companion`), {}),
    ]).then((responses) => responses.map((response) => response.status));

    expect(statuses).toEqual([400, 400, 405, 426, 403, 403, 503]);
  });

  it("should key IPv6 addresses by their /64 and keep other addresses as they are", () => {
    expect(toRateLimitAddress("2001:db8:85a3:0042:1000:8a2e:370:7334")).toBe("2001:db8:85a3:42::/64");
    expect(toRateLimitAddress("2001:DB8:85A3:42::1")).toBe("2001:db8:85a3:42::/64");
    expect(toRateLimitAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(toRateLimitAddress("::1")).toBe("0:0:0:0::/64");
    expect(toRateLimitAddress("1.2.3.4")).toBe("1.2.3.4");
    expect(toRateLimitAddress("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4");
    expect(toRateLimitAddress("anonymous")).toBe("anonymous");
    expect(toRateLimitAddress("1::2::3")).toBe("1::2::3");
  });

  it("should rate limit connections per room and address, and close a limited one with its own code", async () => {
    const keys: string[] = [];
    const closed: { code: number; reason: string }[] = [];
    const limited = {
      ...environment,
      CONNECT_RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: !key.endsWith("1.2.3.4") };
        },
      },
    };
    const services: ConnectRouteServices = {
      ...signedOut,
      closeUpgrade: (code, reason) => {
        closed.push({ code, reason });
        return new Response("closed");
      },
    };
    const join = (address: string) =>
      route(upgrade(`/api/connect/rooms/${roomId}?role=companion`, { "cf-connecting-ip": address }), limited, services);

    forwarded.length = 0;
    expect(await (await join("1.2.3.4")).text()).toBe("closed");
    expect(await (await join("2001:db8:85a3:42::1")).text()).toBe("joined");

    expect(closed).toEqual([{ code: RELAY_CLOSE.rateLimited, reason: "Too many AI chat connections." }]);
    expect(forwarded).toHaveLength(1);
    expect(keys).toEqual([`room:${roomId}:1.2.3.4`, `room:${roomId}:2001:db8:85a3:42::/64`]);
  });

  it("should refuse a tab or a companion without the room's proof with a final code, naming the protocol", async () => {
    const closed: { code: number; protocol?: string }[] = [];
    const services: ConnectRouteServices = {
      ...signedOut,
      closeUpgrade: (code, _reason, protocol) => {
        closed.push({ code, ...(protocol === undefined ? {} : { protocol }) });
        return new Response("closed");
      },
    };
    const other = await makeRoom("other");
    const join = (role: "tab" | "companion", protocols: string) =>
      route(
        upgrade(`/api/connect/rooms/${roomId}?role=${role}`, {
          ...(role === "tab" ? { origin: "https://run.test" } : {}),
          "sec-websocket-protocol": protocols,
        }),
        environment,
        services,
      ).then((response) => response.text());

    forwarded.length = 0;
    expect(await join("tab", `${CONNECT_ROOM_PROTOCOL}, ${roomProofs.get(other)}`)).toBe("closed");
    expect(await join("companion", CONNECT_ROOM_PROTOCOL)).toBe("closed");
    expect(await join("tab", "something-else")).toBe("closed");

    expect(closed).toEqual([
      { code: RELAY_CLOSE.unproven, protocol: CONNECT_ROOM_PROTOCOL },
      { code: RELAY_CLOSE.unproven, protocol: CONNECT_ROOM_PROTOCOL },
      { code: RELAY_CLOSE.unproven },
    ]);
    expect(forwarded).toEqual([]);
  });

  it("should name the room protocol on a rate limited refusal, so the client reads its code", async () => {
    const protocols: (string | undefined)[] = [];
    const limited = { ...environment, CONNECT_RATE_LIMIT: { limit: async () => ({ success: false }) } };
    const services: ConnectRouteServices = {
      ...signedOut,
      closeUpgrade: (_code, _reason, protocol) => {
        protocols.push(protocol);
        return new Response("closed");
      },
    };

    await route(upgrade(`/api/connect/rooms/${roomId}?role=companion`), limited, services);

    expect(protocols).toEqual([CONNECT_ROOM_PROTOCOL]);
  });

  it("should answer 503 when either connection limiter fails", async () => {
    const failingLimiter = {
      limit: async () => {
        throw new Error("limiter down");
      },
    };
    const join = (
      limiters: Partial<Record<"CONNECT_RATE_LIMIT" | "CONNECT_ADDRESS_RATE_LIMIT", typeof failingLimiter>>,
    ) => route(upgrade(`/api/connect/rooms/${roomId}?role=companion`), { ...environment, ...limiters });

    expect((await join({ CONNECT_RATE_LIMIT: failingLimiter })).status).toBe(503);
    expect((await join({ CONNECT_ADDRESS_RATE_LIMIT: failingLimiter })).status).toBe(503);
  });

  describe("address limit across rooms", () => {
    // Must match wrangler.jsonc's production limits.
    const roomLimitPerMinute = 60;
    const addressLimitPerMinute = 300;

    function makeLimitedRoute() {
      const roomLimiter = makeCountingLimiter({ limit: roomLimitPerMinute });
      const addressLimiter = makeCountingLimiter({ limit: addressLimitPerMinute });
      const closed: number[] = [];
      const services: ConnectRouteServices = {
        ...signedOut,
        closeUpgrade: (code) => {
          closed.push(code);
          return new Response("closed");
        },
      };
      const limited = { ...environment, CONNECT_RATE_LIMIT: roomLimiter, CONNECT_ADDRESS_RATE_LIMIT: addressLimiter };
      const join = async (room: string, role: "tab" | "companion") =>
        (
          await route(
            upgrade(`/api/connect/rooms/${room}?role=${role}`, {
              ...(role === "tab" ? { origin: "https://run.test" } : {}),
              "cf-connecting-ip": "203.0.113.5",
            }),
            limited,
            services,
          )
        ).text();

      return { join, closed, roomLimiter, addressLimiter };
    }

    it("should close connections from one address past its cap, however many fresh rooms it opens", async () => {
      const { join, closed, roomLimiter, addressLimiter } = makeLimitedRoute();
      const results: string[] = [];

      for (let index = 0; index < addressLimitPerMinute + 100; index += 1) {
        results.push(await join(await makeIndexedRoom(index), "companion"));
      }

      expect(results.filter((result) => result === "joined")).toHaveLength(addressLimitPerMinute);
      expect(results.slice(addressLimitPerMinute).every((result) => result === "closed")).toBe(true);
      expect(closed).toEqual(Array.from({ length: 100 }, () => RELAY_CLOSE.rateLimited));
      expect(new Set(addressLimiter.keys)).toEqual(new Set(["connect:ip:203.0.113.5"]));
      expect(roomLimiter.keys).toHaveLength(addressLimitPerMinute);
    });

    it("should let a classroom of 30 pairings behind one address reconnect a few times a minute", async () => {
      const { join, closed } = makeLimitedRoute();
      const results: string[] = [];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        for (let index = 0; index < 30; index += 1) {
          const room = await makeIndexedRoom(index);

          results.push(await join(room, "tab"), await join(room, "companion"));
        }
      }

      expect(results).toHaveLength(240);
      expect(results.every((result) => result === "joined")).toBe(true);
      expect(closed).toEqual([]);
    });
  });
});
