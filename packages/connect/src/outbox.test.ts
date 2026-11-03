import { CONNECT_LIMITS } from "@drizzle-run/core/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Outbox, OUTBOX_PACE } from "./outbox.ts";

interface TestItem {
  key: string;
  text: string;
}

/** Merge items of the same key, as the companion merges streamed text of one turn. */
function mergeSameKey(earlier: TestItem, later: TestItem): TestItem | undefined {
  return earlier.key === later.key ? { key: earlier.key, text: earlier.text + later.text } : undefined;
}

function makeOutbox({ burst = 3, perSecond = 2 }: { burst?: number; perSecond?: number } = {}) {
  const sent: TestItem[] = [];
  const outbox = new Outbox<TestItem>({
    deliver: async (item) => {
      sent.push(item);
    },
    merge: mergeSameKey,
    burst,
    perSecond,
    now: () => Date.now(),
  });

  return { outbox, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Outbox", () => {
  it("should pace under the relay's bucket with room to spare", () => {
    expect(OUTBOX_PACE.burst).toBeLessThan(CONNECT_LIMITS.relayBurst);
    expect(OUTBOX_PACE.perSecond).toBeLessThan(CONNECT_LIMITS.relayPerSecond);
  });

  it("should send a burst at once, then one item per token, in order", async () => {
    vi.useFakeTimers();
    const { outbox, sent } = makeOutbox();

    for (const key of ["a", "b", "c", "d", "e"]) {
      outbox.push({ key, text: key });
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((item) => item.key)).toEqual(["a", "b", "c"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(sent.map((item) => item.key)).toEqual(["a", "b", "c", "d"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(sent.map((item) => item.key)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("should merge items that wait for their turn, and only neighbours that allow it", async () => {
    vi.useFakeTimers();
    const { outbox, sent } = makeOutbox({ burst: 1 });

    for (const [key, text] of [
      ["turn", "first"],
      ["turn", " second"],
      ["turn", " third"],
      ["call", "tool"],
      ["turn", " fourth"],
    ]) {
      outbox.push({ key, text });
    }

    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toEqual([
      { key: "turn", text: "first" },
      { key: "turn", text: " second third" },
      { key: "call", text: "tool" },
      { key: "turn", text: " fourth" },
    ]);
  });

  it("should hand back waiting items it drops or clears, and send nothing after a clear", async () => {
    vi.useFakeTimers();
    const { outbox, sent } = makeOutbox({ burst: 1 });

    outbox.push({ key: "a", text: "1" });
    outbox.push({ key: "b", text: "2" });
    outbox.push({ key: "c", text: "3" });
    await vi.advanceTimersByTimeAsync(0);

    expect(outbox.drop((item) => item.key === "b")).toEqual([{ key: "b", text: "2" }]);
    expect(outbox.clear()).toEqual([{ key: "c", text: "3" }]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([{ key: "a", text: "1" }]);
    expect(outbox.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
