import { describe, expect, it, vi } from "vitest";

import { followSessionActivity, sessionActivityIntervalMs } from "./session-activity";

describe("followSessionActivity", () => {
  it("should not renew an unattended visible tab when the network reconnects", () => {
    const page = {
      window: new EventTarget(),
      document: Object.assign(new EventTarget(), { visibilityState: "visible" as const }),
    };
    let now = 0;
    const refresh = vi.fn();
    const stop = followSessionActivity({ page, nowMs: () => now, refresh });

    now += 24 * sessionActivityIntervalMs;
    page.window.dispatchEvent(new Event("online"));
    expect(refresh).not.toHaveBeenCalled();
    page.document.dispatchEvent(new Event("pointerdown"));
    expect(refresh).toHaveBeenCalledOnce();

    stop();
  });

  it("should check activity hourly, ignore hidden tabs, and stop following after cleanup", () => {
    const documentState: { visibilityState: DocumentVisibilityState } = { visibilityState: "visible" };
    const page = {
      window: new EventTarget(),
      document: Object.assign(new EventTarget(), documentState),
    };
    let now = 0;
    const refresh = vi.fn();
    const stop = followSessionActivity({ page, nowMs: () => now, refresh });

    page.document.dispatchEvent(new Event("keydown"));
    expect(refresh).not.toHaveBeenCalled();
    now += sessionActivityIntervalMs;
    page.document.dispatchEvent(new Event("keydown"));
    page.document.dispatchEvent(new Event("pointerdown"));
    page.window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);

    now += sessionActivityIntervalMs;
    page.document.visibilityState = "hidden";
    page.window.dispatchEvent(new Event("online"));
    expect(refresh).toHaveBeenCalledTimes(1);
    page.document.visibilityState = "visible";
    page.document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    now += sessionActivityIntervalMs;
    page.window.dispatchEvent(new Event("focus"));
    page.document.dispatchEvent(new Event("pointerdown"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
