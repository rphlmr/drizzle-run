import { SERIALIZED_UNDEFINED, serializeError, serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { parseRuntimeWorkerMessage } from "./protocol.ts";

function makeFailedReport(error: unknown) {
  return {
    kind: "report",
    outcome: "failed",
    value: SERIALIZED_UNDEFINED,
    error: { ...serializeError(error), phase: "seed" },
  };
}

describe("parseRuntimeWorkerMessage", () => {
  it("should accept a failed report whose error message is longer than the text limit", () => {
    const error = new Error(`Failed query: insert into "users" values ${"($1, $2), ".repeat(10_000)}`);

    expect(() => parseRuntimeWorkerMessage(makeFailedReport(error))).not.toThrow();
  });

  it("should accept a failed report whose error has more causes than the protocol keeps", () => {
    let error = new Error("leaf");

    for (let index = 0; index < 20; index += 1) {
      error = new Error(`cause ${index}`, { cause: error });
    }

    expect(() => parseRuntimeWorkerMessage(makeFailedReport(error))).not.toThrow();
  });

  it("should accept a result nested past the value depth limit", () => {
    let value: unknown = 1;

    for (let depth = 0; depth < 100; depth += 1) {
      value = [value];
    }

    const report = { kind: "report", outcome: "succeeded", value: serializeValue(value) };

    expect(() => parseRuntimeWorkerMessage(report)).not.toThrow();
  });
});

const queryPlansReport = (queryPlans: unknown) => ({
  kind: "report",
  outcome: "succeeded",
  value: { type: "primitive", value: 1 },
  queryPlans,
});

const logEvent = (frames: unknown) => ({
  kind: "event",
  type: "log",
  payload: { sequence: 1, phase: "run", level: "log", values: [], frames },
});

const transactionsReport = (transactions: unknown) => ({
  kind: "report",
  outcome: "succeeded",
  value: { type: "primitive", value: 1 },
  transactions,
});

const sqlEvent = (commandTags: unknown) => ({
  kind: "event",
  type: "sql",
  payload: {
    sequence: 1,
    phase: "run",
    origin: "drizzle",
    kind: "executed",
    sql: "select 1",
    parameters: [],
    outcome: "succeeded",
    commandTags,
  },
});

const sqlEventWithRowCount = (rowCount: unknown) => {
  const message = sqlEvent(["SELECT"]);

  return { ...message, payload: { ...message.payload, rowCount } };
};

describe("runtime worker protocol", () => {
  it("should accept Postgres command tags on a SQL event and reject anything else", () => {
    expect(() => parseRuntimeWorkerMessage(sqlEvent(["SELECT", "DELETE"]))).not.toThrow();
    expect(() => parseRuntimeWorkerMessage(sqlEvent("SELECT"))).toThrow(/Invalid SQL event command tags/);
    expect(() => parseRuntimeWorkerMessage(sqlEvent(["CREATE TABLE"]))).toThrow(/Invalid SQL event command tags/);
    expect(() => parseRuntimeWorkerMessage(sqlEvent([1]))).toThrow(/Invalid SQL event command tags/);
  });

  it("should accept a SQL event's row count and reject a negative or fractional one", () => {
    expect(parseRuntimeWorkerMessage(sqlEventWithRowCount(2))).toMatchObject({ payload: { rowCount: 2 } });
    expect(() => parseRuntimeWorkerMessage(sqlEventWithRowCount(0))).not.toThrow();
    expect(() => parseRuntimeWorkerMessage(sqlEventWithRowCount(-1))).toThrow(/Invalid SQL row count/);
    expect(() => parseRuntimeWorkerMessage(sqlEventWithRowCount(1.5))).toThrow(/Invalid SQL row count/);
  });

  it("should reject a malformed transaction in the report", () => {
    const transaction = { id: 1, phase: "run", outcome: "committed", statements: [1, 2], durationMs: 1 };

    expect(() => parseRuntimeWorkerMessage(transactionsReport([transaction]))).not.toThrow();
    expect(() => parseRuntimeWorkerMessage(transactionsReport([{ ...transaction, outcome: "lost" }]))).toThrow(
      /Invalid transaction fields/,
    );
    expect(() => parseRuntimeWorkerMessage(transactionsReport([{ ...transaction, statements: [0] }]))).toThrow(
      /Invalid transaction fields/,
    );
    expect(() =>
      parseRuntimeWorkerMessage(
        transactionsReport([{ ...transaction, error: { name: "Error", message: "x", extra: 1 } }]),
      ),
    ).toThrow(/Unexpected execution worker field/);
  });

  it("should accept well-formed call-site frames and reject anything else", () => {
    expect(() => parseRuntimeWorkerMessage(logEvent("12:5 3:1"))).not.toThrow();
    expect(() => parseRuntimeWorkerMessage(logEvent("12:5\nat evil"))).toThrow(/Invalid call site frames/);
    expect(() => parseRuntimeWorkerMessage(logEvent(Array.from({ length: 9 }, () => "1:1").join(" ")))).toThrow(
      /Invalid call site frames/,
    );
    expect(() => parseRuntimeWorkerMessage(logEvent(7))).toThrow(/Invalid call site frames/);
  });

  it("should reject a malformed query plans report", () => {
    expect(() =>
      parseRuntimeWorkerMessage(
        queryPlansReport({
          settings: { size: "1m", measureRealTime: false },
          dialect: "sqlite",
          fills: [],
          queries: [],
          skipped: [],
          durationMs: 1,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseRuntimeWorkerMessage(
        queryPlansReport({
          settings: { size: "2m", measureRealTime: false },
          dialect: "sqlite",
          fills: [],
          queries: [],
          skipped: [],
          durationMs: 1,
        }),
      ),
    ).toThrow(/Invalid query plans report/);
    expect(() =>
      parseRuntimeWorkerMessage(
        queryPlansReport({
          settings: { size: "1m", measureRealTime: false },
          dialect: "sqlite",
          fills: [],
          queries: [{ sql: 1 }],
          skipped: [],
          durationMs: 1,
        }),
      ),
    ).toThrow(/Invalid planned query/);
  });

  it("should reject unknown protocol fields and oversized worker messages", () => {
    expect(() => parseRuntimeWorkerMessage({ kind: "ready", kitLoadMs: 2, extra: true })).toThrow(
      /Unexpected execution worker field/,
    );
    expect(() =>
      parseRuntimeWorkerMessage({
        kind: "console",
        level: "log",
        text: "x".repeat(2 * 1024 * 1024 + 1),
      }),
    ).toThrow(/exceeds 2 MiB/);
  });
});
