import {
  CONNECT_LIMITS,
  CONNECT_ROOM_PROTOCOL,
  nextUtcMidnight,
  parseRelayClientFrame,
  RELAY_CLOSE,
  type ConnectRole,
  type RelayPeer,
  type RelayServerFrame,
} from "@drizzle-run/core/connect";
import * as z from "zod/mini";

import {
  CONNECT_QUOTA_KEY_HEADER,
  hasRoomProof,
  readRoomId,
  type ConnectRelayEnvironment,
  type DurableObjectStateLike,
  type RelaySocket,
} from "./connect-platform";
import { isAccountQuotaKey, reserveDailyMessages, type QuotaGrant, type QuotaShare } from "./connect-quota";
import { answerUnexpectedError } from "./error-boundary";
import { logWorkerFailure, runDurableObjectCallback } from "./logger";

/**
 * One AI chat room: a Durable Object per pairing, named by the room id the tab and the
 * companion derive from the secret. It forwards sealed payloads between the tab sockets and
 * the companion socket and never sees the secret or a plaintext message.
 *
 * Sockets use the WebSocket Hibernation API, so an idle room can sleep; counters live in
 * memory and reach storage with each reservation and every `PERSIST_EVERY` messages. Storage counts a reserved block
 * as used and keeps no allowance, so a room restored after eviction reserves again before it forwards.
 */

export const ROOM_LIMITS = {
  /** Tab sockets in one room: every browser tab of the paired browser. */
  maxTabs: 8,
  /** Messages one room forwards per UTC day. Beyond it, the room is busy until midnight UTC. */
  roomDailyMessages: 20_000,
  /** Token bucket per socket: a burst, then a steady rate per second. The companion paces its sends under it. */
  burst: CONNECT_LIMITS.relayBurst,
  perSecond: CONNECT_LIMITS.relayPerSecond,
  /** Refused frames a socket may have on record before it is closed. */
  maxStrikes: 50,
  /** Strikes forgiven per second, so a socket that slows down after a burst keeps its connection. */
  strikesForgivenPerSecond: 1,
  /** A room with no forwarded message this long closes its sockets and clears its storage. */
  idleMs: 24 * 60 * 60 * 1000,
  /**
   * Messages reserved from the daily quota at a time: the room's count so far, between these two. A new room holds
   * little, so rooms that forward a few frames cannot reserve the whole day's quota between them.
   */
  firstQuotaBlock: 10,
  quotaBlock: 500,
} as const;

const PERSIST_EVERY = 100;

interface Attachment {
  id: string;
  role: ConnectRole;
  /** The client's quota key: a signed-in user's, or a signed-out client's address. */
  quotaKey: string;
}

interface Usage {
  day: string;
  count: number;
  /** Messages reserved from the daily quota and not used yet. */
  allowance: number;
  lastActivity: number;
}

interface Bucket {
  tokens: number;
  at: number;
  /** Refused frames on record, forgiven over time from `struckAt`. */
  strikes: number;
  struckAt: number;
}

/** The time and ids a room uses, replaced in tests. */
export interface RoomClock {
  now(): number;
  randomId(): string;
}

const defaultClock: RoomClock = {
  now: () => Date.now(),
  randomId: () => crypto.randomUUID().replaceAll("-", "").slice(0, 16),
};

function toUtcDay(now: number) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The peer a hibernated socket carries: its id, whether it is the tab or the companion, and its quota key. */
const AttachmentSchema = z.object({
  id: z.string(),
  role: z.enum(["tab", "companion"]),
  quotaKey: z.string(),
}) satisfies z.ZodMiniType<Attachment>;

/** Reserves `amount` messages of the day's quota for a key, or reads its share with an `amount` of 0. */
type Reserve = (amount: number, key: string) => Promise<QuotaGrant>;

/**
 * The relay room: forwards sealed frames between a tab and a companion, with its rate limits, daily quota and idle
 * expiry.
 */
