import { RELAY_CLOSE, type RelayServerFrame } from "@drizzle-run/core/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeRelay } from "../test/harness.ts";
import { MAX_RETRY_ATTEMPTS, RelayClient } from "./relay.ts";

function startClient() {
  const relay = new FakeRelay();
  const closed: [number, number | undefined][] = [];
  const opened = vi.fn(relay.open);
  const client = new RelayClient({
    url: "ws://relay.test/room",
    open: opened,
    handlers: {
      frame: () => undefined,
      closed: (code, retryInMs) => closed.push([code, retryInMs]),
    },
  });

  client.start();

  return { client, relay, closed, opened };
}

function welcome(relay: FakeRelay) {
  relay.server({ t: "welcome", id: "comp1", role: "companion", peers: [], maxFrameBytes: 524_288 });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RelayClient", () => {
  it("should back off between reconnects, start over once welcomed, and give up after the last attempt", async () => {
    vi.useFakeTimers();
    const { relay, closed, opened } = startClient();

    relay.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(1_000);
    relay.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(2_000);
    welcome(relay);
    relay.emit("close", { code: 1006, reason: "" });

    expect(closed).toEqual([
      [1006, 1_000],
      [1006, 2_000],
      [1006, 1_000],
    ]);

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      relay.emit("close", { code: 1006, reason: "" });
    }

    expect(closed.at(-1)).toEqual([1006, undefined]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opened).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS + 3);
  });

  it("should stop for good on a final close code, and on close while it waits to retry", async () => {
    vi.useFakeTimers();
    const replaced = startClient();

    replaced.relay.emit("close", { code: RELAY_CLOSE.replaced, reason: "" });
    expect(replaced.closed).toEqual([[RELAY_CLOSE.replaced, undefined]]);

    const waiting = startClient();

    waiting.relay.emit("close", { code: 1006, reason: "" });
    waiting.client.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(waiting.opened).toHaveBeenCalledTimes(1);
    expect(waiting.client.send("tab1", "sealed")).toBe(false);
  });

  it("should stay closed when the relay's welcome arrives after a close while connecting", async () => {
    vi.useFakeTimers();
    const relay = new FakeRelay();
    const frames: RelayServerFrame[] = [];
    const closed: [number, number | undefined][] = [];
    const opened = vi.fn((url: string, protocols: readonly string[]) => ({
      ...relay.open(url, protocols),
      close: (code?: number) => {
        relay.closedWith = code;
      },
    }));
    const client = new RelayClient({
      url: "ws://relay.test/room",
      open: opened,
      handlers: {
        frame: (frame) => frames.push(frame),
        closed: (code, retryInMs) => closed.push([code, retryInMs]),
      },
    });

    client.start();
    client.close();
    welcome(relay);
    relay.emit("close", { code: relay.closedWith, reason: "" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(frames).toEqual([]);
    expect(closed).toEqual([[1000, undefined]]);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("should not report a frame as sent while its socket is closing", () => {
    const relay = new FakeRelay();
    const client = new RelayClient({
      url: "ws://relay.test/room",
      open: (url, protocols) => ({ ...relay.open(url, protocols), close: () => undefined }),
      handlers: { frame: () => undefined, closed: () => undefined },
    });

    client.start();
    welcome(relay);
    client.close();

    expect(client.send("tab1", "sealed")).toBe(false);
    expect(relay.frames).toEqual([]);
  });

  it("should send while a socket is up, and report its close once closed", () => {
    const { client, relay, closed } = startClient();

    welcome(relay);

    expect(client.send("tab1", "sealed")).toBe(true);
    expect(relay.frames).toEqual([JSON.stringify({ t: "send", to: "tab1", d: "sealed" })]);

    client.close();

    expect(relay.closedWith).toBe(1000);
    expect(closed).toEqual([[1000, undefined]]);
    expect(client.send("tab1", "again")).toBe(false);
  });
});
