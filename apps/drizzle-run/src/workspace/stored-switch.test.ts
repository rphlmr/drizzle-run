import { describe, expect, it } from "vitest";

import { createStoredSwitch } from "./stored-switch";

/** An in-memory Storage, enough for the choice to round-trip. */
function makeStorage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));

  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const formatOnRun = createStoredSwitch({ key: "format-on-run", offValue: "off" });

describe("createStoredSwitch", () => {
  it("should read as on when nothing is stored or there is no storage", () => {
    expect(formatOnRun.read(makeStorage())).toBe(true);
    expect(formatOnRun.read(null)).toBe(true);
  });

  it("should read as on when storage throws", () => {
    expect(
      formatOnRun.read({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(true);
  });

  it("should read only its own off value as off", () => {
    expect(formatOnRun.read(makeStorage({ "format-on-run": "off" }))).toBe(false);
    expect(formatOnRun.read(makeStorage({ "format-on-run": "hidden" }))).toBe(true);
    expect(formatOnRun.read(makeStorage({ "run-notes": "off" }))).toBe(true);
  });

  it("should round-trip turning off and on, storing nothing while on", () => {
    const storage = makeStorage();

    formatOnRun.write(storage, false);
    const off = formatOnRun.read(storage);
    formatOnRun.write(storage, true);

    expect(off).toBe(false);
    expect(formatOnRun.read(storage)).toBe(true);
    expect(storage.items.size).toBe(0);
  });
});