export class ConnectRoomCore {
  private readonly state: DurableObjectStateLike;
  private readonly clock: RoomClock;
  private readonly reserve: Reserve;
  private usage: Usage | undefined;
  private unsaved = 0;
  /** The reservation in flight for each quota key; its grant is added to the allowance once, when it lands. */
  private readonly reserving = new Map<string, Promise<void>>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly busyTold = new Set<string>();
  /** Keys the quota granted nothing today: asked again only the next UTC day. */
  private readonly spentKeys = new Set<string>();
  /** Each peer's last forward, so its messages reach the others in the order it sent them. */
  private readonly forwarding = new Map<string, Promise<void>>();
  // Peers that left while their socket may still be listed until the runtime drops it.
  private readonly gone = new Set<string>();

  constructor(state: DurableObjectStateLike, reserve: Reserve, clock: RoomClock = defaultClock) {
    this.state = state;
    this.reserve = reserve;
    this.clock = clock;
  }

  /**
   * Accepts a socket for `role` from the client with `quotaKey`, announces it, tells a tab its share of the day, and
   * returns its peer id.
   */
  async join(socket: RelaySocket, role: ConnectRole, quotaKey: string): Promise<string | undefined> {
    const now = this.clock.now();
    const sockets = this.sockets();

    if (role === "tab" && sockets.filter((item) => item.peer.role === "tab").length >= ROOM_LIMITS.maxTabs) {
      this.state.acceptWebSocket(socket, ["closing"]);
      socket.close(RELAY_CLOSE.full, "This pairing has too many open tabs.");
      return undefined;
    }

    if (role === "companion") {
      for (const item of sockets.filter((entry) => entry.peer.role === "companion")) {
        item.socket.close(RELAY_CLOSE.replaced, "A newer companion joined.");
        this.leave(item.socket);
      }
    }

    const peer: RelayPeer = { id: this.clock.randomId(), role };

    this.state.acceptWebSocket(socket, [role, peer.id]);
    socket.serializeAttachment({ ...peer, quotaKey } satisfies Attachment);
    this.send(socket, {
      t: "welcome",
      id: peer.id,
      role,
      peers: this.sockets()
        .filter((item) => item.socket !== socket)
        .map((item) => ({ id: item.peer.id, role: item.peer.role })),
      maxFrameBytes: CONNECT_LIMITS.maxFrameBytes,
    });

    for (const item of this.sockets()) {
      if (item.socket !== socket) {
        this.send(item.socket, { t: "peer", event: "join", peer });
      }
    }

    if (role === "tab") {
      const grant = await this.reserveLogged(0, quotaKey);

      this.tellQuota(quotaKey, grant?.share);
    }

    const usage = await this.loadUsage();

    usage.lastActivity = now;
    await this.saveUsage();

    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(now + ROOM_LIMITS.idleMs);
    }

