import { fromPromise, type AnyActorRef, type AnyMachineSnapshot, type AnyStateMachine, type EventObject } from "xstate";
import { getAdjacencyMap, getShortestPaths, type StatePath } from "xstate/graph";

/** The outputs a fake actor can finish with, and the error it can fail with. Without `error`, it never fails. */
export interface ActorOutcome<TOutput> {
  outputs: readonly TOutput[];
  error?: unknown;
}

/** An event of a machine path: a machine event, or the done or error event of an actor it runs */
export interface ModelEvent extends EventObject {
  actorId?: string;
  output?: unknown;
  error?: unknown;
}

/** A path through a machine, from its initial state, that ends with the transition it covers */
export type MachinePath = StatePath<AnyMachineSnapshot, ModelEvent> & {
  description: string;
  /** The transition: the model states before and after, and the event's label */
  transition: { from: string; event: string; to: string };
};

/** What `getMachinePaths` walks */
export interface MachinePathOptions {
  /**
   * The events to try in each state: every machine event, each payload variant that takes another guard branch, and
   * the settle events of `getSettleEvents` for the actors the state runs. Events left out are never tried.
   */
  events(this: void, snapshot: AnyMachineSnapshot): readonly ModelEvent[];
  /**
   * The part of a snapshot that tells two states apart: the state value and the context the guards read. Keep it
   * small, since every distinct value is a node of the graph.
   */
  toModelState(this: void, snapshot: AnyMachineSnapshot): unknown;
  /** Names an event in path descriptions, such as to tell payload variants apart. Defaults to its type. */
  describeEvent?(this: void, event: ModelEvent): string | undefined;
  input?: unknown;
  /** Stops the walk after this many states. */
  limit?: number;
}

const DONE_PREFIX = "xstate.done.actor.";
const ERROR_PREFIX = "xstate.error.actor.";
const AFTER_PREFIX = "xstate.after.";
const completedInvocations = new WeakMap<AnyMachineSnapshot, ReadonlySet<AnyActorRef>>();

function describeEvent(event: EventObject) {
  if (event.type.startsWith(DONE_PREFIX)) {
    return `done(${event.type.slice(DONE_PREFIX.length)})`;
  }

  if (event.type.startsWith(ERROR_PREFIX)) {
    return `error(${event.type.slice(ERROR_PREFIX.length)})`;
  }

  return event.type;
}

function describeState(snapshot: AnyMachineSnapshot) {
  return typeof snapshot.value === "string" ? snapshot.value : JSON.stringify(snapshot.value);
}

/**
 * Get a path for every transition of a machine
 *
 * Walks the machine's own transitions with `xstate/graph`, then gives each transition the shortest path to its source
 * state followed by its event, so every guard branch the given events can take gets a path, including one that
 * refuses an event and stays put. Invoked actors never run during the walk; `getSettleEvents` stands for their
 * results.
 *
 * @example
 * ```ts
 * for (const path of getMachinePaths(machine, { events, toModelState })) {
 *   it(`should take ${path.description}`, () => replayMachinePath(path, { actor, settler, toModelState }));
 * }
 * ```
 */
