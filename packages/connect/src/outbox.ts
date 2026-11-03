import { CONNECT_LIMITS } from "@drizzle-run/core/connect";
import { assign, createActor, fromPromise, setup, type Actor } from "xstate";

import { declareType } from "./declare-type.ts";

/**
 * The companion's outgoing frames, paced under the relay's token bucket.
 *
 * The relay keeps one bucket per socket and refuses frames past it, and the companion's one socket carries every
 * chat of every tab. The outbox sends in order, at most a burst at once and then a steady rate; frames that wait for
 * their turn are merged where `merge` allows, so streamed text arrives in fewer, larger frames.
 */

/** The relay's bucket with headroom, since this side's clock and the relay's do not tick together. */
export const OUTBOX_PACE = {
  burst: CONNECT_LIMITS.relayBurst / 2,
  perSecond: (CONNECT_LIMITS.relayPerSecond * 3) / 4,
} as const;

/** What an outbox sends with, and how it may merge waiting items. */
export interface OutboxOptions<Item> {
  /** Sends one item. Must not reject: the outbox waits for it before the next, so sealing follows the queue order. */
  deliver(item: Item): Promise<void>;
  /** One item standing for `earlier` then `later`, or undefined when they must go apart. */
  merge(earlier: Item, later: Item): Item | undefined;
  burst?: number;
  perSecond?: number;
  now?: () => number;
}

interface OutboxContext<Item> {
  queue: readonly Item[];
  /** The item being delivered now. */
  delivering: { item: Item } | undefined;
  tokens: number;
  refilledAt: number;
}

type OutboxEvent<Item> =
  | { type: "item.push"; item: Item }
  | { type: "items.drop"; isDropped: (item: Item) => boolean }
  | { type: "items.clear" };

/** The first waiting item, merged with the ones after it while `merge` allows, and the items left after them. */
function takeMerged<Item>(
  queue: readonly Item[],
  merge: OutboxOptions<Item>["merge"],
): { item: Item | undefined; rest: readonly Item[] } {
  let item = queue[0];
  let taken = item === undefined ? 0 : 1;

  while (item !== undefined) {
    const next = queue[taken];
    const merged = next === undefined ? undefined : merge(item, next);

    if (merged === undefined) {
      break;
    }

    item = merged;
    taken += 1;
  }

  return { item, rest: queue.slice(taken) };
}

/**
 * Build the outbox's machine
 *
 * `idle` with nothing to send; `delivering` one item, then the next; `waitingForToken` until the bucket refills.
 */
export function createOutboxMachine<Item>(options: OutboxOptions<Item>) {
  const burst = options.burst ?? OUTBOX_PACE.burst;
  const perSecond = options.perSecond ?? OUTBOX_PACE.perSecond;
  const now = options.now ?? (() => Date.now());

  return setup({
    types: {
      context: declareType<OutboxContext<Item>>(),
      events: declareType<OutboxEvent<Item>>(),
    },
    actors: {
      deliver: fromPromise<void, { item: Item }>(({ input }) => options.deliver(input.item)),
    },
    delays: {
      untilToken: ({ context }) => Math.ceil(((1 - context.tokens) / perSecond) * 1000),
    },
    guards: {
      isEmpty: ({ context }) => context.queue.length === 0,
      hasNoToken: ({ context }) => context.tokens < 1,
    },
    actions: {
      enqueue: assign({
        queue: ({ context, event }) => (event.type === "item.push" ? [...context.queue, event.item] : context.queue),
      }),
      drop: assign({
        queue: ({ context, event }) =>
          event.type === "items.drop" ? context.queue.filter((item) => !event.isDropped(item)) : context.queue,
      }),
      clear: assign({ queue: [] }),
      refill: assign(({ context }) => {
        const refilledAt = now();

        return {
          tokens: Math.min(burst, context.tokens + ((refilledAt - context.refilledAt) / 1000) * perSecond),
          refilledAt,
        };
      }),
      takeNext: assign(({ context }) => {
        const { item, rest } = takeMerged(context.queue, (earlier, later) => options.merge(earlier, later));

        return { delivering: item === undefined ? undefined : { item }, queue: rest, tokens: context.tokens - 1 };
      }),
    },
  }).createMachine({
    id: "outbox",
    initial: "idle",
    context: { queue: [], delivering: undefined, tokens: burst, refilledAt: now() },
    on: {
      "item.push": { actions: "enqueue" },
      "items.drop": { actions: "drop" },
      "items.clear": { actions: "clear" },
    },
    states: {
      idle: {
        on: {
          "item.push": { target: "checking", actions: "enqueue" },
        },
      },
      checking: {
        entry: "refill",
        always: [
          { guard: "isEmpty", target: "idle" },
          { guard: "hasNoToken", target: "waitingForToken" },
          { target: "delivering", actions: "takeNext" },
        ],
      },
      delivering: {
        invoke: {
          src: "deliver",
          input: ({ context }) => {
            if (context.delivering === undefined) {
              throw new Error("Expected an item to deliver");
            }

            return context.delivering;
          },
          onDone: { target: "checking", actions: assign({ delivering: undefined }) },
          onError: { target: "checking", actions: assign({ delivering: undefined }) },
        },
      },
      waitingForToken: {
        after: { untilToken: "checking" },
        on: {
          "items.clear": { target: "idle", actions: "clear" },
        },
      },
    },
  });
}

/**
 * Outbox
 *
 * `push` queues an item and sends it as soon as the pace allows. `drop` and `clear` take waiting items out and return
 * them, so their owner can tell whoever waits on them.
 */
export class Outbox<Item> {
  private readonly actor: Actor<ReturnType<typeof createOutboxMachine<Item>>>;

  constructor(options: OutboxOptions<Item>) {
    this.actor = createActor(createOutboxMachine(options));
    this.actor.start();
  }

  /** Items waiting for their turn. */
  get size(): number {
    return this.actor.getSnapshot().context.queue.length;
  }

  /** Queue an item and send what the pace allows. */
  push(item: Item): void {
    this.actor.send({ type: "item.push", item });
  }

  /** Take out the waiting items `isDropped` matches, and return them. */
  drop(isDropped: (item: Item) => boolean): Item[] {
    const dropped = this.actor.getSnapshot().context.queue.filter(isDropped);

    this.actor.send({ type: "items.drop", isDropped });

    return dropped;
  }

  /** Take out every waiting item, and return them. */
  clear(): Item[] {
    const cleared = [...this.actor.getSnapshot().context.queue];

    this.actor.send({ type: "items.clear" });

    return cleared;
  }
}
