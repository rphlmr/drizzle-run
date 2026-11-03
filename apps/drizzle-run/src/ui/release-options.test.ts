import { listSupportedTuples, type SupportedRuntimeTuple } from "@drizzle-run/core/catalog";
import { describe, expect, it } from "vitest";

import {
  buildReleaseOptions,
  describeBlockedRelease,
  getNewProjectRelease,
  getReleaseChoiceName,
  getReleaseCurrent,
  getReleaseTriggerLabel,
  toReleaseChoiceKey,
} from "./release-options";

const target = { dialect: "sqlite" as const };
const catalog = listSupportedTuples(target);
const base = catalog[0];

if (!base) {
  throw new Error("The catalog has no SQLite pair.");
}

function makePair(
  line: SupportedRuntimeTuple["releaseLine"],
  ormVersion: string,
  kitVersion: string,
): SupportedRuntimeTuple {
  return {
    ...base,
    id: `${line}-${ormVersion}` as SupportedRuntimeTuple["id"],
    releaseLine: line,
    ormVersion: ormVersion as SupportedRuntimeTuple["ormVersion"],
    kitVersion: kitVersion as SupportedRuntimeTuple["kitVersion"],
    recommended: false,
  };
}

const pairs = [
  makePair("legacy", "0.44.0", "0.30.0"),
  makePair("next", "1.0.0-rc.5", "1.0.0-rc.5"),
  makePair("legacy", "0.45.4", "0.31.11"),
  makePair("next", "1.0.0-rc.6", "1.0.0-rc.6"),
];

