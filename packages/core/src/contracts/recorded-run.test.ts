import { describe, expect, it } from "vitest";

import { getGuestLockDigest } from "../registry/guest-images.ts";
import { RELEASE_PAIRS } from "../releases/catalog.ts";
import {
  createRecordedRun,
  findReplacedGuest,
  MAX_RECORDED_RUN_BYTES,
  parseRecordedRun,
  RecordedRunValidationError,
  safeParseRecordedRun,
  toRecordedGuest,
  type RecordedGuest,
} from "./recorded-run.ts";
import type { RunResult } from "./runtime.ts";

const digest = "a".repeat(64);
const nextPair = Object.values(RELEASE_PAIRS).find((pair) => pair.releaseLine === "next");

if (nextPair === undefined) {
  throw new Error("Expected the catalog to ship a Next pair");
}

const nextDependencies = { "drizzle-orm": nextPair.ormVersion, "drizzle-kit": nextPair.kitVersion };

/** The slim Next guest, as the catalog ships it. */
function makeGuest(): RecordedGuest {
  const guest = toRecordedGuest({ dependencies: nextDependencies });

  if (guest === null) {
    throw new Error("Expected the catalog to ship the slim Next guest");
  }

  return guest;
}

/** A succeeded run with one query, one console line and one display, like the starter project. */
function makeRunResult({
  outcome = "succeeded",
  rows = 2,
}: { outcome?: RunResult["outcome"]; rows?: number } = {}): RunResult {
  const users = Array.from({ length: rows }, (_, index) => ({
    type: "object" as const,
    value: {
      id: { type: "primitive" as const, value: index + 1 },
      name: { type: "primitive" as const, value: `User ${index + 1}` },
      createdAt: { type: "date" as const, value: "2026-10-17T10:00:00.000Z" },
    },
  }));
  const sql = {
    sequence: 1,
    phase: "run" as const,
    origin: "drizzle" as const,
    kind: "executed" as const,
    sql: 'select "id", "name" from "users"',
    parameters: [],
    source: "query.ts",
    line: 3,
    durationMs: 1.2,
    rowCount: 2,
    outcome: "succeeded" as const,
  };
  const log = {
    sequence: 2,
    phase: "run" as const,
    level: "log" as const,
    values: [{ type: "primitive" as const, value: "done" }],
  };
  const display = { label: "Users", values: [{ type: "array" as const, value: users }], source: "query.ts", line: 4 };
  const evidence = {
    version: 1 as const,
    target: { dialect: "postgresql" as const },
    tuple: { id: "legacy", target: { dialect: "postgresql" as const }, ormVersion: "0.45.4", kitVersion: "0.31.11" },
    random: {
      effectiveSeed: 7,
      source: "derived" as const,
      derivation: "run-manifest-sha256-u32-v1" as const,
      generator: "mulberry32-v1" as const,
    },
    phases: [
      { phase: "run" as const, status: "succeeded" as const, startedAt: "2026-10-17T10:00:00.000Z", durationMs: 4 },
    ],
    diagnostics: [{ severity: "warning" as const, message: "Unused import", line: 1, column: 1 }],
    sql: [sql],
    logs: [log],
    value: { type: "undefined" as const },
    displays: [display],
    events: [
      { type: "sql" as const, sequence: 1, payload: sql },
      { type: "log" as const, sequence: 2, payload: log },
      { type: "display" as const, sequence: 3, payload: display },
    ],
    database: { dialect: "postgresql" as const, schemas: [] },
    cleanupErrors: [],
    cleanup: { guest: { mode: "graceful" as const }, database: { mode: "graceful" as const } },
    timings: { run: 4, total: 180 },
  };

  switch (outcome) {
    case "succeeded":
      return { ...evidence, ok: true, outcome };

    case "failed":
      return { ...evidence, ok: false, outcome, error: { name: "Error", phase: "run", message: "Boom" } };

    case "cancelled":
      return { ...evidence, ok: false, outcome };
  }
}

function makeRecording(options: { rows?: number } = {}) {
  const created = createRecordedRun({
    result: makeRunResult(options),
    guests: [makeGuest()],
    snapshotDigest: digest,
    recordedAt: "2026-10-17T10:00:01.000Z",
  });

  if (created.status !== "recorded") {
    throw new Error(`Expected a recording, but got '${created.status}'`);
  }

  return created.recording;
}

