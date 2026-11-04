import type { GuideProgress } from "@drizzle-run/runtime/machines";
import { describe, expect, it } from "vitest";

import type { SettingStore } from "../store/storage";
import { findExample } from "./catalog";
import { getExampleProgress, getExampleViewedSetting, readExampleViews } from "./progress";

const guideProgress: GuideProgress = { guideId: "guide", stepId: "first", completed: [], finished: false };

describe("example progress", () => {
  it("should distinguish a visit from completed guide steps", () => {
    expect(getExampleProgress({})).toBe("not_viewed");
    expect(getExampleProgress({ viewedAt: "2026-11-04T10:00:00Z" })).toBe("viewed");
    expect(getExampleProgress({ progress: guideProgress })).toBe("viewed");
    expect(getExampleProgress({ progress: { ...guideProgress, completed: ["first"] } })).toBe("in_progress");
  });

  it("should keep a completed guide completed on a revisit", () => {
    expect(
      getExampleProgress({ progress: { ...guideProgress, finished: true }, viewedAt: "2026-11-04T10:00:00Z" }),
    ).toBe("completed");
  });

  it("should read valid visit timestamps for plain examples and ignore damaged values", async () => {
    const example = findExample("insert-validators")!;
    const stored = new Map<string, unknown>([[getExampleViewedSetting(example.id), "2026-11-04T10:00:00Z"]]);
    const settings: SettingStore = {
      readSetting: async (key) => stored.get(key),
      writeSetting: async (key, value) => {
        stored.set(key, value);
      },
    };

    expect(await readExampleViews(settings, [example])).toEqual({ [example.slug]: "2026-11-04T10:00:00Z" });

    stored.set(getExampleViewedSetting(example.id), { viewed: true });

    expect(await readExampleViews(settings, [example])).toEqual({});
  });

  it("should leave the catalog available when visit storage cannot be read", async () => {
    const settings: SettingStore = {
      readSetting: async () => {
        throw new Error("Storage unavailable");
      },
      writeSetting: async () => {},
    };

    expect(await readExampleViews(settings, [findExample("insert-validators")!])).toEqual({});
  });
});
