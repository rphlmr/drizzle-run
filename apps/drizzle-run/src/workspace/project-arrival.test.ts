import { describe, expect, it } from "vitest";

import { getArrivalNotice, readProjectArrival, readProjectIntroState, toArrivalState } from "./project-arrival";

describe("readProjectArrival", () => {
  it("should read the arrival a navigation carries and nothing else", () => {
    expect(readProjectArrival(toArrivalState({ kind: "forked", originalHref: "/examples/joins" }))).toEqual({
      kind: "forked",
      originalHref: "/examples/joins",
    });
    expect(readProjectArrival(null)).toBeNull();
    expect(readProjectArrival({ arrival: { kind: "moved" } })).toBeNull();
  });
});

describe("readProjectIntroState", () => {
  it("should read nothing stored or an unknown value as never shown", () => {
    expect(readProjectIntroState("muted")).toBe("muted");
    expect(readProjectIntroState(undefined)).toBe("unseen");
    expect(readProjectIntroState(true)).toBe("unseen");
  });
});

describe("getArrivalNotice", () => {
  it("should open a new project on the intro until it is muted", () => {
    expect(getArrivalNotice({ kind: "created" }, "unseen")).toBe("intro");
    expect(getArrivalNotice({ kind: "created" }, "seen")).toBe("intro");
    expect(getArrivalNotice({ kind: "created" }, "muted")).toBe("none");
  });

  it("should show the intro instead of the toast on the first Fork only", () => {
    const forked = { kind: "forked", originalHref: "/s/abc" } as const;

    expect(getArrivalNotice(forked, "unseen")).toBe("intro");
    expect(getArrivalNotice(forked, "seen")).toBe("toast");
    expect(getArrivalNotice(forked, "muted")).toBe("toast");
  });

  it("should always show the toast after a Duplicate", () => {
    expect(getArrivalNotice({ kind: "duplicated", originalHref: "/p/1" }, "unseen")).toBe("toast");
  });
});