describe("createRecordedRun", () => {
  it("should keep a succeeded run without its database description and query plans", () => {
    const recording = makeRecording();

    expect(recording.recordingVersion).toBe(1);
    expect(recording.snapshotDigest).toBe(digest);
    expect(recording.result?.displays[0]?.label).toBe("Users");
    expect(recording.result).not.toHaveProperty("database");
    expect(recording.result).not.toHaveProperty("queryPlans");
  });

  it("should not record a failed or cancelled run", () => {
    for (const outcome of ["failed", "cancelled"] as const) {
      const created = createRecordedRun({
        result: makeRunResult({ outcome }),
        guests: [makeGuest()],
        snapshotDigest: digest,
        recordedAt: "2026-10-17T10:00:01.000Z",
      });

      expect(created.status).toBe("unrecordable");
    }
  });

  it("should report a run whose output passes the size cap", () => {
    const created = createRecordedRun({
      result: makeRunResult({ rows: 5_000 }),
      guests: [makeGuest()],
      snapshotDigest: digest,
      recordedAt: "2026-10-17T10:00:01.000Z",
    });

    expect(created).toEqual({ status: "too_large", maxBytes: MAX_RECORDED_RUN_BYTES });
  });
});

describe("createRecordedRun for side by side", () => {
  it("should record both sides in side order", () => {
    const created = createRecordedRun({
      sides: [makeRunResult({ rows: 1 }), makeRunResult({ rows: 3 })],
      guests: [makeGuest(), makeGuest()],
      snapshotDigest: digest,
      recordedAt: "2026-10-17T10:00:01.000Z",
    });

    expect(created.status).toBe("recorded");
    expect(created.status === "recorded" && created.recording.sides?.map((side) => side.displays.length)).toEqual([
      1, 1,
    ]);
    expect(created.status === "recorded" && created.recording).not.toHaveProperty("result");
    expect(created.status === "recorded" && created.recording.guests).toHaveLength(2);
  });

  it("should not record a pair when one side failed", () => {
    const created = createRecordedRun({
      sides: [makeRunResult(), makeRunResult({ outcome: "failed" })],
      guests: [makeGuest(), makeGuest()],
      snapshotDigest: digest,
      recordedAt: "2026-10-17T10:00:01.000Z",
    });

    expect(created.status).toBe("unrecordable");
  });
});

