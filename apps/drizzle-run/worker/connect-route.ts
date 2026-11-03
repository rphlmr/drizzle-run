import { CONNECT_ROOM_PROTOCOL, RELAY_CLOSE, ROOM_ID_PATTERN } from "@drizzle-run/core/connect";
import * as z from "zod/mini";

import { CONNECT_QUOTA_KEY_HEADER, hasRoomProof, offersRoomProtocol } from "./connect-platform";
import { toQuotaKey } from "./connect-quota";
import { createApiError, toRateLimitAddress } from "./http";
import { logWorkerFailure } from "./logger";
import type { WorkerEnvironment } from "./platform";
import type { InputRefusal } from "./validation";

/**
 * `GET /api/connect/rooms/:roomId?role=tab|companion` with a WebSocket upgrade: joins the
 * AI chat room of a pairing. The room id is derived from the pairing secret, so the Worker
 * routes by it without learning the secret.
 */

/** The path of a room, such as `/api/connect/rooms/:roomId`. */
export const ConnectRoomPathSchema = z.object({ roomId: z.string().check(z.regex(ROOM_ID_PATTERN)) });
/** Who joins the room, such as `?role=tab`. */
export const ConnectRoleQuerySchema = z.object({ role: z.enum(["tab", "companion"]) });

export const invalidRoom = {
  status: 400,
  code: "invalid_room",
  message: "This is not an AI chat room address.",
} satisfies InputRefusal;

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: { accept(): void; close(code: number, reason: string): void } };
};

/**
 * Accept a WebSocket upgrade and close it at once with `code`
 *
 * A refused handshake reaches a browser as a bare 1006 close with no status, so a refusal the client should explain
 * is a socket that opens and closes with its own code. `protocol` names the subprotocol the client offered: a client
 * that offered one fails a handshake answered without it, and never sees the code.
 */
export function closeUpgrade(code: number, reason: string, protocol?: string): Response {
  const pair = new WebSocketPair();

  pair[1].accept();
  pair[1].close(code, reason);

  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    ...(protocol === undefined ? {} : { headers: { "sec-websocket-protocol": protocol } }),
  });
}

/** What the route depends on beyond its bindings. */
export interface ConnectRouteServices {
  /** The signed-in user's id from the request's session cookie, or null. */
  currentUserId(request: Request, environment: WorkerEnvironment): Promise<string | null>;
  /** Answers an upgrade with a socket closed at once with `code`; `closeUpgrade` unless replaced in tests. */
  closeUpgrade?: (code: number, reason: string, protocol?: string) => Response;
}

/**
 * Answers `/api/connect/rooms/:roomId`: checks the upgrade, origin and rate limit, then hands the socket to the room
 * with the client's quota key. A signed-in tab is charged to its user; the companion, which has no session, and
 * a signed-out tab to their rate-limit address.
 *
 * Connections are limited per room and address, so a classroom behind one address does not share one budget, and
 * under a looser cap per address, since the room id is the client's choice and fresh ids would otherwise bypass the
 * room limit. A limited connection opens and closes with `RELAY_CLOSE.rateLimited`, which the tab and the companion
 * explain. A tab or a companion must then prove it holds the pairing code (`hasRoomProof`); one that does not opens
 * and closes with `RELAY_CLOSE.unproven`, which tells it not to retry.
 */
export async function handleConnectRoute(
  request: Request,
  environment: WorkerEnvironment,
  { roomId, role }: z.output<typeof ConnectRoomPathSchema> & z.output<typeof ConnectRoleQuerySchema>,
  services: ConnectRouteServices,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return createApiError(426, "upgrade_required", "The AI chat room takes WebSocket connections.");
  }

  // Browsers always send Origin: only Drizzle Run's own pages may open a tab socket.
  // The companion runs in Node and sends none.
  const origin = request.headers.get("origin");

  if ((origin !== null && origin !== url.origin) || (role === "tab" && origin === null)) {
    return createApiError(
      403,
      "same_origin_required",
      "The AI chat room is available from the Drizzle Run application.",
    );
  }

  if (environment.CONNECT_ROOMS === undefined) {
    return createApiError(503, "chat_unavailable", "The AI chat relay is not configured.");
  }

  const address = toRateLimitAddress(request.headers.get("cf-connecting-ip") ?? "anonymous");
  const refuse = (code: number, reason: string) =>
    (services.closeUpgrade ?? closeUpgrade)(
      code,
      reason,
      offersRoomProtocol(request) ? CONNECT_ROOM_PROTOCOL : undefined,
    );

  // The address cap first, so a connection it refuses does not spend the room's budget.
  const limits = [
    { limiter: environment.CONNECT_ADDRESS_RATE_LIMIT, key: `connect:ip:${address}` },
    { limiter: environment.CONNECT_RATE_LIMIT, key: `room:${roomId}:${address}` },
  ];

  for (const { limiter, key } of limits) {
    if (limiter === undefined) {
      continue;
    }

    let isAllowed: boolean;

    try {
      ({ success: isAllowed } = await limiter.limit({ key }));
    } catch (cause) {
      logWorkerFailure({
        event: "connect_rate_limit_failed",
        cause,
        message: "Checking the AI chat connection rate limit failed",
        request,
      });
      return createApiError(503, "rate_limit_unavailable", "The AI chat relay is temporarily unavailable.");
    }

    if (!isAllowed) {
      return refuse(RELAY_CLOSE.rateLimited, "Too many AI chat connections.");
    }
  }

  // After the limits, so forged connections still spend the address's budget.
  if (!(await hasRoomProof(request, roomId))) {
    return refuse(RELAY_CLOSE.unproven, "This connection does not hold the pairing code.");
  }

  const userId =
    role === "tab"
      ? await services.currentUserId(request, environment).catch((cause: unknown) => {
          logWorkerFailure({
            event: "connect_session_failed",
            cause,
            message: "Reading the signed-in user of an AI chat tab failed",
            request,
          });
          return null;
        })
      : null;
  const room = environment.CONNECT_ROOMS.get(environment.CONNECT_ROOMS.idFromName(roomId));
  const headers = new Headers(request.headers);

  headers.set(CONNECT_QUOTA_KEY_HEADER, toQuotaKey(userId === null ? { address } : { userId }));

  return room.fetch(new Request(request, { headers }));
}