describe("buildReleaseOptions", () => {
  it("should mark exactly one newest pair per line, Next first", () => {
    const options = buildReleaseOptions(target, { ormVersion: "0.45.4", kitVersion: "0.31.11" }, pairs);
    const all = [...options.lines, ...options.others];

    expect(options.lines.map((option) => [option.line, option.ormVersion])).toEqual([
      ["next", "1.0.0-rc.6"],
      ["legacy", "0.45.4"],
    ]);
    expect(all.filter((option) => option.newest && option.line === "next")).toHaveLength(1);
    expect(all.filter((option) => option.newest && option.line === "legacy")).toHaveLength(1);
    expect(options.others.map((option) => [option.ormVersion, option.guestFlavor])).toEqual([
      ["1.0.0-rc.5", "slim"],
      ["1.0.0-rc.5", "effect"],
      ["0.44.0", "slim"],
    ]);
  });

  it("should badge only the newest pair of the first line", () => {
    const options = buildReleaseOptions(target, { ormVersion: "0.45.4", kitVersion: "0.31.11" }, pairs);

    expect(
      [...options.lines, ...options.others].filter((option) => option.badge).map((option) => option.ormVersion),
    ).toEqual(["1.0.0-rc.6"]);
  });

  it("should start a new project on the newest RC, or the first line without one", () => {
    expect(
      getNewProjectRelease(buildReleaseOptions(target, { ormVersion: "0.45.4", kitVersion: "0.31.11" }, pairs))
        ?.ormVersion,
    ).toBe("1.0.0-rc.6");

    const legacyOnly = pairs.filter((item) => item.releaseLine === "legacy");

    expect(
      getNewProjectRelease(buildReleaseOptions(target, { ormVersion: "0.45.4", kitVersion: "0.31.11" }, legacyOnly))
        ?.ormVersion,
    ).toBe("0.45.4");
  });

  it("should return the current pair when the catalog has it", () => {
    const options = buildReleaseOptions(target, { ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" }, pairs);

    expect(options.current).toMatchObject({ line: "next", ormVersion: "1.0.0-rc.5", newest: false });
  });

  it("should suggest the closest pair of the same line for an unknown pair", () => {
    const suggested = (ormVersion: string, releaseCatalog = pairs) => {
      const { current } = buildReleaseOptions(target, { ormVersion, kitVersion: ormVersion }, releaseCatalog);

      return "unavailable" in current ? current.suggested.ormVersion : undefined;
    };

    expect(suggested("1.0.0-rc.3")).toBe("1.0.0-rc.5");
    expect(suggested("0.43.0")).toBe("0.44.0");
    expect(suggested("0.44.5")).toBe("0.45.4");
    expect(suggested("0.46.0")).toBe("0.45.4");
    expect(
      suggested(
        "1.0.0-rc.3",
        pairs.filter((item) => item.releaseLine === "legacy"),
      ),
    ).toBe("0.45.4");
  });

  it("should follow each pair that ships an effect guest with its Effect option, never badged Newest", () => {
    const options = buildReleaseOptions(target, { ormVersion: "1.0.0-rc.5", kitVersion: "1.0.0-rc.5" });
    const [plain, effect, legacy] = options.lines;

    expect(options.lines.map((option) => [option.ormVersion, option.guestFlavor])).toEqual([
      ["1.0.0-rc.5", "slim"],
      ["1.0.0-rc.5", "effect"],
      ["0.45.4", "slim"],
    ]);
    expect([plain?.badge, effect?.badge, legacy?.badge]).toEqual([true, false, false]);
    expect(effect && toReleaseChoiceKey(effect)).toBe(`${plain?.tupleId}+effect`);
  });

  it("should select the Effect option for a manifest on the effect flavor, and the plain pair otherwise", () => {
    const dependencies = { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" };

    expect(buildReleaseOptions(target, getReleaseCurrent({ dependencies })).current).toMatchObject({
      guestFlavor: "slim",
    });
    expect(
      buildReleaseOptions(target, getReleaseCurrent({ dependencies, guestFlavor: "effect" })).current,
    ).toMatchObject({
      guestFlavor: "effect",
      ormVersion: "1.0.0-rc.5",
    });
  });

  it("should suggest a plain pair when an Effect project's pair is gone", () => {
    const { current } = buildReleaseOptions(target, {
      ormVersion: "1.0.0-rc.3",
      kitVersion: "1.0.0-rc.3",
      guestFlavor: "effect",
    });

    expect(current).toMatchObject({ unavailable: true, suggested: { ormVersion: "1.0.0-rc.5", guestFlavor: "slim" } });
  });

  it("should read the real catalog by default", () => {
    const options = buildReleaseOptions(target, base);

    expect(options.current).toMatchObject({ tupleId: base.id });
  });
});

describe("getReleaseTriggerLabel", () => {
  it("should name the control and its pair", () => {
    const { current } = buildReleaseOptions(target, base);

    expect(getReleaseTriggerLabel(current)).toEqual({
      text: `orm ${base.ormVersion} · kit ${base.kitVersion}`,
      accessibleName: `Drizzle version: orm ${base.ormVersion} · kit ${base.kitVersion}`,
    });
  });

  it("should add Effect to the chip and its name when the Effect option is current", () => {
    const { current } = buildReleaseOptions(target, {
      ormVersion: "1.0.0-rc.5",
      kitVersion: "1.0.0-rc.5",
      guestFlavor: "effect",
    });

    expect(getReleaseTriggerLabel(current)).toEqual({
      text: "orm 1.0.0-rc.5 · kit 1.0.0-rc.5 + Effect",
      accessibleName: "Drizzle version: orm 1.0.0-rc.5 · kit 1.0.0-rc.5, with Effect 4",
    });
  });

  it("should say in words when the pair is unavailable", () => {
    const { current } = buildReleaseOptions(target, { ormVersion: "0.1.0", kitVersion: "0.1.0" });

    expect(getReleaseTriggerLabel(current)).toEqual({
      text: "orm 0.1.0 · kit 0.1.0 · Unavailable",
      accessibleName: "Drizzle version: orm 0.1.0 · kit 0.1.0, unavailable",
    });
  });
});

describe("getReleaseChoiceName", () => {
  it("should read as words, with the Newest badge when the card shows it", () => {
    const option = {
      tupleId: base.id,
      guestFlavor: "slim" as const,
      line: "next" as const,
      ormVersion: "1.0.0-rc.5" as const,
      kitVersion: "1.0.0-rc.5" as const,
      newest: true,
      badge: true,
    };

    expect(getReleaseChoiceName(option)).toBe("RC, newest, orm 1.0.0-rc.5 · kit 1.0.0-rc.5");
    expect(
      getReleaseChoiceName({ ...option, line: "legacy", ormVersion: "0.45.4", kitVersion: "0.31.11", badge: false }),
    ).toBe("Legacy, orm 0.45.4 · kit 0.31.11");
    expect(getReleaseChoiceName({ ...option, guestFlavor: "effect", badge: false })).toBe(
      "RC, orm 1.0.0-rc.5 · kit 1.0.0-rc.5, with Effect 4",
    );
  });
});

describe("describeBlockedRelease", () => {
  const next = catalog.find((tuple) => tuple.releaseLine === "next");
  const legacy = catalog.find((tuple) => tuple.releaseLine === "legacy");

  if (!next || !legacy) {
    throw new Error("Expected a Legacy and a Next SQLite pair.");
  }

  it("should name the imports a guest cannot serve, with the pair and flavor", () => {
    expect(describeBlockedRelease(next, "slim", ["drizzle-orm", "effect"])).toBe(
      `effect is not available with orm ${next.ormVersion} · kit ${next.kitVersion}. Pick another release.`,
    );
    expect(describeBlockedRelease(next, "effect", ["drizzle-zod"])).toBe(
      `drizzle-zod is not available with orm ${next.ormVersion} · kit ${next.kitVersion} with Effect. Pick another release.`,
    );
  });

  it("should return undefined when the guest serves every import", () => {
    expect(describeBlockedRelease(legacy, "slim", ["drizzle-orm", "drizzle-zod", "zod"])).toBeUndefined();
    expect(describeBlockedRelease(next, "effect", ["effect", "drizzle-orm/effect-libsql"])).toBeUndefined();
    expect(describeBlockedRelease(next, "slim", [])).toBeUndefined();
  });
});
