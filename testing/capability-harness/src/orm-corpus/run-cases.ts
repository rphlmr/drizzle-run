import type { OrmCase, OrmCaseResult } from "./types.ts";

const rollbackSignal = new Error("orm corpus rollback");

/**
 * Run work in a transaction and roll it back
 *
 * Write scenarios leave the shared tables as the baseline seeded them, so every later scenario sees the same rows.
 * `transaction` is the database's own transaction method, bound by the caller.
 */
export async function runRolledBack<TTransaction, TValue>(
  transaction: (body: (tx: TTransaction) => Promise<void>) => Promise<unknown>,
  work: (tx: TTransaction) => Promise<TValue>,
): Promise<TValue> {
  const settled: { result?: { value: TValue } } = {};

  try {
    await transaction(async (tx) => {
      settled.result = { value: await work(tx) };
      throw rollbackSignal;
    });
  } catch (cause) {
    if (cause !== rollbackSignal || settled.result === undefined) {
      throw cause;
    }
  }

  if (settled.result === undefined) {
    throw new Error("The transaction finished without running its work");
  }

  return settled.result.value;
}

/**
 * Describe an error by the fields both engines agree on
 *
 * Stacks are engine positions, so only the name, message, database codes, and cause chain are kept.
 */
export function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return { thrown: toComparable(error) };
  }

  const code = "code" in error ? error.code : undefined;
  const extendedCode = "extendedCode" in error ? error.extendedCode : undefined;
  const rawCode = "rawCode" in error ? error.rawCode : undefined;
  const codeText = typeof code === "string" || typeof code === "number" ? String(code) : JSON.stringify(code);

  return {
    name: error.name,
    message: error.message,
    ...(code === undefined ? {} : { code: codeText }),
    ...(extendedCode === undefined ? {} : { extendedCode: toComparable(extendedCode) }),
    ...(rawCode === undefined ? {} : { rawCode: toComparable(rawCode) }),
    ...(error.cause === undefined ? {} : { cause: describeError(error.cause) }),
  };
}

/**
 * Convert a result to plain JSON data
 *
 * Dates, bigints, bytes, and undefined get tagged forms so they compare exactly instead of collapsing in JSON.
 */
export function toComparable(value: unknown): unknown {
  if (value === undefined) {
    return { $undefined: true };
  }

  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return { $number: String(value) };
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    return { $bytes: Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  }

  if (value instanceof Error) {
    return { $error: describeError(value) };
  }

  if (Array.isArray(value)) {
    return value.map(toComparable);
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toComparable(entry)]));
}

/**
 * Run every scenario in order and report each outcome
 *
 * A failing scenario does not stop the rest. Returns JSON text, so the whole report crosses the guest boundary as
 * one value instead of thousands of serialized entries.
 */
export async function runOrmCases<TDatabase>(db: TDatabase, cases: readonly OrmCase<TDatabase>[]): Promise<string> {
  const results: OrmCaseResult[] = [];

  for (const ormCase of cases) {
    try {
      results.push({ id: ormCase.id, ok: true, value: toComparable(await ormCase.run(db)) });
    } catch (cause) {
      results.push({ id: ormCase.id, ok: false, error: describeError(cause) });
    }
  }

  return JSON.stringify(results);
}
