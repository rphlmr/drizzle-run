import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createBrowserRuntime } = vi.hoisted(() => ({ createBrowserRuntime: vi.fn() }));

vi.mock("@drizzle-run/runtime/browser", () => ({ createBrowserRuntime }));

describe("getSharedRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
    createBrowserRuntime.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["iPhone", 5, "on_demand"],
    ["Macintosh", 5, "on_demand"],
    ["Macintosh", 0, "eager"],
  ])("should configure the runtime for %s with %s touch points", async (userAgent, maxTouchPoints, preparation) => {
    vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
    createBrowserRuntime.mockImplementation(() => ({ id: crypto.randomUUID() }));
    const { getSharedRuntime } = await import("./shared-runtime");

    await getSharedRuntime();

    expect(createBrowserRuntime).toHaveBeenCalledExactlyOnceWith({ preparation });
  });

  it("should create one runtime per page", async () => {
    const runtime = { id: "runtime" };
    createBrowserRuntime.mockReturnValue(runtime);
    const { getSharedRuntime } = await import("./shared-runtime");

    const [first, second] = await Promise.all([getSharedRuntime(), getSharedRuntime()]);

    expect(first).toBe(runtime);
    expect(second).toBe(runtime);
    expect(createBrowserRuntime).toHaveBeenCalledTimes(1);
  });

  it("should retry after a failed creation", async () => {
    const runtime = { id: "runtime" };
    createBrowserRuntime
      .mockImplementationOnce(() => {
        throw new Error("worker unavailable");
      })
      .mockReturnValue(runtime);
    const { getSharedRuntime } = await import("./shared-runtime");

    await expect(getSharedRuntime()).rejects.toThrow("worker unavailable");
    await expect(getSharedRuntime()).resolves.toBe(runtime);
    expect(createBrowserRuntime).toHaveBeenCalledTimes(2);
  });

  it("should give a side-by-side project's second side a runtime of its own", async () => {
    createBrowserRuntime.mockImplementation(() => ({ id: crypto.randomUUID() }));
    const { getSharedRuntime } = await import("./shared-runtime");

    const [first, second, again] = await Promise.all([getSharedRuntime(0), getSharedRuntime(1), getSharedRuntime(1)]);

    expect(first).not.toBe(second);
    expect(again).toBe(second);
    expect(await getSharedRuntime()).toBe(first);
  });

  it("should dispose the second side's runtime once no view holds it, and keep it across a handover", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(async () => {});
    createBrowserRuntime.mockImplementation(() => ({ id: crypto.randomUUID(), dispose }));
    const { getSharedRuntime, holdSharedRuntime } = await import("./shared-runtime");

    const release = holdSharedRuntime(1);
    const side = await getSharedRuntime(1);

    release();
    const handover = holdSharedRuntime(1);
    await vi.runAllTimersAsync();
    expect(dispose).not.toHaveBeenCalled();
    expect(await getSharedRuntime(1)).toBe(side);

    handover();
    handover();
    await vi.runAllTimersAsync();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await getSharedRuntime(1)).not.toBe(side);

    const page = holdSharedRuntime(0);
    await getSharedRuntime(0);
    page();
    await vi.runAllTimersAsync();
    expect(dispose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