export function getMachinePaths(machine: AnyStateMachine, options: MachinePathOptions): MachinePath[] {
  const eventKeys = new WeakMap<ModelEvent, string>();
  let eventCount = 0;
  const graphMachine = {
    getInitialSnapshot: machine.getInitialSnapshot.bind(machine),
    getPersistedSnapshot: machine.getPersistedSnapshot.bind(machine),
    transition: (...args: Parameters<typeof machine.transition>) => {
      const [previous, event] = args;
      const next = { ...machine.transition(...args) };
      const completed = new Set<AnyActorRef>();

      for (const [id, child] of Object.entries<AnyActorRef | undefined>(next.children)) {
        if (child === undefined || child !== previous.children[id]) {
          continue;
        }

        if (
          completedInvocations.get(previous)?.has(child) ||
          event.type === `${DONE_PREFIX}${id}` ||
          event.type === `${ERROR_PREFIX}${id}`
        ) {
          completed.add(child);
        }
      }

      completedInvocations.set(next, completed);

      return next;
    },
  };
  const traversal = {
    input: options.input,
    limit: options.limit,
    events: (snapshot: AnyMachineSnapshot) => options.events(snapshot),
    serializeState: (snapshot: AnyMachineSnapshot) =>
      JSON.stringify({
        model: options.toModelState(snapshot),
        completed: Object.entries<AnyActorRef | undefined>(snapshot.children)
          .filter(([, child]) => child !== undefined && completedInvocations.get(snapshot)?.has(child))
          .map(([id]) => id)
          .toSorted(),
      }),
    serializeEvent: (event: ModelEvent) => {
      const existing = eventKeys.get(event);

      if (existing !== undefined) {
        return existing;
      }

      const key = `${event.type}:${eventCount++}`;
      eventKeys.set(event, key);

      return key;
    },
  };
  const labelEvent = (event: ModelEvent) => options.describeEvent?.(event) ?? describeEvent(event);
  const shortestPaths = new Map(
    getShortestPaths(graphMachine, traversal).map((path) => [traversal.serializeState(path.state), path]),
  );
  const descriptionCounts = new Map<string, number>();
  const paths: MachinePath[] = [];

  for (const [stateKey, { transitions }] of Object.entries(getAdjacencyMap(graphMachine, traversal))) {
    const pathToState = shortestPaths.get(stateKey);

    if (pathToState === undefined) {
      continue;
    }

    const earlierEvents = pathToState.steps
      .filter((step) => step.event.type !== "xstate.init")
      .map((step) => labelEvent(step.event));

    for (const { event, state } of Object.values<{ event: ModelEvent; state: AnyMachineSnapshot }>(transitions)) {
      const after = earlierEvents.length > 0 ? ` (after ${earlierEvents.join(", ")})` : "";
      const description = `${describeState(pathToState.state)} → ${labelEvent(event)} → ${describeState(state)}${after}`;
      const count = (descriptionCounts.get(description) ?? 0) + 1;

      descriptionCounts.set(description, count);
      paths.push({
        state,
        steps: [...pathToState.steps, { event, state }],
        weight: pathToState.steps.length + 1,
        description: count > 1 ? `${description} #${count}` : description,
        transition: {
          from: JSON.stringify(options.toModelState(pathToState.state)),
          event: labelEvent(event),
          to: JSON.stringify(options.toModelState(state)),
        },
      });
    }
  }

  return paths;
}

/**
 * List the transitions of machine paths, one line each
 *
 * Meant for a snapshot, so a change to a guard or a target shows up as a diff of this table.
 */
export function toTransitionTable(paths: readonly MachinePath[]): string[] {
  return paths.map(
    ({ transition }) =>
      `${formatModelState(transition.from)} --${transition.event}--> ${formatModelState(transition.to)}`,
  );
}

function formatModelState(serialized: string) {
  const state: unknown = JSON.parse(serialized);

  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return serialized;
  }

  const { value, ...context } = Object.fromEntries(Object.entries(state));
  const fields = Object.entries(context).map(([key, field]) => `${key}=${JSON.stringify(field)}`);

  return [typeof value === "string" ? value : JSON.stringify(value), ...fields].join(" ");
}

/**
 * Get the events that finish or fail each actor a snapshot runs
 *
 * `outcomes` maps an actor's `src` to the outputs and the error its fake settles with. Actors missing from it are
 * left running.
 */
export function getSettleEvents(
  snapshot: AnyMachineSnapshot,
  outcomes: Record<string, ActorOutcome<unknown>>,
): ModelEvent[] {
  const events: ModelEvent[] = [];

  for (const [id, child] of Object.entries<AnyActorRef | undefined>(snapshot.children)) {
    const outcome = typeof child?.src === "string" ? outcomes[child.src] : undefined;

    if (
      child === undefined ||
      outcome === undefined ||
      child.getSnapshot().status !== "active" ||
      completedInvocations.get(snapshot)?.has(child)
    ) {
      continue;
    }

    for (const output of outcome.outputs) {
      events.push({ type: `${DONE_PREFIX}${id}`, actorId: id, output });
    }

    if ("error" in outcome) {
      events.push({ type: `${ERROR_PREFIX}${id}`, actorId: id, error: outcome.error });
    }
  }

  return events;
}

