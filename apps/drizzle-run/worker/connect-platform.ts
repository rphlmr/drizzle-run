import { CONNECT_ROOM_PROTOCOL, CONNECT_ROUTE_PREFIX, toRoomId } from "@drizzle-run/core/connect";

/**
 * The parts of the Durable Objects and WebSocket Hibernation APIs the AI chat relay uses,
 * typed here like `platform.ts` so the relay runs under Vitest with fakes.
 */

/** The subprotocols an upgrade offers, as `Sec-WebSocket-Protocol` lists them. */
function readOfferedProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** True when an upgrade offers the room protocol, so its answer must name it or the client fails the handshake. */
export function offersRoomProtocol(request: Request): boolean {
  return readOfferedProtocols(request)[0] === CONNECT_ROOM_PROTOCOL;
}

/** The room a request to `/api/connect/rooms/:roomId` asks for, as the route forwards it to the room. */
export function readRoomId(request: Request): string {
  return new URL(request.url).pathname.slice(CONNECT_ROUTE_PREFIX.length);
}

/**
 * True when a tab's or a companion's upgrade carries the proof of `roomId`
 *
 * The client offers `CONNECT_ROOM_PROTOCOL` then its proof as WebSocket subprotocols, and the room id is the proof's
 * SHA-256. Without it, anyone who saw a room id, such as in a tab's WebSocket URL, could fill the room with tabs that
 * spend its owner's quota, or take the room from the user's companion again and again.
 */
export async function hasRoomProof(request: Request, roomId: string): Promise<boolean> {
  const [protocol, proof, ...rest] = readOfferedProtocols(request);

  if (protocol !== CONNECT_ROOM_PROTOCOL || proof === undefined || rest.length > 0) {
    return false;
  }

  return (await toRoomId(proof)) === roomId;
}

/**
 * The header the route sets on the request it forwards to a room: the client's quota key (see `toQuotaKey`), which the
 * room charges its quota reservations to. The route always overwrites it, so a client cannot choose it.
 */
export const CONNECT_QUOTA_KEY_HEADER = "x-drizzle-run-connect-quota-key";

/** A server-side WebSocket accepted through `DurableObjectState.acceptWebSocket`. */
export interface RelaySocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The subset of Durable Object storage the relay uses. */
export interface DurableObjectStorageLike {
  get<Value>(key: string): Promise<Value | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

/** The subset of Durable Object state the relay uses. */
export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  /** Hibernation: the runtime keeps the socket open while the object sleeps. */
  acceptWebSocket(socket: RelaySocket, tags?: string[]): void;
  getWebSockets(tag?: string): RelaySocket[];
  blockConcurrencyWhile<Value>(callback: () => Promise<Value>): Promise<Value>;
}

/** The subset of a Durable Object stub the relay uses. */
export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

/** The subset of a Durable Object namespace the relay uses. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** The bindings and settings of the Connect relay. */
export interface ConnectRelayEnvironment {
  /** One room per pairing, named by the room id derived from the secret. */
  CONNECT_ROOMS?: DurableObjectNamespaceLike;
  /** One object counting every room's messages per UTC day. */
  CONNECT_QUOTA?: DurableObjectNamespaceLike;
  /** Messages every room may forward per UTC day together, as text. Defaults to `DEFAULT_DAILY_MESSAGES`. */
  CONNECT_DAILY_MESSAGES?: string;
}
