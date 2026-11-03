import type { RuntimeCapabilities } from "@drizzle-run/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import {
  createReadinessMachine,
  readinessMachine,
  preparationPercent,
  type EditorSession,
  type PreparationEvent,
  type PreparationProgress,
  type ReadinessCheck,
  type ReadinessRequest,
} from "./readiness.ts";

const available: RuntimeCapabilities = { status: "available", reasons: [] };

function makeCheck(capabilities: RuntimeCapabilities = available): ReadinessCheck<undefined> {
  return { capabilities, checked: undefined };
}

const request = (overrides: Partial<ReadinessRequest> = {}): ReadinessRequest => ({
  key: "project",
  check: async () => makeCheck(),
  prepare: async () => ({ dispose: vi.fn() }),
  ...overrides,
});

const settle = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

describe("project readiness", () => {
  it("should stop in unsupported.browser and never prepare", async () => {
    const prepare = vi.fn();
    const capabilities: RuntimeCapabilities = {
      status: "browser_unsupported",
      reasons: [{ code: "no_shared_memory", message: "No shared memory." }],
    };
    const actor = createActor(readinessMachine).start();

    actor.send({ type: "readiness.select", request: request({ check: async () => makeCheck(capabilities), prepare }) });
    await waitFor(actor, (state) => state.matches({ unsupported: "browser" }));

    expect(actor.getSnapshot().context.capabilities).toEqual(capabilities);
    expect(prepare).not.toHaveBeenCalled();
    actor.send({ type: "readiness.retry" });
    expect(actor.getSnapshot().matches({ unsupported: "browser" })).toBe(true);
    actor.stop();
  });

  it("should map embedding and configuration statuses to their own states", async () => {
    const actor = createActor(readinessMachine).start();

    actor.send({
      type: "readiness.select",
      request: request({ check: async () => makeCheck({ status: "embedding_context_unsupported", reasons: [] }) }),
    });
    await waitFor(actor, (state) => state.matches({ unsupported: "embedding" }));
    expect(actor.getSnapshot().matches({ unsupported: "embedding" })).toBe(true);

    actor.send({
      type: "readiness.select",
      request: request({ check: async () => makeCheck({ status: "configuration_error", reasons: [] }) }),
    });
    await waitFor(actor, (state) => state.matches({ unsupported: "configuration" }));
    expect(actor.getSnapshot().matches({ unsupported: "configuration" })).toBe(true);
    actor.stop();
  });

  it("should track bytes and step completion while preparing", async () => {
    let report: ((event: PreparationEvent) => void) | undefined;
    let finish: ((session: EditorSession) => void) | undefined;
    const actor = createActor(readinessMachine).start();

    actor.send({
      type: "readiness.select",
      request: request({
        prepare: (_checked, _signal, reporter) => {
          report = reporter;

          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      }),
    });
    await waitFor(actor, (state) => state.matches("preparing"));

    report?.({ type: "download.progress", downloadedBytes: 10, totalBytes: 40 });
    report?.({ type: "editor.done" });
    expect(actor.getSnapshot().context.progress).toEqual({
      runtimeDone: false,
      editorDone: true,
      downloadedBytes: 10,
      totalBytes: 40,
    });

    report?.({ type: "runtime.done" });
    expect(actor.getSnapshot().context.progress.runtimeDone).toBe(true);
    finish?.({ dispose: vi.fn() });
    await waitFor(actor, (state) => state.matches("ready"));
    actor.stop();
  });

  it("should ignore progress from a superseded request", async () => {
    let staleReport: ((event: PreparationEvent) => void) | undefined;
    const actor = createActor(readinessMachine).start();

    actor.send({
      type: "readiness.select",
      request: request({
        key: "old",
        prepare: (_checked, _signal, reporter) => {
          staleReport = reporter;

          return new Promise(() => undefined);
        },
      }),
    });
    await waitFor(actor, (state) => state.matches("preparing"));
    actor.send({
      type: "readiness.select",
      request: request({ key: "new", prepare: () => new Promise(() => undefined) }),
    });
    await waitFor(actor, (state) => state.matches("preparing") && state.context.request?.key === "new");

    staleReport?.({ type: "download.progress", downloadedBytes: 30, totalBytes: 40 });
    staleReport?.({ type: "runtime.done" });

    expect(actor.getSnapshot().context.progress).toEqual({
      runtimeDone: false,
      editorDone: false,
      downloadedBytes: 0,
      totalBytes: null,
    });
    actor.stop();
  });

  it("should retry from failed back to checking with the same request", async () => {
    const dispose = vi.fn();
    const check = vi.fn(async () => makeCheck());
    const prepare = vi.fn().mockRejectedValueOnce(new Error("declarations unavailable")).mockResolvedValue({ dispose });
    const actor = createActor(readinessMachine).start();

    actor.send({ type: "readiness.select", request: request({ check, prepare }) });
    await waitFor(actor, (state) => state.matches("failed"));
    expect(actor.getSnapshot().context.error).toContain("declarations unavailable");

    actor.send({ type: "readiness.retry" });
    expect(actor.getSnapshot().matches("checking")).toBe(true);
    await waitFor(actor, (state) => state.matches("ready"));
    expect(check).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(2);

    actor.send({ type: "readiness.clear" });
    expect(dispose).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("should retry a configuration error", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce(makeCheck({ status: "configuration_error", reasons: [] }))
      .mockResolvedValue(makeCheck());
    const actor = createActor(readinessMachine).start();

    actor.send({ type: "readiness.select", request: request({ check }) });
    await waitFor(actor, (state) => state.matches({ unsupported: "configuration" }));
    actor.send({ type: "readiness.retry" });
    await waitFor(actor, (state) => state.matches("ready"));
    expect(check).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().matches("ready")).toBe(true);
    actor.stop();
  });

  it("should dispose late initialization and never replace the selected project", async () => {
    let finish: ((session: EditorSession) => void) | undefined;
    const stale = { dispose: vi.fn() };
    const current = { dispose: vi.fn() };
    const actor = createActor(readinessMachine).start();

    actor.send({
      type: "readiness.select",
      request: request({
        key: "old",
        prepare: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    });
    await waitFor(actor, (state) => state.matches("preparing"));
    actor.send({ type: "readiness.select", request: request({ key: "new", prepare: async () => current }) });
    await waitFor(actor, (state) => state.matches("ready"));

    finish?.(stale);
    await settle();

    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().context.session).toBe(current);
    actor.send({ type: "readiness.clear" });
    expect(current.dispose).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("should drop the request once the session is ready, and the key on a clear, so no host closure outlives them", async () => {
    const actor = createActor(readinessMachine).start();

    actor.send({ type: "readiness.select", request: request({ key: "pair" }) });
    await waitFor(actor, (state) => state.matches("ready"));

    expect(actor.getSnapshot().context).toMatchObject({ key: "pair", request: undefined });

    actor.send({ type: "readiness.clear" });

    expect(actor.getSnapshot().context).toMatchObject({ key: undefined, request: undefined, session: undefined });
    actor.stop();
  });

  it("should hand the check's result to prepare, and release it when no prepared session owns it", async () => {
    const release = vi.fn();
    const prepare = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ dispose: vi.fn() });
    let attempt = 0;
    const actor = createActor(createReadinessMachine<EditorSession, number>()).start();
    const checked: ReadinessRequest<EditorSession, number> = {
      key: "project",
      check: async () => ({ capabilities: available, checked: (attempt += 1) }),
      prepare,
      release,
    };

    actor.send({ type: "readiness.select", request: checked });
    await waitFor(actor, (state) => state.matches("failed"));
    actor.send({ type: "readiness.retry" });
    await waitFor(actor, (state) => state.matches("ready"));
    actor.send({ type: "readiness.clear" });

    expect(prepare.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(release.mock.calls).toEqual([[1]]);
    actor.stop();
  });

  it("should keep the request of a failed preparation for a retry", async () => {
    const actor = createActor(readinessMachine).start();

    actor.send({
      type: "readiness.select",
      request: request({
        prepare: async () => {
          throw new Error("offline");
        },
      }),
    });
    await waitFor(actor, (state) => state.matches("failed"));

    expect(actor.getSnapshot().context.request?.key).toBe("project");
    actor.stop();
  });

  it("should keep the preparation signal alive once the session is ready", async () => {
    let preparationSignal: AbortSignal | undefined;
    const actor = createActor(readinessMachine).start();

    actor.send({
      type: "readiness.select",
      request: request({
        prepare: async (_checked, signal) => {
          preparationSignal = signal;

          return { dispose: vi.fn() };
        },
      }),
    });
    await waitFor(actor, (state) => state.matches("ready"));

    expect(preparationSignal?.aborted).toBe(false);
    actor.stop();
  });

  it("should flag a prolonged preparation", async () => {
    vi.useFakeTimers();

    try {
      const actor = createActor(readinessMachine).start();

      actor.send({ type: "readiness.select", request: request({ prepare: () => new Promise(() => undefined) }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(actor.getSnapshot().matches("preparing")).toBe(true);
      expect(actor.getSnapshot().context.prolonged).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      expect(actor.getSnapshot().context.prolonged).toBe(true);
      actor.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

const makeProgress = (overrides: Partial<PreparationProgress>): PreparationProgress => ({
  runtimeDone: false,
  editorDone: false,
  downloadedBytes: 0,
  totalBytes: null,
  ...overrides,
});

describe("preparation percent", () => {
  it("should be unknown until the download size is", () => {
    expect(preparationPercent(makeProgress({ downloadedBytes: 40 }))).toBeNull();
    expect(preparationPercent(makeProgress({ downloadedBytes: 40, totalBytes: 0 }))).toBeNull();
  });

  it("should round down and cap the downloaded share", () => {
    expect(preparationPercent(makeProgress({ downloadedBytes: 683, totalBytes: 1000 }))).toBe(68);
    expect(preparationPercent(makeProgress({ downloadedBytes: 1200, totalBytes: 1000 }))).toBe(100);
  });

  it("should read 100 once the runtime is prepared, even from the cache", () => {
    expect(preparationPercent(makeProgress({ runtimeDone: true }))).toBe(100);
  });
});