describe("safeParseRecordedRun", () => {
  it("should accept a recording after a JSON round trip and return a detached copy", () => {
    const input: unknown = JSON.parse(JSON.stringify(makeRecording()));

    const result = safeParseRecordedRun(input);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(input);
    expect(result.success && result.data).not.toBe(input);
  });

  it("should reject a newer recording version as unsupported", () => {
    const result = safeParseRecordedRun({ ...makeRecording(), recordingVersion: 2 });

    expect(result).toEqual({
      success: false,
      issues: [{ path: ["recordingVersion"], code: "UNSUPPORTED_VERSION", message: "Expected recording version 1." }],
    });
  });

  it("should reject unknown fields, a failed outcome and a malformed digest with their paths", () => {
    const recording = makeRecording();
    const input = {
      ...recording,
      snapshotDigest: "not-a-digest",
      extra: true,
      result: { ...recording.result, ok: false, outcome: "failed", queryPlans: {} },
    };

    const result = safeParseRecordedRun(input);

    expect(result.success).toBe(false);
    expect(!result.success && result.issues.map((issue) => [issue.path.join("."), issue.code])).toEqual(
      expect.arrayContaining([
        ["extra", "UNKNOWN_FIELD"],
        ["snapshotDigest", "INVALID_VALUE"],
        ["result.queryPlans", "UNKNOWN_FIELD"],
        ["result.ok", "INVALID_VALUE"],
        ["result.outcome", "INVALID_VALUE"],
      ]),
    );
  });

  it("should keep a run's transactions and reject one with an unknown outcome", () => {
    const recording = makeRecording();
    const transaction = {
      id: 1,
      phase: "run",
      source: "query.ts",
      line: 3,
      outcome: "rolled_back",
      reason: "rollback_call",
      error: { name: "TransactionRollbackError", message: "Rollback", source: "query.ts", line: 5 },
      writes: "undone",
      statements: [{ sequence: 1, role: "write" }],
      durationMs: 2,
    };
    const valid = { ...recording, result: { ...recording.result, transactions: [transaction] } };
    const invalid = {
      ...recording,
      result: { ...recording.result, transactions: [{ ...transaction, outcome: "lost" }] },
    };

    const accepted = safeParseRecordedRun(JSON.parse(JSON.stringify(valid)));
    const rejected = safeParseRecordedRun(invalid);

    expect(accepted.success && accepted.data.result?.transactions).toEqual([transaction]);
    expect(!rejected.success && rejected.issues.map((issue) => [issue.path.join("."), issue.code])).toEqual([
      ["result.transactions.0.outcome", "INVALID_VALUE"],
    ]);
  });

  it("should reject a malformed serialized value deep inside a display", () => {
    const recording = makeRecording();
    const display = recording.result?.displays[0];
    const input = {
      ...recording,
      result: { ...recording.result, displays: [{ ...display, values: [{ type: "function", value: "x" }] }] },
    };

    const result = safeParseRecordedRun(input);

    expect(!result.success && result.issues[0]?.path).toEqual(["result", "displays", 0, "values", 0, "type"]);
  });

  it("should reject values nested past the depth limit", () => {
    let value: unknown = { type: "primitive", value: 1 };

    for (let depth = 0; depth < 200; depth += 1) {
      value = { type: "array", value: [value] };
    }

    const recording = makeRecording();
    const result = safeParseRecordedRun({ ...recording, result: { ...recording.result, value } });

    expect(!result.success && result.issues[0]?.message).toBe("Values nest at most 64 levels.");
  });

  it("should need exactly one of result and two sides", () => {
    const { result, ...envelope } = makeRecording();

    expect(safeParseRecordedRun(envelope).success).toBe(false);
    expect(safeParseRecordedRun({ ...envelope, result, sides: [result, result] }).success).toBe(false);
    expect(safeParseRecordedRun({ ...envelope, sides: [result] }).success).toBe(false);
    expect(safeParseRecordedRun({ ...envelope, sides: [result, result] }).success).toBe(false);
    expect(
      safeParseRecordedRun({ ...envelope, sides: [result, result], guests: [makeGuest(), makeGuest()] }).success,
    ).toBe(true);
  });

  it("should reject anything that is not a plain object", () => {
    for (const input of [null, [], "recording", 1]) {
      expect(safeParseRecordedRun(input).success).toBe(false);
    }
  });
});

describe("parseRecordedRun", () => {
  it("should throw every issue as a RecordedRunValidationError", () => {
    expect(() => parseRecordedRun({})).toThrow(RecordedRunValidationError);
  });
});

describe("recorded guests", () => {
  it("should record the guest a manifest runs on, with its catalog lock digest", () => {
    const guest = makeGuest();

    expect(guest.imageId).toBe(`orm-${nextPair.ormVersion}__kit-${nextPair.kitVersion}`);
    expect(guest.lockDigest).toBe(getGuestLockDigest(guest.imageId));
    expect(toRecordedGuest({ dependencies: nextDependencies, guestFlavor: "effect" })?.imageId).toBe(
      `${guest.imageId}+effect`,
    );
  });

  it("should reject a recording without the guest of each run", () => {
    const { guests: _guests, ...withoutGuests } = makeRecording();

    expect(safeParseRecordedRun(withoutGuests)).toMatchObject({
      success: false,
      issues: [{ path: ["guests"], code: "INVALID_TYPE", message: "Missing field: guests." }],
    });
    expect(safeParseRecordedRun({ ...makeRecording(), guests: [makeGuest(), makeGuest()] })).toMatchObject({
      success: false,
      issues: [{ path: ["guests"], code: "INVALID_VALUE", message: "Expected the guest of each run, 1, but got 2." }],
    });
  });

  it("should find a guest the catalog refreshed or no longer ships", () => {
    const recording = makeRecording();
    const refreshed = { imageId: recording.guests[0].imageId, lockDigest: `sha256-${"0".repeat(64)}` };
    const removed = { imageId: "orm-0.0.1__kit-0.0.1", lockDigest: recording.guests[0].lockDigest };

    expect(findReplacedGuest(recording)).toBeNull();
    expect(findReplacedGuest({ guests: [refreshed] })).toEqual(refreshed);
    expect(findReplacedGuest({ guests: [recording.guests[0], removed] })).toEqual(removed);
  });
});
