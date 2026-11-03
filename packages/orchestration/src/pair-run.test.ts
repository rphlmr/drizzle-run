import type { PairManifest, PairSideIndex } from "@drizzle-run/core/pair";
import { pairManifest } from "@drizzle-run/test-fixtures/pair";
import { delay } from "es-toolkit";
import { describe, expect, it } from "vitest";
import { createActor, waitFor } from "xstate";

import { createPairRunMachine, type PairRunSettledEvent, type PairSideOutcome } from "./pair-run.ts";

/** A side runner the test settles by hand, like two run machines would. */
function controlledSides() {
  const pending: {
    side: PairSideIndex;
    signal: AbortSignal;
    settle(outcome: PairSideOutcome): void;
    fail(error: Error): void;
  }[] = [];
  const runSide = ({ side, signal }: { side: PairSideIndex; signal: AbortSignal }) =>
    new Promise<PairSideOutcome>((settle, fail) => pending.push({ side, signal, settle, fail }));

  return { runSide, pending };
}

function start(execution: "parallel" | "sequential" = "sequential") {
  const sides = controlledSides();
  const settled: PairRunSettledEvent[] = [];
  const actor = createActor(createPairRunMachine({ runSide: sides.runSide, execution }));

  actor.on("run.settled", (event) => settled.push(event));
  actor.start();

  return { actor, sides, settled };
}

const flush = () => delay(0);

function makeRequest(requestId: string = crypto.randomUUID(), requester = "test") {
  return { requestId, requester };
}

