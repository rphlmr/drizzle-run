import {
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import { createActor, type InputFrom, type OutputFrom, type SnapshotFrom } from "xstate";

import { createPostgresBridge, createPostgresBridgeMachine } from "./postgres.ts";

const startup = [0, 0, 0, 8, 0, 3, 0, 0];
const query = [81, 0, 0, 0, 5, 0];

describe("PostgreSQL bridge", () => {
  it("should buffer split frames and serialize requests", async () => {
    const first = Promise.withResolvers<Uint8Array>();
    const execProtocolRaw = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(Uint8Array.of(2));
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ server_version: "17.5" }] }), execProtocolRaw };
    const bridge = await createPostgresBridge({ database });

    expect(await bridge.exchange(startup.slice(0, 4))).toEqual(new Uint8Array());
    expect((await bridge.exchange(startup.slice(4)))[0]).toBe(82);
    const a = bridge.exchange(query);
    const b = bridge.exchange(query);

    expect(execProtocolRaw).toHaveBeenCalledTimes(1);
    first.resolve(Uint8Array.of(1));
    await expect(a).resolves.toEqual(Uint8Array.of(1));
    await expect(b).resolves.toEqual(Uint8Array.of(2));
    expect(execProtocolRaw).toHaveBeenCalledTimes(2);
    bridge.close();
  });

  it("should refuse excess pending requests and suppress remaining frames after close", async () => {
    const pending = Promise.withResolvers<Uint8Array>();
    const execProtocolRaw = vi.fn().mockReturnValue(pending.promise);
    const bridge = await createPostgresBridge({
      database: { query: vi.fn().mockResolvedValue({ rows: [{ server_version: "17.5" }] }), execProtocolRaw },
    });
    await bridge.exchange(startup);
    const requests = Array.from({ length: 32 }, () => bridge.exchange([...query, ...query]));
    const settled = Promise.allSettled(requests);

    await expect(bridge.exchange(query)).rejects.toThrow("32 pending writes");
    bridge.close();
    pending.resolve(Uint8Array.of(1));

    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    await expect(bridge.exchange(query)).rejects.toThrow("closed");
    expect(execProtocolRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    { bytes: [256], message: "Invalid PostgreSQL byte request" },
    { bytes: [0, 0, 0, 7, 0, 3, 0, 0], message: "PostgreSQL exchange failed" },
    { bytes: [0, 0, 0, 8, 0, 0, 0, 0], message: "PostgreSQL exchange failed" },
  ])("should reject malformed protocol input: $message", async ({ bytes, message }) => {
    const execProtocolRaw = vi.fn();
    const bridge = await createPostgresBridge({
      database: { query: vi.fn().mockResolvedValue({ rows: [{ server_version: "17.5" }] }), execProtocolRaw },
    });

    await expect(bridge.exchange(bytes)).rejects.toThrow(message);
    expect(execProtocolRaw).not.toHaveBeenCalled();
    bridge.close();
  });
});

describe("PostgreSQL bridge machine paths", () => {
  const machine = createPostgresBridgeMachine({
    startupReply: new Uint8Array(),
    database: { execProtocolRaw: vi.fn() },
  });
  const outcomes = {
    exchange: {
      outputs: [{ bytes: Uint8Array.of(1), stage: "connected" as const }],
      error: new Error("exchange failed"),
    },
  };
  const request = { bytes: Uint8Array.from(startup), resolve() {}, reject() {} };
  const toModelState = (snapshot: SnapshotFrom<typeof machine>) => ({
    value: snapshot.value,
    stage: snapshot.context.stage,
    pending: snapshot.context.queue.length,
  });
  const paths = getMachinePaths(machine, {
    limit: 2_000,
    toModelState,
    events: (snapshot) => [
      { type: "database.exchange", request },
      { type: "database.close" },
      ...getSettleEvents(snapshot, outcomes),
    ],
  });

  it("should retain the queue capacity, failure and closure transition contract", () => {
    expect(paths.length).toBeGreaterThan(100);
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should replay ${path.description}`, async () => {
      const settler = createActorSettler();
      type Exchange = typeof machine.implementations.actors.exchange;
      const actor = createActor(
        machine.provide({
          actors: { exchange: settler.fromOutcome<OutputFrom<Exchange>, InputFrom<Exchange>>(outcomes.exchange) },
        }),
      ).start();

      try {
        await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      } finally {
        actor.stop();
      }
    });
  }
});
