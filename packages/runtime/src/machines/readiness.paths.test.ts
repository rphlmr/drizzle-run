import type { RuntimeCapabilities } from "@drizzle-run/core/contracts";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, type SnapshotFrom } from "xstate";

import { preparationPercent, readinessMachine, type ReadinessCheck, type ReadinessRequest } from "./readiness.ts";

const PROLONGED_PREPARATION_MS = 3_000;
const PROLONGED_DELAY = `xstate.after.${PROLONGED_PREPARATION_MS}.readiness.preparing`;

function checkWith(status: RuntimeCapabilities["status"]): ReadinessCheck<undefined> {
  return { capabilities: { status, reasons: [] }, checked: undefined };
}

const checkOutcome: ActorOutcome<ReadinessCheck<undefined>> = {
  outputs: [
    checkWith("available"),
    checkWith("browser_unsupported"),
    checkWith("embedding_context_unsupported"),
    checkWith("configuration_error"),
  ],
  error: new Error("The check failed."),
};
const outcomes = { check: checkOutcome };

const request: ReadinessRequest = {
  key: "project",
  check: async () => checkWith("available"),
  prepare: async () => ({ dispose: () => undefined }),
};

const select = { type: "readiness.select", request } as const;
const retry = { type: "readiness.retry" } as const;
const clear = { type: "readiness.clear" } as const;
const prolong = { type: PROLONGED_DELAY } as const;

const eventLabels = new WeakMap<object, string>([[prolong, "after 3000 ms"]]);

function label<TEvent extends object>(event: TEvent, name: string) {
  eventLabels.set(event, name);

  return event;
}

function getPreparerEvents(attempt: number) {
  return [
    { name: "current", attempt },
    { name: "stale", attempt: attempt - 1 },
  ].flatMap(({ name, attempt: eventAttempt }) => [
    label(
      { type: "preparation.progress", attempt: eventAttempt, event: { type: "runtime.done" } } as const,
      `preparation.progress runtime.done from the ${name} attempt`,
    ),
    label(
      { type: "preparation.progress", attempt: eventAttempt, event: { type: "editor.done" } } as const,
      `preparation.progress editor.done from the ${name} attempt`,
    ),
    label(
      {
        type: "preparation.progress",
        attempt: eventAttempt,
        event: { type: "download.progress", downloadedBytes: 20, totalBytes: 40 },
      } as const,
      `preparation.progress download.progress from the ${name} attempt`,
    ),
    label(
      { type: "preparation.done", attempt: eventAttempt, session: { dispose: () => undefined } } as const,
      `preparation.done from the ${name} attempt`,
    ),
    label(
      { type: "preparation.failed", attempt: eventAttempt, error: "The preparation failed." } as const,
      `preparation.failed from the ${name} attempt`,
    ),
  ]);
}

function describeEvent(event: ModelEvent) {
  const name = eventLabels.get(event);

  if (name !== undefined) {
    return name;
  }

  if (event.type === "xstate.done.actor.0.readiness.checking" && typeof event.output === "object") {
    const index = checkOutcome.outputs.findIndex((output) => Object.is(output, event.output));

    return `done(check) ${checkOutcome.outputs[index]?.capabilities.status ?? "unknown"}`;
  }

  return undefined;
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function toModelState(snapshot: SnapshotFrom<typeof readinessMachine>) {
  if (!snapshot.matches("preparing")) {
    return { value: snapshot.value };
  }

  return {
    value: snapshot.value,
    percent: preparationPercent(snapshot.context.progress),
    prolonged: snapshot.context.prolonged,
  };
}

function startReadiness() {
  const settler = createActorSettler();
  const machine = readinessMachine.provide({
    actors: { check: settler.fromOutcome(outcomes.check), prepare: fromCallback(() => undefined) },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(readinessMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    select,
    retry,
    clear,
    ...(snapshot.matches("preparing") ? [prolong] : []),
    ...getPreparerEvents(snapshot.context.attempt),
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("readiness machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startReadiness();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(PROLONGED_PREPARATION_MS),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