    return peer.id;
  }

  async message(socket: RelaySocket, data: string | ArrayBuffer): Promise<void> {
    const peer = this.peerOf(socket);

    if (peer === undefined) {
      return;
    }

    if (typeof data !== "string") {
      this.refuse(socket, peer, "bad_frame", "Send text frames.");
      return;
    }

    // A character is at least one byte, so only long frames need counting.
    if (
      data.length > CONNECT_LIMITS.maxFrameBytes ||
      (data.length * 3 > CONNECT_LIMITS.maxFrameBytes &&
        new TextEncoder().encode(data).byteLength > CONNECT_LIMITS.maxFrameBytes)
    ) {
      this.refuse(socket, peer, "too_large", `Frames are at most ${CONNECT_LIMITS.maxFrameBytes} bytes.`);
      return;
    }

    if (!this.take(peer)) {
      this.refuse(socket, peer, "rate_limited", "Slow down: too many messages.");
      return;
    }

    const frame = parseRelayClientFrame(data);

    if (frame === undefined) {
      this.refuse(socket, peer, "bad_frame", "Not a relay frame.");
      return;
    }

    const targets = this.targets(peer, frame.to);

    if (targets.length === 0) {
      this.refuse(
        socket,
        peer,
        "no_peer",
        peer.role === "tab" ? "The companion is not connected." : "No tab is connected.",
      );
      return;
    }

    const previous = this.forwarding.get(peer.id) ?? Promise.resolve();
    const forwarded = previous.then(() => this.forward(peer, targets, frame.d));

    this.forwarding.set(
      peer.id,
      forwarded.catch(() => undefined),
    );
    await forwarded;
  }

  /** Counts one message and sends it to `targets`, or tells the room it is busy for the day. */
  private async forward(peer: Attachment, targets: readonly RelaySocket[], payload: string): Promise<void> {
    const busy = await this.count(this.chargedKey(peer));

    if (busy !== undefined) {
      this.tellBusy(busy);
      return;
    }

    for (const target of targets) {
      this.send(target, { t: "data", from: peer.id, d: payload });
    }
  }

  /** Called on close and on error: tells the others the peer left. */
  leave(socket: RelaySocket): void {
    const peer = this.peerOf(socket);

    if (peer === undefined) {
      return;
    }

    this.gone.add(peer.id);

    try {
      socket.serializeAttachment(null);
    } catch {
      // A closed socket may refuse it; `gone` still keeps it out.
    }

    this.buckets.delete(peer.id);
    this.busyTold.delete(peer.id);
    this.forwarding.delete(peer.id);

    for (const item of this.sockets()) {
      if (item.socket !== socket) {
        this.send(item.socket, { t: "peer", event: "leave", peer: { id: peer.id, role: peer.role } });
      }
    }
  }

  /** Closes an idle room and clears it; otherwise checks again later, as it does while a message waits for quota. */
  async alarm(): Promise<void> {
    const now = this.clock.now();

    if (this.reserving.size > 0) {
      await this.state.storage.setAlarm(now + ROOM_LIMITS.idleMs);
      return;
    }

    const usage = await this.loadUsage();
    const sockets = this.sockets();

    if (sockets.length === 0 || now - usage.lastActivity >= ROOM_LIMITS.idleMs) {
      for (const item of sockets) {
        item.socket.close(RELAY_CLOSE.expired, "This room was idle too long.");
      }

      this.usage = undefined;
      this.unsaved = 0;
      await this.state.storage.deleteAll();
      return;
    }

    await this.saveUsage();
    await this.state.storage.setAlarm(usage.lastActivity + ROOM_LIMITS.idleMs);
  }

  private sockets(): { socket: RelaySocket; peer: Attachment }[] {
    return this.state.getWebSockets().flatMap((socket) => {
      const peer = this.peerOf(socket);
      return peer ? [{ socket, peer }] : [];
    });
  }

  private peerOf(socket: RelaySocket): Attachment | undefined {
    const attachment = AttachmentSchema.safeParse(socket.deserializeAttachment());

    return attachment.success && !this.gone.has(attachment.data.id) ? attachment.data : undefined;
  }

  /** A tab talks to the companion; the companion to one tab, or every tab without `to`. */
  private targets(from: Attachment, to: string | undefined): RelaySocket[] {
    const others = this.sockets().filter((item) => item.peer.id !== from.id && item.peer.role !== from.role);

    return others.filter((item) => to === undefined || item.peer.id === to).map((item) => item.socket);
  }

  private bucketOf(peer: Attachment, now: number): Bucket {
    return this.buckets.get(peer.id) ?? { tokens: ROOM_LIMITS.burst, at: now, strikes: 0, struckAt: now };
  }

  private take(peer: Attachment): boolean {
    const now = this.clock.now();
    const bucket = this.bucketOf(peer, now);
    const tokens = Math.min(ROOM_LIMITS.burst, bucket.tokens + ((now - bucket.at) / 1000) * ROOM_LIMITS.perSecond);
    const allowed = tokens >= 1;

    this.buckets.set(peer.id, { ...bucket, tokens: allowed ? tokens - 1 : tokens, at: now });

    return allowed;
  }

  private refuse(
    socket: RelaySocket,
    peer: Attachment,
    code: "bad_frame" | "too_large" | "rate_limited" | "no_peer",
    message: string,
  ): void {
    const now = this.clock.now();
    const bucket = this.bucketOf(peer, now);
    const forgiven = ((now - bucket.struckAt) / 1000) * ROOM_LIMITS.strikesForgivenPerSecond;
    const strikes = Math.max(0, bucket.strikes - forgiven) + 1;

    this.buckets.set(peer.id, { ...bucket, strikes, struckAt: now });

    if (strikes > ROOM_LIMITS.maxStrikes) {
      socket.close(RELAY_CLOSE.misbehaving, "Too many refused frames.");
      this.leave(socket);
      return;
    }

    this.send(socket, { t: "error", code, message });
  }

  /**
   * The key a peer's message is charged to: its own when signed in, else a signed-in tab's in this room, so the
   * companion's messages count for the user who paired it, else its own.
   */
  private chargedKey(peer: Attachment): string {
    if (isAccountQuotaKey(peer.quotaKey)) {
      return peer.quotaKey;
    }

    return this.sockets().find((item) => isAccountQuotaKey(item.peer.quotaKey))?.peer.quotaKey ?? peer.quotaKey;
  }

  /**
   * Counts one forwarded message, reserving quota for `key` when the allowance is spent; returns the busy scope when a
   * daily limit stops it.
   */
  private async count(key: string): Promise<"daily" | "room" | undefined> {
    const now = this.clock.now();
    const usage = await this.loadUsage();
    const day = toUtcDay(now);

    if (usage.day !== day) {
      Object.assign(usage, { day, count: 0, allowance: 0 });
      this.busyTold.clear();
      this.spentKeys.clear();
    }

    if (usage.count >= ROOM_LIMITS.roomDailyMessages) {
      return "room";
    }

    const needsReservation = usage.allowance <= 0;

    if (needsReservation && this.spentKeys.has(key)) {
      return "daily";
    }

    if (needsReservation) {
      const block = Math.min(ROOM_LIMITS.quotaBlock, Math.max(ROOM_LIMITS.firstQuotaBlock, usage.count));

      let reservation = this.reserving.get(key);

      if (reservation === undefined) {
        reservation = this.reserveBlock(usage, block, key);
        this.reserving.set(key, reservation);
      }

      await reservation;

      if (usage.allowance <= 0) {
        return "daily";
      }
    }

    // Spent before the next await: messages that waited for the same reservation each check what is left.
    usage.allowance -= 1;
    usage.count += 1;
    usage.lastActivity = now;
    this.unsaved += 1;

    if (needsReservation || this.unsaved >= PERSIST_EVERY) {
      await this.saveUsage();
    }

    return undefined;
  }

  /** Reserves `amount` messages for `key`; a reservation that fails is logged and returns null. */
  private async reserveLogged(amount: number, key: string): Promise<QuotaGrant | null> {
    try {
      return await this.reserve(amount, key);
    } catch (cause) {
      logWorkerFailure({
        event: "quota_reservation_failed",
        cause,
        message: "Reserving AI chat messages failed",
      });
      return null;
    }
  }

  /** Reserves `block` messages for `key` and adds what it grants to the allowance; a failed reservation grants none. */
  private async reserveBlock(usage: Usage, block: number, key: string): Promise<void> {
    try {
      const grant = await this.reserveLogged(block, key);

      if (grant === null) {
        return;
      }

      usage.allowance += grant.granted;
      this.tellQuota(key, grant.share);

      if (grant.granted === 0) {
        this.spentKeys.add(key);
      }
    } finally {
      this.reserving.delete(key);
    }
  }

  /** Tells each socket once per day that the chat is busy; the sockets stay open. */
  private tellBusy(scope: "daily" | "room"): void {
    const retryAt = nextUtcMidnight(this.clock.now()).toISOString();

    for (const item of this.sockets()) {
      if (!this.busyTold.has(item.peer.id)) {
        this.busyTold.add(item.peer.id);
        this.send(item.socket, { t: "busy", scope, retryAt });
      }
    }
  }

  /** Tells the sockets of `key`, and only them, the key's share of the day. Without a share, nothing is sent. */
  private tellQuota(key: string, share: QuotaShare | undefined): void {
    if (share === undefined) {
      return;
    }

    const resetAt = nextUtcMidnight(this.clock.now()).toISOString();
    const per = isAccountQuotaKey(key) ? "account" : "connection";

    for (const item of this.sockets()) {
      if (item.peer.quotaKey === key) {
        this.send(item.socket, { t: "quota", per, used: share.used, limit: share.limit, resetAt });
      }
    }
  }

  /** The usage in memory, or as restored from storage with the unspent allowance forfeited. */
  private async loadUsage(): Promise<Usage> {
    if (this.usage !== undefined) {
      return this.usage;
    }

    const stored = await this.state.storage.get<Usage>("usage");

    this.usage =
      stored === undefined
        ? { day: toUtcDay(this.clock.now()), count: 0, allowance: 0, lastActivity: this.clock.now() }
        : { ...stored, allowance: 0 };

    return this.usage;
  }

  /**
   * Persists the usage with the allowance counted as used
   *
   * An evicted room loses its memory, and a stored allowance would let it forward that block again without reserving.
   * Storing `count + allowance` keeps the room's count from going back, and the restored room starts with nothing to
   * spend.
   */
  private async saveUsage(): Promise<void> {
    if (this.usage !== undefined) {
      this.unsaved = 0;
      await this.state.storage.put("usage", {
        ...this.usage,
        count: this.usage.count + this.usage.allowance,
        allowance: 0,
      } satisfies Usage);
    }
  }

  private send(socket: RelaySocket, frame: RelayServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A socket closing meanwhile; its close event cleans up.
    }
  }
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: RelaySocket } };

