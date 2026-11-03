import { EXECUTION_PHASES, type PhaseResult, type RunSnapshot } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  buildPhaseWaterfall,
  buildRawReport,
  collectReportFacts,
  formatBytes,
  getBrowserName,
  getRunLibraries,
  getStateRows,
} from "./run-report";

function toIsoAt(ms: number) {
  return new Date(Date.UTC(2026, 9, 15, 12, 0, 0, ms)).toISOString();
}

function makePhase(
  name: PhaseResult["phase"],
  startMs: number,
  durationMs: number,
  status: PhaseResult["status"] = "succeeded",
): PhaseResult {
  return {
    phase: name,
    status,
    startedAt: toIsoAt(startMs),
    durationMs,
  };
}

describe("buildPhaseWaterfall", () => {
  it("should list the 13 phases of a plain run in run order, each from its own start", () => {
    const waterfall = buildPhaseWaterfall(
      [makePhase("validate", 0, 1), makePhase("compile", 5, 89), makePhase("open_database", 100, 71)],
      { total: 233 },
    );

    expect(EXECUTION_PHASES).toHaveLength(14);
    expect(waterfall.bars.map((bar) => bar.phase)).toEqual(EXECUTION_PHASES.filter((name) => name !== "plan"));
    expect(waterfall.bars.find((bar) => bar.phase === "compile")).toMatchObject({
      startMs: 5,
      durationMs: 89,
      status: "succeeded",
    });
    expect(waterfall.bars.find((bar) => bar.phase === "seed")).toMatchObject({
      status: "not_run",
      durationMs: undefined,
    });
    expect(waterfall.scaleMs).toBe(233);
  });

  it("should show the plan phase between inspect and cleanup only when the run planned its queries", () => {
    const planned = buildPhaseWaterfall(
      [
        makePhase("run", 0, 10),
        makePhase("inspect", 10, 2),
        makePhase("plan", 12, 2800),
        makePhase("cleanup", 2812, 3),
      ],
      { total: 2815 },
    );
    const names = planned.bars.map((bar) => bar.phase);

    expect(names.slice(-3)).toEqual(["inspect", "plan", "cleanup"]);
    expect(planned.bars.find((bar) => bar.phase === "plan")).toMatchObject({
      status: "succeeded",
      durationMs: 2800,
      slow: true,
    });
    expect(buildPhaseWaterfall([makePhase("run", 0, 10)], { total: 10 }).bars.some((bar) => bar.phase === "plan")).toBe(
      false,
    );
  });

  it("should highlight phases that take a fifth of the run and sum their share", () => {
    const waterfall = buildPhaseWaterfall(
      [makePhase("compile", 0, 89), makePhase("evaluate_schema", 89, 9), makePhase("open_database", 98, 71)],
      { total: 175 },
    );

    expect(waterfall.bars.filter((bar) => bar.slow).map((bar) => bar.phase)).toEqual(["compile", "open_database"]);
    expect(waterfall.summary).toBe("compile and open_database take 91%");
    expect(buildPhaseWaterfall([makePhase("compile", 0, 50), makePhase("run", 50, 40)], { total: 100 }).summary).toBe(
      "compile and run take 90%",
    );
    const even = EXECUTION_PHASES.slice(0, 10).map((name, index) => makePhase(name, index * 2, 2));

    expect(buildPhaseWaterfall(even, { total: 20 }).summary).toBeUndefined();
  });

  it("should name the time spent between phases when it is a large share of the run", () => {
    const phases = [makePhase("load_artifacts", 0, 0), makePhase("compile", 250, 3), makePhase("run", 260, 3)];
    const waterfall = buildPhaseWaterfall(phases, { total: 401 });

    expect(waterfall.summary).toBe("395 ms between phases");
    expect(buildPhaseWaterfall([makePhase("compile", 0, 50)], { total: 100 }).summary).toBe(
      "compile takes 50% · 50 ms between phases",
    );
  });

  it("should place a phase without a start after the one before, and read its time from the timings", () => {
    const waterfall = buildPhaseWaterfall([makePhase("validate", 0, 4), { phase: "resolve", status: "succeeded" }], {
      resolve: 6,
      total: 10,
    });

    expect(waterfall.bars[1]).toMatchObject({ phase: "resolve", startMs: 4, durationMs: 6 });
  });

  it("should mark round times on the axis: 0, 100 ms, 200 ms for a 233 ms run", () => {
    const { ticks } = buildPhaseWaterfall([], { total: 233 });

    expect(ticks.map((tick) => tick.label)).toEqual(["0", "100 ms", "200 ms"]);
    expect(ticks[1]?.percent).toBeCloseTo(42.9, 1);
    expect(buildPhaseWaterfall([], { total: 4200 }).ticks.map((tick) => tick.label)).toEqual(["0", "2 s", "4 s"]);
  });
});

const makeRunSnapshot = (state: string, elapsedMs: number, phaseName?: RunSnapshot["phase"]): RunSnapshot => ({
  state,
  status: state === "succeeded" ? "done" : "active",
  sequence: 1,
  elapsedMs,
  ...(phaseName ? { phase: phaseName } : {}),
});

