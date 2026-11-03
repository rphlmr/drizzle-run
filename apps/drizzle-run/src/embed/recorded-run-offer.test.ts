import {
  digestPlaygroundSnapshot,
  MAX_RECORDED_RUN_BYTES,
  parsePlaygroundSnapshot,
  toRecordedGuest,
  type PlaygroundSnapshot,
  type RunResult,
} from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { pairSide } from "@drizzle-run/core/pair";
import type { RunRecord } from "@drizzle-run/orchestration";
import { fakeRunResult } from "@drizzle-run/test-fixtures";
import { describe, expect, it } from "vitest";

import { createProject } from "../project/projects";
import { resolveRecordingOffer } from "./recorded-run-offer";

function makeOneVersionSnapshot(): PlaygroundSnapshot {
  const project = createProject("Recorded", { dialect: "sqlite" });
  return parsePlaygroundSnapshot({ snapshotVersion: 1, name: project.name, manifest: project.manifest });
}

function makePairSnapshot(): PlaygroundSnapshot {
  return parsePlaygroundSnapshot({
    snapshotVersion: 1,
    name: "Pair",
    manifest: {
      kind: "drizzle-run-pair",
      manifestVersion: 1,
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
      files: { "seed.ts": "export {};\n" },
      sides: [
        {
          target: { dialect: "postgresql" },
          dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
          files: { "schema.ts": "export {};\n", "query.ts": "// 0.45\n" },
        },
        {
          target: { dialect: "postgresql" },
          dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
          files: { "schema.ts": "export {};\n", "query.ts": "// rc.5\n" },
        },
      ],
    },
  });
}

function makeResult({
  outcome = "succeeded",
  label = "Users",
}: {
  outcome?: "succeeded" | "failed";
  label?: string;
} = {}): RunResult {
  return fakeRunResult(outcome, {
    target: { dialect: "sqlite" },
    displays: [{ label, values: [] }],
    message: "Boom",
    timings: { total: 120 },
  });
}

function makeRun({
  manifest,
  result = makeResult(),
  settledAt = Date.UTC(2026, 9, 17, 10),
}: {
  manifest: RunManifest;
  result?: RunResult;
  settledAt?: number;
}): RunRecord {
  return {
    number: 1,
    settledAt,
    submission: { manifest, revision: 1, debug: false },
    result,
    error: "",
    durationMs: 120,
    progress: "succeeded",
    states: [],
    events: [],
  };
}

describe("resolveRecordingOffer", () => {
  it("should offer a succeeded run of exactly the snapshot's code", () => {
    const snapshot = makeOneVersionSnapshot();
    const manifest = snapshot.manifest as RunManifest;

    const offer = resolveRecordingOffer({ snapshot, latestRuns: [makeRun({ manifest: structuredClone(manifest) })] });

    expect(offer.status).toBe("offered");
    expect(offer.status === "offered" && offer.recording).toMatchObject({
      snapshotDigest: digestPlaygroundSnapshot(snapshot),
      recordedAt: "2026-10-17T10:00:00.000Z",
      result: { displays: [{ label: "Users" }] },
      guests: [toRecordedGuest(manifest)],
    });
  });

  it("should offer nothing for a run of edited code, a failed run, or no run", () => {
    const snapshot = makeOneVersionSnapshot();
    const manifest = snapshot.manifest as RunManifest;
    const edited = { ...manifest, files: { ...manifest.files, "query.ts": "// edited\n" } };

    expect(resolveRecordingOffer({ snapshot, latestRuns: [makeRun({ manifest: edited })] })).toEqual({
      status: "none",
    });
    expect(
      resolveRecordingOffer({
        snapshot,
        latestRuns: [makeRun({ manifest, result: makeResult({ outcome: "failed" }) })],
      }),
    ).toEqual({ status: "none" });
    expect(resolveRecordingOffer({ snapshot, latestRuns: [{ ...makeRun({ manifest }), result: undefined }] })).toEqual({
      status: "none",
    });
    expect(resolveRecordingOffer({ snapshot, latestRuns: [undefined] })).toEqual({ status: "none" });
  });

  it("should report a run too large to record", () => {
    const snapshot = makeOneVersionSnapshot();
    const result = makeResult({ label: "x".repeat(MAX_RECORDED_RUN_BYTES) });

    const offer = resolveRecordingOffer({
      snapshot,
      latestRuns: [makeRun({ manifest: snapshot.manifest as RunManifest, result })],
    });

    expect(offer).toEqual({ status: "too_large", maxBytes: MAX_RECORDED_RUN_BYTES });
  });

  it("should offer both sides of a pair only when each side ran its own current code", () => {
    const snapshot = makePairSnapshot();

    if (snapshot.manifest.kind !== "drizzle-run-pair") {
      throw new Error("Expected a pair snapshot.");
    }

    const sides = [pairSide(snapshot.manifest, 0), pairSide(snapshot.manifest, 1)] as const;
    const both = resolveRecordingOffer({
      snapshot,
      latestRuns: [
        makeRun({ manifest: sides[0], result: makeResult({ label: "0.45" }) }),
        makeRun({ manifest: sides[1], result: makeResult({ label: "rc.5" }), settledAt: Date.UTC(2026, 9, 17, 11) }),
      ],
    });
    const swapped = resolveRecordingOffer({
      snapshot,
      latestRuns: [makeRun({ manifest: sides[1] }), makeRun({ manifest: sides[0] })],
    });
    const oneSide = resolveRecordingOffer({ snapshot, latestRuns: [makeRun({ manifest: sides[0] }), undefined] });

    expect(both.status === "offered" && both.recording.sides?.map((side) => side.displays[0]?.label)).toEqual([
      "0.45",
      "rc.5",
    ]);
    expect(both.status === "offered" && both.recording.recordedAt).toBe("2026-10-17T11:00:00.000Z");
    expect(both.status === "offered" && both.recording.guests).toEqual(sides.map((side) => toRecordedGuest(side)));
    expect(swapped).toEqual({ status: "none" });
    expect(oneSide).toEqual({ status: "none" });
  });
});
