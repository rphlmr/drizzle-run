import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { createEmbedMachine, type EmbedHostOrigin } from "./machine.js";

const NONCE = "a".repeat(32);
const NEXT_NONCE = "b".repeat(32);

function startLoader({ hostOrigin = "tuple" }: { hostOrigin?: EmbedHostOrigin } = {}) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(args.length === 0 ? name : `${name}:${JSON.stringify(args[0])}`);
    };
  const loader = createActor(
    createEmbedMachine({
      showDormant: record("showDormant"),
      openFrame: record("openFrame"),
      connectFrame: record("connectFrame"),
      revealFrame: record("revealFrame"),
      removeFrame: record("removeFrame"),
      showFailure: record("showFailure"),
      showUnsupported: record("showUnsupported"),
      notifyReady: record("notifyReady"),
      notifyCapability: record("notifyCapability"),
      notifyError: record("notifyError"),
      notifyRunSettled: record("notifyRunSettled"),
      restoreHost: record("restoreHost"),
    }),
    { input: { hostOrigin } },
  ).start();

  return { loader, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("embed loader machine", () => {
  it("should show the card, then open a frame under the attempt's nonce on activation", () => {
    const { loader, calls } = startLoader();

    loader.send({ type: "embed.load.activate", nonce: NONCE });

    expect(loader.getSnapshot().matches({ frame: "loading" })).toBe(true);
    expect(loader.getSnapshot().context.nonce).toBe(NONCE);
    expect(calls).toEqual(["showDormant", `openFrame:"${NONCE}"`]);
  });

  it("should answer only a hello that carries the attempt's nonce", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.frame.hello", nonce: NEXT_NONCE });
    loader.send({ type: "embed.frame.hello", nonce: NONCE });

    expect(calls.filter((call) => call.startsWith("connectFrame"))).toEqual([`connectFrame:"${NONCE}"`]);
  });

  it("should reveal a live frame on ready, and report ready once", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.frame.ready", nonce: NEXT_NONCE });
    expect(loader.getSnapshot().matches({ frame: "loading" })).toBe(true);

    loader.send({ type: "embed.frame.ready", nonce: NONCE });
    loader.send({ type: "embed.frame.ready", nonce: NONCE });

    expect(loader.getSnapshot().matches({ frame: "ready" })).toBe(true);
    expect(calls.slice(2)).toEqual(["revealFrame", 'notifyReady:{"mode":"live"}']);
  });

  it("should report a recorded capability, then reveal the frame as recorded", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.frame.capability", nonce: NONCE, status: "recorded" });
    loader.send({ type: "embed.frame.ready", nonce: NONCE });

    expect(loader.getSnapshot().matches({ frame: "ready" })).toBe(true);
    expect(calls.slice(2)).toEqual([
      'notifyCapability:{"status":"recorded"}',
      "revealFrame",
      'notifyReady:{"mode":"recorded"}',
    ]);
  });

  it("should report an available capability and keep loading", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.frame.capability", nonce: NONCE, status: "available" });

    expect(loader.getSnapshot().matches({ frame: "loading" })).toBe(true);
    expect(calls.slice(2)).toEqual(['notifyCapability:{"status":"available"}']);
  });

  it("should remove the frame and explain an unsupported page, from loading or ready", () => {
    const loading = startLoader();
    loading.loader.send({ type: "embed.load.activate", nonce: NONCE });
    loading.loader.send({ type: "embed.frame.capability", nonce: NONCE, status: "embedding_context_unsupported" });

    const ready = startLoader();
    ready.loader.send({ type: "embed.load.activate", nonce: NONCE });
    ready.loader.send({ type: "embed.frame.ready", nonce: NONCE });
    ready.loader.send({ type: "embed.frame.capability", nonce: NONCE, status: "browser_unsupported" });

    expect(loading.loader.getSnapshot().value).toBe("unsupported");
    expect(loading.calls.slice(2)).toEqual([
      "removeFrame",
      'notifyCapability:{"status":"embedding_context_unsupported"}',
      'showUnsupported:"embedding_context_unsupported"',
    ]);
    expect(ready.loader.getSnapshot().value).toBe("unsupported");
    expect(ready.calls.at(-1)).toBe('showUnsupported:"browser_unsupported"');
  });

  it("should fail with the frame's code, then retry under a fresh nonce and ignore the old frame", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.frame.error", nonce: NONCE, code: "initialization" });
    expect(loader.getSnapshot().value).toBe("failed");
    expect(calls.slice(2)).toEqual([
      "removeFrame",
      'notifyError:{"code":"initialization"}',
      'showFailure:"initialization"',
    ]);

    loader.send({ type: "embed.load.retry", nonce: NEXT_NONCE });
    loader.send({ type: "embed.frame.error", nonce: NONCE, code: "frame_load" });

    expect(loader.getSnapshot().matches({ frame: "loading" })).toBe(true);
    expect(loader.getSnapshot().context.nonce).toBe(NEXT_NONCE);
  });

  it("should end on unavailable for a code a retry cannot help, and refuse a retry", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });
    loader.send({ type: "embed.frame.ready", nonce: NONCE });

    loader.send({ type: "embed.frame.error", nonce: NONCE, code: "not_found" });
    loader.send({ type: "embed.load.retry", nonce: NEXT_NONCE });

    expect(loader.getSnapshot().value).toBe("unavailable");
    expect(calls.at(-1)).toBe('showFailure:"not_found"');
  });

  it("should fail with a timeout when the frame is not ready in 30 seconds", () => {
    vi.useFakeTimers();
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    vi.advanceTimersByTime(29_999);
    expect(loader.getSnapshot().matches({ frame: "loading" })).toBe(true);

    vi.advanceTimersByTime(1);
    expect(loader.getSnapshot().value).toBe("failed");
    expect(calls.at(-1)).toBe('showFailure:"timeout"');
  });

  it("should not time out once the frame is ready", () => {
    vi.useFakeTimers();
    const { loader } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });
    loader.send({ type: "embed.frame.ready", nonce: NONCE });

    vi.advanceTimersByTime(60_000);

    expect(loader.getSnapshot().matches({ frame: "ready" })).toBe(true);
  });

  it("should report settled runs only once ready, and only under the attempt's nonce", () => {
    const { loader, calls } = startLoader();
    const run = { outcome: "succeeded", displays: [], truncated: false } as const;
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.frame.run.settled", nonce: NONCE, run });
    loader.send({ type: "embed.frame.ready", nonce: NONCE });
    loader.send({ type: "embed.frame.run.settled", nonce: NEXT_NONCE, run });
    loader.send({ type: "embed.frame.run.settled", nonce: NONCE, run });

    expect(calls.filter((call) => call.startsWith("notifyRunSettled"))).toEqual([
      `notifyRunSettled:${JSON.stringify(run)}`,
    ]);
  });

  it("should go unavailable without a frame on an opaque host page", () => {
    const { loader, calls } = startLoader({ hostOrigin: "opaque" });

    loader.send({ type: "embed.load.activate", nonce: NONCE });

    expect(loader.getSnapshot().value).toBe("unavailable");
    expect(calls).toEqual(["showDormant", 'notifyError:{"code":"unsupported_host"}', 'showFailure:"unsupported_host"']);
  });

  it("should explain an unsupported browser when it cannot make a nonce", () => {
    const { loader, calls } = startLoader();

    loader.send({ type: "embed.load.activate", nonce: null });

    expect(loader.getSnapshot().value).toBe("unsupported");
    expect(calls.slice(1)).toEqual([
      'notifyCapability:{"status":"browser_unsupported"}',
      'showUnsupported:"browser_unsupported"',
    ]);
  });

  it("should remove the frame and restore the host on dispose, then ignore every event", () => {
    const { loader, calls } = startLoader();
    loader.send({ type: "embed.load.activate", nonce: NONCE });

    loader.send({ type: "embed.dispose" });
    loader.send({ type: "embed.dispose" });
    loader.send({ type: "embed.frame.ready", nonce: NONCE });

    expect(loader.getSnapshot().status).toBe("done");
    expect(calls.slice(2)).toEqual(["removeFrame", "restoreHost"]);
  });
});
