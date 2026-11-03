import { getMachinePaths, toTransitionTable } from "@drizzle-run/machine-paths";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotFrom } from "xstate";
import { createActor } from "xstate";

import { createWireTransportMachine, WireTransport } from "./wire-transport.ts";

function flushEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("WireTransport", () => {
  it("should suppress queued connect notifications after destruction", async () => {
    const transport = new WireTransport();
    const connected = vi.fn();
    const closed = vi.fn();
    transport.on("connect", connected);
    transport.on("close", closed);

    transport.connect();
    transport.destroy();
    transport.destroy();
    await flushEvents();

    expect(connected).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => transport.write(Uint8Array.of(1))).toThrow("closed");
  });

  it.each(["resolve", "reject"] as const)(
    "should ignore late %s after settling pending writes on close",
    async (outcome) => {
      const work = Promise.withResolvers<number[]>();
      const transport = new WireTransport({ exchange: () => work.promise });
      const reply = vi.fn();
      const callback = vi.fn();
      transport.on("data", reply);
      transport.on("error", reply);
      transport.connect();
      await flushEvents();

      transport.write(Uint8Array.of(1), callback);
      transport.destroy();
      await flushEvents();

      expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error));

      if (outcome === "resolve") {
        work.resolve([2]);
      } else {
        work.reject(new Error("late reply"));
      }

      await flushEvents();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it("should replay every bounded wire transition", () => {
    const machine = createWireTransportMachine({ exchange: () => new Promise(() => {}), emit() {}, defer() {} });
    const toModelState = (snapshot: SnapshotFrom<typeof machine>) => ({
      value: snapshot.value,
      sequence: snapshot.context.sequence,
      pending: [...snapshot.context.pending.keys()],
    });
    const paths = getMachinePaths(machine, {
      limit: 1_000,
      toModelState,
      events: (snapshot) => [
        { type: "connection.request" },
        { type: "connection.ready" },
        { type: "connection.announce" },
        { type: "connection.close" },
        ...(snapshot.context.sequence === 0 ? [{ type: "write.request", bytes: Uint8Array.of(1) }] : []),
        { type: "exchange.fulfill", id: 1, reply: [2] },
        { type: "exchange.reject", id: 1, cause: new Error("failed") },
      ],
    });
    expect(toTransitionTable(paths)).toMatchSnapshot();

    for (const path of paths) {
      const actor = createActor(machine).start();

      for (const { event } of path.steps) {
        if (
          event.type === "connection.request" ||
          event.type === "connection.ready" ||
          event.type === "connection.announce" ||
          event.type === "connection.close"
        ) {
          actor.send({ type: event.type });
        } else if (event.type === "write.request") {
          actor.send({ type: "write.request", bytes: Uint8Array.of(1) });
        } else if (event.type === "exchange.fulfill") {
          actor.send({ type: "exchange.fulfill", id: 1, reply: [2] });
        } else if (event.type === "exchange.reject") {
          actor.send({ type: "exchange.reject", id: 1, cause: new Error("failed") });
        }
      }

      expect(toModelState(actor.getSnapshot())).toEqual(toModelState(path.state));
      actor.stop();
    }
  });
});
