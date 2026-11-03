import * as z from "zod/mini";

import type { ConnectRelayEnvironment, DurableObjectStateLike } from "./connect-platform";
import { answerUnexpectedError } from "./error-boundary";

/**
 * Every room's messages together, per UTC day, so the AI chat relay's daily traffic has a cap. Rooms reserve
 * blocks of messages instead of asking per message; when the day's budget is spent, they
 * answer `busy` until the next UTC midnight. Each client also has a daily share, kept by its
 * quota key, so one client cannot spend the budget of everyone else.
 */

/**
 * The global budget when `CONNECT_DAILY_MESSAGES` is missing or invalid. wrangler.jsonc sets the deployed value; a
 * test keeps the two equal.
 */
export const DEFAULT_DAILY_MESSAGES = 400_000;

/**
 * Messages one client may have forwarded per UTC day, across all its rooms: one signed-in user, or one address. An
 * address can be a whole classroom or office behind one NAT, so the share is a few rooms' worth; each room keeps its
 * own cap (`ROOM_LIMITS.roomDailyMessages`).
 */
export const CLIENT_DAILY_MESSAGES = 100_000;

const QUOTA_NAME = "daily";

/**
 * Whose daily share a reservation is charged to: `user:<id>` for a signed-in user, `address:<rate-limit address>` for
 * a signed-out client.
 */
export const QuotaKeySchema = z.string().check(z.maxLength(80), z.regex(/^(user|address):\S+$/));

/** Build the quota key of a signed-in user, or of a signed-out client's rate-limit address. */
export function toQuotaKey(client: { userId: string } | { address: string }): string {
  return "userId" in client ? `user:${client.userId}` : `address:${client.address}`;
}

/** Whether a quota key is a signed-in user's. */
export function isAccountQuotaKey(key: string): boolean {
  return key.startsWith("user:");
}

/** What a room asks the quota for: up to 10000 messages for a key, or 0 to read the key's share. */
const ReserveRequestSchema = z.object({ amount: z.int().check(z.gte(0), z.lte(10_000)), key: QuotaKeySchema });

type ReserveRequest = z.output<typeof ReserveRequestSchema>;

/** A key's share of the day: messages reserved for it, and how many it may have. */
export interface QuotaShare {
  used: number;
  limit: number;
}

/** What the quota answers: the messages granted, and the key's share after the grant. */
const QuotaGrantSchema = z.object({
  granted: z.int().check(z.gte(0)),
  share: z.optional(z.object({ used: z.int().check(z.gte(0)), limit: z.int().check(z.gte(0)) })),
});

/** The quota's answer to a room. `share` is missing without a quota binding (local tests). */
export type QuotaGrant = z.output<typeof QuotaGrantSchema>;

interface QuotaDay {
  day: string;
  used: number;
}

const DailyMessageLimitSchema = z.pipe(
  z.pipe(z.string().check(z.regex(/^\d+$/)), z.transform(Number)),
  z.number().check(z.lte(Number.MAX_SAFE_INTEGER)),
);

/** The configured daily message limit, or `DEFAULT_DAILY_MESSAGES` when it is missing or not a non-negative integer. */
export function getDailyMessageLimit(environment: ConnectRelayEnvironment): number {
  const configured = DailyMessageLimitSchema.safeParse(environment.CONNECT_DAILY_MESSAGES);

  return configured.success ? configured.data : DEFAULT_DAILY_MESSAGES;
}

/**
 * The quota's decision for one request: how many of `amount` messages a room may forward, within the day's limit and
 * the key's share, and the key's share after it. An `amount` of 0 only reads the share. The first request of a day
 * clears the previous day's shares.
 */
export async function grantMessages(
  state: DurableObjectStateLike,
  limit: number,
  { amount, key }: ReserveRequest,
  now: number,
): Promise<Required<QuotaGrant>> {
  const day = new Date(now).toISOString().slice(0, 10);
  const shareKey = `share:${key}`;
  const shareLimit = Math.min(limit, CLIENT_DAILY_MESSAGES);
  const stored = await state.storage.get<QuotaDay>("quota");

  if (stored !== undefined && stored.day !== day) {
    await state.storage.deleteAll();
  }

  const current = stored?.day === day ? stored : { day, used: 0 };
  const storedShare = stored?.day === day ? await state.storage.get<QuotaDay>(shareKey) : undefined;
  const share = storedShare ?? { day, used: 0 };
  const granted = Math.max(0, Math.min(amount, limit - current.used, shareLimit - share.used));

  if (granted > 0 || stored?.day !== day) {
    await state.storage.put("quota", { day, used: current.used + granted } satisfies QuotaDay);
  }

  if (granted > 0) {
    await state.storage.put(shareKey, { day, used: share.used + granted } satisfies QuotaDay);
  }

  return { granted, share: { used: share.used + granted, limit: shareLimit } };
}

/**
 * Asks the quota object for `amount` messages for `key`, or for its share with an `amount` of 0. A missing binding
 * grants them without a share (local tests); an unreadable answer grants nothing.
 */
export async function reserveDailyMessages(
  environment: ConnectRelayEnvironment,
  amount: number,
  key: string,
): Promise<QuotaGrant> {
  const namespace = environment.CONNECT_QUOTA;

  if (namespace === undefined) {
    return { granted: amount };
  }

  const response = await namespace.get(namespace.idFromName(QUOTA_NAME)).fetch(
    new Request("https://quota.internal/reserve", {
      method: "POST",
      body: JSON.stringify({ amount, key } satisfies ReserveRequest),
    }),
  );
  const answer = QuotaGrantSchema.safeParse(await response.json());

  return answer.success ? answer.data : { granted: 0 };
}

/** The Durable Object class Wrangler binds as `CONNECT_QUOTA`; a single instance. */
export class ConnectQuota {
  private readonly state: DurableObjectStateLike;
  private readonly environment: ConnectRelayEnvironment;

  constructor(state: DurableObjectStateLike, environment: ConnectRelayEnvironment) {
    this.state = state;
    this.environment = environment;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.reserve(request);
    } catch (cause) {
      return answerUnexpectedError(cause, request);
    }
  }

  private async reserve(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => undefined);
    const reserve = ReserveRequestSchema.safeParse(body);

    if (request.method !== "POST" || !reserve.success) {
      return Response.json({ error: "Reserve between 0 and 10000 messages for a quota key." }, { status: 400 });
    }

    const grant = await this.state.blockConcurrencyWhile(() =>
      grantMessages(this.state, getDailyMessageLimit(this.environment), reserve.data, Date.now()),
    );

    return Response.json(grant satisfies QuotaGrant);
  }
}