interface PendingActor {
  finish(output: unknown): void;
  fail(): void;
}

/** Fake promise actors that settle when a replayed path says so */
export interface ActorSettler {
  /** A fake that waits for `settle`, then finishes with one of the outcome's outputs or fails with its error. */
  fromOutcome<TOutput, TInput>(outcome: ActorOutcome<TOutput>): ReturnType<typeof fromPromise<TOutput, TInput>>;
  /** Settles the fake a done or error event names. Returns false for any other event. */
  settle(event: ModelEvent): boolean;
}

/**
 * Create fake promise actors that settle when a replayed path says so
 *
 * Fakes are keyed by actor id, which matches between the graph walk and a running actor for invoked actors.
 */
export function createActorSettler(): ActorSettler {
  const pending = new Map<string, PendingActor>();

  return {
    fromOutcome<TOutput, TInput>(outcome: ActorOutcome<TOutput>) {
      return fromPromise<TOutput, TInput>(
        ({ self }) =>
          new Promise<TOutput>((resolve, reject) => {
            pending.set(self.id, {
              finish: (output) => {
                const index = outcome.outputs.findIndex((candidate) => Object.is(candidate, output));

                if (index === -1) {
                  reject(new Error(`Expected actor '${self.id}' to finish with one of its outcome's outputs.`));

                  return;
                }

                resolve(outcome.outputs[index]);
              },
              fail: () => reject(outcome.error),
            });
          }),
      );
    },
    settle(event) {
      const isDone = event.type.startsWith(DONE_PREFIX);
      const isError = event.type.startsWith(ERROR_PREFIX);

      if (!isDone && !isError) {
        return false;
      }

      const id = event.type.slice(isDone ? DONE_PREFIX.length : ERROR_PREFIX.length);
      const actor = pending.get(id);

      if (actor === undefined) {
        throw new Error(`Expected actor '${id}' to be running a fake, but it is not.`);
      }

      pending.delete(id);

      if (isDone) {
        actor.finish(event.output);
      } else {
        actor.fail();
      }

      return true;
    },
  };
}

/** What `replayMachinePath` drives */
export interface ReplayOptions {
  actor: AnyActorRef;
  settler: ActorSettler;
  toModelState(this: void, snapshot: AnyMachineSnapshot): unknown;
  /** Runs a delayed transition's `xstate.after.<delay>.<state>` event, such as by advancing fake timers. */
  advance?: (event: ModelEvent) => Promise<void>;
  /** Lets settled promises deliver their events. Defaults to one macrotask; pass one that advances fake timers. */
  flush?: () => Promise<void>;
}

function waitForMacrotask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Replay a machine path on a running actor
 *
 * Sends each step's event to the actor, settles its fake actors, or runs its delay, then checks that the actor reached
 * the step's model state. Throws on the first step where the actor and the machine's graph disagree.
 */
export async function replayMachinePath(
  path: MachinePath,
  { actor, settler, toModelState, advance, flush = waitForMacrotask }: ReplayOptions,
): Promise<void> {
  for (const [index, step] of path.steps.entries()) {
    if (step.event.type === "xstate.init") {
      continue;
    }

    if (step.event.type.startsWith(AFTER_PREFIX)) {
      if (advance === undefined) {
        throw new Error(`Expected an advance option to run the delayed event '${step.event.type}'.`);
      }

      await advance(step.event);
    } else if (!settler.settle(step.event)) {
      actor.send(step.event);
    }

    await flush();

    const expected = JSON.stringify(toModelState(step.state));
    const received = JSON.stringify(toModelState(actor.getSnapshot()));

    if (received !== expected) {
      throw new Error(
        `Expected step ${index} (${describeEvent(step.event)}) of '${path.description}' to reach ${expected}, but got ${received}.`,
      );
    }
  }
}