declare global {
  interface ResponseInit {
    webSocket?: WebSocket;
  }
}

/** The Durable Object class Wrangler binds as `CONNECT_ROOMS`. */
export class ConnectRoom {
  private readonly core: ConnectRoomCore;

  constructor(state: DurableObjectStateLike, environment: ConnectRelayEnvironment) {
    this.core = new ConnectRoomCore(state, (amount, key) => reserveDailyMessages(environment, amount, key));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.join(request);
    } catch (cause) {
      return answerUnexpectedError(cause, request);
    }
  }

  private async join(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get("role");

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || (role !== "tab" && role !== "companion")) {
      return new Response("Expected a WebSocket upgrade with a role.", { status: 426 });
    }

    // Checked again, so the room never trusts what reaches it.
    if (!(await hasRoomProof(request, readRoomId(request)))) {
      return new Response("A tab or a companion must prove it holds the pairing code.", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    await this.core.join(server, role, request.headers.get(CONNECT_QUOTA_KEY_HEADER) ?? "address:anonymous");

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": CONNECT_ROOM_PROTOCOL },
    });
  }

  webSocketMessage(socket: RelaySocket, message: string | ArrayBuffer): Promise<void> {
    return runDurableObjectCallback("connect_message_failed", () => this.core.message(socket, message));
  }

  webSocketClose(socket: RelaySocket): Promise<void> {
    return runDurableObjectCallback("connect_close_failed", () => this.close(socket));
  }

  private close(socket: RelaySocket): void {
    this.core.leave(socket);

    try {
      socket.close(1000, "Closed");
    } catch {
      // Already closed.
    }
  }

  webSocketError(socket: RelaySocket): Promise<void> {
    return runDurableObjectCallback("connect_socket_error_failed", () => this.core.leave(socket));
  }

  alarm(): Promise<void> {
    return runDurableObjectCallback("connect_alarm_failed", () => this.core.alarm());
  }
}