describe("getStateRows", () => {
  it("should keep the snapshots where the state or the phase changed, with their place in the stream", () => {
    const rows = getStateRows([
      makeRunSnapshot("idle", 0),
      makeRunSnapshot("starting", 1),
      makeRunSnapshot("starting", 1),
      makeRunSnapshot("running", 4, "compile"),
      makeRunSnapshot("running", 30, "compile"),
      makeRunSnapshot("running", 96, "seed"),
      makeRunSnapshot("succeeded", 233),
    ]);

    expect(rows.map((row) => [row.index, row.state, row.phase])).toEqual([
      [0, "idle", undefined],
      [1, "starting", undefined],
      [3, "running", "compile"],
      [5, "running", "seed"],
      [6, "succeeded", undefined],
    ]);
    expect(rows.at(-1)?.atMs).toBe(233);
  });
});

describe("getBrowserName", () => {
  it("should name the browser and its major version", () => {
    expect(
      getBrowserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 141");
    expect(
      getBrowserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("Edge 141");
    expect(getBrowserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0")).toBe(
      "Firefox 144",
    );
    expect(
      getBrowserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      ),
    ).toBe("Safari 26.0");
    expect(getBrowserName("curl/8.0")).toBe("Unknown browser");
  });
});

describe("formatBytes", () => {
  it("should write bytes, then kilobytes, then megabytes", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(48 * 1024 + 100)).toBe("48 KB");
    expect(formatBytes(1.25 * 1024 * 1024)).toBe("1.3 MB");
  });
});

const factValue = (facts: ReturnType<typeof collectReportFacts>, label: string) =>
  facts.find((fact) => fact.label === label)?.value;

describe("collectReportFacts", () => {
  const manifest = {
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
  } as const;
  const tuple = {
    id: "pg",
    target: { dialect: "sqlite" },
    ormVersion: "1.0.0-rc.6",
    kitVersion: "1.0.0-rc.6",
  } as const;
  const cleanup = { guest: { mode: "graceful" }, database: { mode: "graceful" } } as const;

  it("should read the pair and database from the run, and say what the run left behind", () => {
    const facts = collectReportFacts({
      result: { tuple, cleanup, cleanupErrors: [] },
      manifest,
      events: 142,
      userAgent: "Firefox/144.0",
      isolated: true,
    });

    expect(facts.map((fact) => fact.label)).toEqual([
      "Release pair",
      "Database",
      "Guest",
      "Browser",
      "Events",
      "Runtime issues",
      "Libraries",
    ]);
    expect(factValue(facts, "Release pair")).toBe("orm 1.0.0-rc.6 · kit 1.0.0-rc.6");
    expect(factValue(facts, "Libraries")).toBe("unknown");
    expect(factValue(facts, "Database")).toBe("SQLite WASM · SQLite");
    expect(factValue(facts, "Guest")).toBe("fresh · QuickJS");
    expect(factValue(facts, "Browser")).toBe("Firefox 144 · isolated");
    expect(factValue(facts, "Events")).toBe("142 kept");
    expect(factValue(facts, "Runtime issues")).toBe("none");
  });

  it("should fall back to the submitted manifest while running, and list cleanup problems", () => {
    const running = collectReportFacts({ result: undefined, manifest, events: 3, userAgent: "", isolated: false });

    expect(factValue(running, "Release pair")).toBe("orm 0.45.4 · kit 0.31.11");
    expect(factValue(running, "Libraries")).toBe(
      "@sinclair/typebox 0.34.52 · arktype 2.2.3 · drizzle-arktype 0.1.3 · drizzle-seed 0.3.1 · drizzle-typebox 0.3.3 · drizzle-valibot 0.4.2 · drizzle-zod 0.8.3 · valibot 1.4.2 · zod 4.4.3",
    );
    expect(factValue(running, "Database")).toBe("PGlite · PostgreSQL");
    expect(factValue(running, "Runtime issues")).toBe("still running");

    const forced = collectReportFacts({
      result: {
        tuple,
        cleanup: { guest: { mode: "forced" }, database: { mode: "graceful" } },
        cleanupErrors: [{ name: "Error", message: "socket" }],
      },
      manifest,
      events: 0,
      userAgent: "",
      isolated: false,
    });

    expect(factValue(forced, "Runtime issues")).toBe("1 cleanup error · guest stopped by force");
  });

  it("should name a database closed because query planning ran out of time", () => {
    const abandoned = collectReportFacts({
      result: {
        tuple,
        cleanup: { guest: { mode: "graceful" }, database: { mode: "forced", reason: "planning_abandoned" } },
        cleanupErrors: [],
      },
      manifest,
      events: 0,
      userAgent: "",
      isolated: false,
    });

    expect(factValue(abandoned, "Runtime issues")).toBe("database closed after query planning ran out of time");
  });
});

describe("buildRawReport", () => {
  it("should open the JSON with the libraries the run's guest ships, Effect included on the effect guest", () => {
    const manifest = {
      target: { dialect: "postgresql" },
      dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
      guestFlavor: "effect",
    } as const;

    const raw = buildRawReport({
      states: [],
      events: [],
      result: undefined,
      libraries: getRunLibraries({ result: undefined, manifest }),
    });

    expect(Object.keys(raw)[0]).toBe("libraries");
    expect(raw.libraries).toMatchObject({ effect: "4.0.5", "@effect/sql-pg": "4.0.5", zod: "4.4.3" });
    expect(raw.libraries).not.toHaveProperty("drizzle-orm");
  });
});
