import { describe, expect, it } from "vitest";

import { getCloudStatusLabel } from "./cloud-labels";

describe("getCloudStatusLabel", () => {
  it("should say Up to date when every Cloud project saved", () => {
    expect(getCloudStatusLabel("synced")).toEqual({ label: "Up to date", tone: "ok" });
  });

  it("should count the projects that did not save", () => {
    expect(getCloudStatusLabel("synced", { failedProjects: 2 })).toEqual({
      label: "2 projects not saved",
      tone: "warn",
    });
  });

  it("should say when a held-back save goes, rather than Up to date while other browsers have the older copy", () => {
    const heldUntilMs = new Date(2026, 9, 23, 14, 32).getTime();
    const nowMs = heldUntilMs - 60_000;
    const time = new Date(heldUntilMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    expect(getCloudStatusLabel("synced", { heldUntilMs, nowMs })).toEqual({
      label: `Saved here, sending to Cloud at ${time}`,
      tone: "busy",
    });
    expect(getCloudStatusLabel("synced", { failedProjects: 1, heldUntilMs, nowMs }).label).toBe("1 project not saved");
  });

  it("should write the hour without a leading zero", () => {
    const heldUntilMs = new Date(2026, 9, 23, 9, 5).getTime();

    expect(getCloudStatusLabel("synced", { heldUntilMs, nowMs: heldUntilMs - 1 }).label).not.toMatch(/at 0\d/);
  });

  it("should say soon once the held save's time has passed, as when a hidden tab's timer runs late", () => {
    const heldUntilMs = new Date(2026, 9, 23, 14, 32).getTime();

    expect(getCloudStatusLabel("synced", { heldUntilMs, nowMs: heldUntilMs })).toEqual({
      label: "Saved here, sending to Cloud soon",
      tone: "busy",
    });
    expect(getCloudStatusLabel("synced", { heldUntilMs, nowMs: heldUntilMs + 5 * 60_000 }).label).toBe(
      "Saved here, sending to Cloud soon",
    );
  });
});