describe("pair run machine", () => {
  it("should start both sides together by default and preserve side order when the second finishes first", async () => {
    const sides = controlledSides();
    const settled: PairRunSettledEvent[] = [];
    const actor = createActor(createPairRunMachine({ runSide: sides.runSide })).start();
    actor.on("run.settled", (event) => settled.push(event));

    actor.send({ type: "run.request", ...makeRequest() });

    expect(sides.pending.map((run) => run.side)).toEqual([0, 1]);

    sides.pending[1]?.settle("succeeded");
    await flush();

    expect(actor.getSnapshot().matches("running")).toBe(true);
    expect(settled).toEqual([]);

    sides.pending[0]?.settle("failed");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(settled[0]?.outcomes).toEqual(["failed", "succeeded"]);
    actor.stop();
  });

  it("should cancel both parallel sides and wait for both to finish cleanup", async () => {
    const { actor, sides, settled } = start("parallel");

    actor.send({ type: "run.request", ...makeRequest() });
    actor.send({ type: "run.cancel" });

    expect(sides.pending.map((run) => run.signal.aborted)).toEqual([true, true]);

    sides.pending[0]?.settle("cancelled");
    await flush();

    expect(actor.getSnapshot().matches("running")).toBe(true);
    expect(settled).toEqual([]);

    sides.pending[1]?.settle("cancelled");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(settled[0]?.outcomes).toEqual(["cancelled", "cancelled"]);
    actor.stop();
  });

  it("should refuse a request whose shared seed imports another package, and run neither side", () => {
    const sides = controlledSides();
    const refused: unknown[] = [];
    const seeded = pairManifest(undefined, { seed: true });
    const manifest: PairManifest = {
      ...seeded,
      files: { ...seeded.files, "seed.ts": 'import { z } from "zod";\n' },
    };
    const actor = createActor(createPairRunMachine({ runSide: sides.runSide }));

    actor.on("run.refused", (event) => refused.push(event));
    actor.start();
    actor.send({ type: "run.request", ...makeRequest("bad-seed", "guide"), manifest });

    expect(sides.pending).toEqual([]);
    expect(refused).toEqual([
      {
        type: "run.refused",
        requestId: "bad-seed",
        requester: "guide",
        reason: "seed_problem",
        problem: expect.stringContaining("Remove the import of zod"),
      },
    ]);
  });

  it("should check the host's own seed when the request brings no manifest", () => {
    const sides = controlledSides();
    const refused: unknown[] = [];
    const seeded = pairManifest(undefined, { seed: true });
    const manifest: PairManifest = { ...seeded, files: { ...seeded.files, "seed.ts": 'import "zod";\n' } };
    const actor = createActor(createPairRunMachine({ runSide: sides.runSide, getManifest: () => manifest }));

    actor.on("run.refused", (event) => refused.push(event));
    actor.start();
    actor.send({ type: "run.request", ...makeRequest("own-seed", "view") });

    expect(sides.pending).toEqual([]);
    expect(refused).toEqual([expect.objectContaining({ reason: "seed_problem" })]);
  });

  it("should start the second side only after the first side and its cleanup settle", async () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.request", ...makeRequest() });

    expect(sides.pending.map((run) => run.side)).toEqual([0]);

    sides.pending[0]?.settle("succeeded");
    await flush();

    expect(actor.getSnapshot().matches("running")).toBe(true);
    expect(settled).toEqual([]);
    expect(sides.pending.map((run) => run.side)).toEqual([0, 1]);

    sides.pending[1]?.settle("succeeded");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(settled).toEqual([expect.objectContaining({ type: "run.settled", outcomes: ["succeeded", "succeeded"] })]);
  });

  it("should let the other side finish when one fails or its service throws", async () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.request", ...makeRequest() });
    sides.pending[0]?.settle("failed");
    await flush();
    sides.pending[1]?.settle("succeeded");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    actor.send({ type: "run.request", ...makeRequest() });
    sides.pending[2]?.fail(new Error("no runtime"));
    await flush();
    sides.pending[3]?.settle("succeeded");
    await waitFor(actor, (snapshot) => snapshot.matches("settled") && settled.length === 2);

    expect(settled.map((event) => event.outcomes)).toEqual([
      ["failed", "succeeded"],
      ["failed", "succeeded"],
    ]);
  });

  it("should wait for the active side to stop on cancellation without starting the second", async () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.request", ...makeRequest() });
    actor.send({ type: "run.cancel" });

    expect(sides.pending.map((run) => run.signal.aborted)).toEqual([true]);
    expect(actor.getSnapshot().matches("running")).toBe(true);
    expect(settled).toEqual([]);

    sides.pending[0]?.settle("cancelled");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(sides.pending).toHaveLength(1);
    expect(settled).toEqual([expect.objectContaining({ type: "run.settled", outcomes: ["cancelled", "cancelled"] })]);
  });

  it("should start the next run only once both sides of a cancelled one have stopped", async () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.request", ...makeRequest() });
    actor.send({ type: "run.cancel" });
    actor.send({ type: "run.request", ...makeRequest() });

    expect(sides.pending).toHaveLength(1);

    sides.pending[0]?.settle("cancelled");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));
    actor.send({ type: "run.request", ...makeRequest() });

    expect(sides.pending.slice(1).map((run) => [run.side, run.signal.aborted])).toEqual([[0, false]]);

    sides.pending[1]?.settle("succeeded");
    await flush();
    sides.pending[2]?.settle("succeeded");
    await waitFor(actor, (snapshot) => snapshot.matches("settled") && settled.length === 2);

    expect(settled[1]?.outcomes).toEqual(["succeeded", "succeeded"]);
  });

  it("should skip the other side when the first is cancelled on its own", async () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.request", ...makeRequest() });
    sides.pending[0]?.settle("cancelled");
    await flush();

    expect(sides.pending).toHaveLength(1);
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(settled[0]?.outcomes).toEqual(["cancelled", "cancelled"]);
  });

  it("should skip the second side after cancellation even if the first finishes successfully", async () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.request", ...makeRequest() });
    actor.send({ type: "run.cancel" });
    sides.pending[0]?.settle("succeeded");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(sides.pending).toHaveLength(1);
    expect(settled[0]?.outcomes).toEqual(["succeeded", "cancelled"]);
  });

  it("should run the prepare step before both sides, and both sides when it throws", async () => {
    const { actor, sides } = start();
    const step = Promise.withResolvers<void>();

    actor.send({ type: "run.request", ...makeRequest(), prepare: () => step.promise });

    expect(actor.getSnapshot().matches({ running: "preparing" })).toBe(true);
    expect(sides.pending).toEqual([]);

    step.reject(new Error("Prettier failed"));
    await flush();

    expect(sides.pending.map((run) => run.side)).toEqual([0]);
    actor.stop();
  });

  it("should settle both sides as cancelled, starting neither, when cancelled while it prepares", () => {
    const { actor, sides, settled } = start();

    const signals: AbortSignal[] = [];

    actor.send({
      type: "run.request",
      ...makeRequest(),
      prepare: (signal) => {
        signals.push(signal);
        return new Promise<void>(() => {});
      },
    });
    actor.send({ type: "run.cancel" });

    expect(actor.getSnapshot().matches("settled")).toBe(true);
    expect(sides.pending).toEqual([]);
    expect(settled).toEqual([expect.objectContaining({ type: "run.settled", outcomes: ["cancelled", "cancelled"] })]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("should ignore Cancel before a run and Run while one is in progress", () => {
    const { actor, sides, settled } = start();

    actor.send({ type: "run.cancel" });

    expect(actor.getSnapshot().matches("idle")).toBe(true);

    actor.send({ type: "run.request", ...makeRequest() });
    actor.send({ type: "run.request", ...makeRequest() });

    expect(sides.pending).toHaveLength(1);
    expect(settled).toEqual([]);
  });

  it("should refuse a request while both sides run, and settle with the accepted request's id", async () => {
    const { actor, sides, settled } = start();
    const refused: string[] = [];
    actor.on("run.refused", (event) => refused.push(event.requestId));

    actor.send({ type: "run.request", ...makeRequest("first") });
    actor.send({ type: "run.request", ...makeRequest("second") });
    sides.pending[0]?.settle("succeeded");
    await flush();
    sides.pending[1]?.settle("succeeded");
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(refused).toEqual(["second"]);
    expect(sides.pending).toHaveLength(2);
    expect(settled.map((event) => event.requestId)).toEqual(["first"]);
  });

  it("should leave the run going when a cancel names another request", () => {
    const { actor, sides } = start();

    actor.send({ type: "run.request", ...makeRequest("current") });
    actor.send({ type: "run.cancel", requestId: "earlier" });

    expect(sides.pending.map((run) => run.signal.aborted)).toEqual([false]);
  });

  it("should hand a request's pair to each side and settle with each side's run", async () => {
    const manifest = pairManifest();
    const received: (PairManifest | undefined)[] = [];
    const actor = createActor(
      createPairRunMachine({
        runSide: async ({ side, manifest: sideManifest }) => {
          received.push(sideManifest);

          return side === 0 ? { outcome: "failed", error: "Type error" } : "succeeded";
        },
      }),
    );
    const settled: PairRunSettledEvent[] = [];
    actor.on("run.settled", (event) => settled.push(event));
    actor.start();

    actor.send({ type: "run.request", ...makeRequest("guide run", "guide"), manifest });
    await waitFor(actor, (snapshot) => snapshot.matches("settled"));

    expect(received).toEqual([manifest, manifest]);
    expect(settled[0]).toMatchObject({
      requestId: "guide run",
      requester: "guide",
      outcomes: ["failed", "succeeded"],
      runs: [{ outcome: "failed", error: "Type error" }, { outcome: "succeeded" }],
    });
  });
});
