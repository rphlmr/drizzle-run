import { createFrameReader } from "./protocol-frames.ts";

export interface WireStatement {
  sql: string;
  parameters: unknown[];
  tags: string[];
  started: number;
  sequence: number;
}

export function readCString(body: Uint8Array, offset: number) {
  const end = body.indexOf(0, offset);

  return { text: new TextDecoder().decode(body.subarray(offset, end)), next: end + 1 };
}

const undecodedType = Symbol("undecoded PostgreSQL parameter type");

// A binary parameter of a type the observer cannot read, keeping its type OID.
function createUndecodedParameter(typeOid: number) {
  return Object.freeze({ [undecodedType]: typeOid });
}

/** The type OID of a binary parameter `decodeBinaryParameter` could not read, or `undefined` for any other value. */
export function readUndecodedTypeOid(value: unknown): number | undefined {
  const typeOid: unknown = typeof value === "object" && value !== null ? Reflect.get(value, undecodedType) : undefined;
  return typeof typeOid === "number" ? typeOid : undefined;
}

// Parse's parameter type OIDs, in order; 0 leaves a type to the server.
function readParameterTypes(body: Uint8Array, offset: number) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getInt16(offset);

  return Array.from({ length: count }, (_, index) => view.getUint32(offset + 2 + index * 4));
}

const POSTGRES_EPOCH_MS = Date.UTC(2000, 0, 1);
const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const textTypes = new Set([18, 19, 25, 114, 1042, 1043]);
const arrayTypes = new Set([
  199, 1000, 1001, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1028, 1115, 1182, 1185, 2951, 3807,
]);

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read a binary parameter as the value a node-postgres caller would pass
 *
 * Numbers, booleans, text, JSON (as its text), `bytea` (as `\x` hex), `uuid`, `date` (`YYYY-MM-DD`), timestamps (as a
 * `Date`) and one-or-more-dimensional arrays of those. Any other type gives a value `readUndecodedTypeOid` reads.
 */
export function decodeBinaryParameter(bytes: Uint8Array, typeOid: number): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (textTypes.has(typeOid)) {
    return new TextDecoder().decode(bytes);
  }

  if (arrayTypes.has(typeOid)) {
    return decodeBinaryArray(bytes, typeOid);
  }

  switch (typeOid) {
    case 16:
      return bytes[0] === 1;
    case 17:
      return `\\x${toHex(bytes)}`;
    case 20:
      return String(view.getBigInt64(0));
    case 21:
      return view.getInt16(0);
    case 23:
      return view.getInt32(0);
    case 26:
      return view.getUint32(0);
    case 700:
      return view.getFloat32(0);
    case 701:
      return view.getFloat64(0);
    case 1082: {
      const days = view.getInt32(0);

      if (Math.abs(days) >= INT32_MAX) {
        return days > 0 ? "infinity" : "-infinity";
      }

      const date = new Date(POSTGRES_EPOCH_MS + days * 86_400_000);

      // Postgres dates reach past what a JavaScript Date holds.
      return Number.isNaN(date.getTime()) ? createUndecodedParameter(typeOid) : date.toISOString().slice(0, 10);
    }
    case 1114:
    case 1184: {
      const microseconds = view.getBigInt64(0);

      if (microseconds === INT64_MAX || microseconds === -INT64_MAX - 1n) {
        return microseconds > 0n ? "infinity" : "-infinity";
      }

      // Floored, so a time before 2000 with microseconds keeps its millisecond.
      const milliseconds = microseconds / 1000n - (microseconds % 1000n < 0n ? 1n : 0n);

      return new Date(POSTGRES_EPOCH_MS + Number(milliseconds));
    }
    case 2950: {
      const hex = toHex(bytes);

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case 3802:
      // jsonb's binary form is a version byte, then the JSON text.
      return new TextDecoder().decode(bytes.subarray(1));
    default:
      return createUndecodedParameter(typeOid);
  }
}

// An array's binary form: dimension count, a null flag, the element type, each dimension's size and lower bound, then
// each element as a length (-1 for null) and its bytes.
function decodeBinaryArray(bytes: Uint8Array, typeOid: number): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensionCount = view.getInt32(0);
  const elementOid = view.getUint32(8);
  const sizes = Array.from({ length: dimensionCount }, (_, index) => view.getInt32(12 + index * 8));
  let offset = 12 + dimensionCount * 8;
  let undecoded = false;

  const readDimension = (dimension: number): unknown[] =>
    Array.from({ length: sizes[dimension] }, () => {
      if (dimension < dimensionCount - 1) {
        return readDimension(dimension + 1);
      }

      const length = view.getInt32(offset);
      offset += 4;

      if (length < 0) {
        return null;
      }

      const element = decodeBinaryParameter(bytes.subarray(offset, offset + length), elementOid);
      offset += length;
      undecoded ||= readUndecodedTypeOid(element) !== undefined;

      return element;
    });

  const values = dimensionCount === 0 ? [] : readDimension(0);

  return undecoded ? createUndecodedParameter(typeOid) : values;
}

// Bind's parameter values: text as is, binary decoded by the statement's parameter types, null as null.
function readBindParameters(body: Uint8Array, parameterTypes: number[]): unknown[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = readCString(body, readCString(body, 0).next).next;
  const formatCount = view.getInt16(offset);
  const formats = Array.from({ length: formatCount }, (_, index) => view.getInt16(offset + 2 + index * 2));
  offset += 2 + formatCount * 2;
  const parameterCount = view.getInt16(offset);
  offset += 2;
  const parameters: unknown[] = [];

  for (let index = 0; index < parameterCount; index += 1) {
    const length = view.getInt32(offset);
    offset += 4;

    if (length < 0) {
      parameters.push(null);
      continue;
    }

    const value = body.slice(offset, offset + length);
    const format = formats.length === 1 ? formats[0] : (formats[index] ?? 0);
    parameters.push(
      format === 1 ? decodeBinaryParameter(value, parameterTypes[index] ?? 0) : new TextDecoder().decode(value),
    );
    offset += length;
  }

  return parameters;
}

function readErrorFields(body: Uint8Array) {
  const fields: Record<string, string> = {};
  let offset = 0;

  while (offset < body.byteLength && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]);
    const field = readCString(body, offset + 1);
    fields[code] = field.text;
    offset = field.next;
  }

  return Object.assign(new Error(fields.M ?? "PostgreSQL error"), {
    name: "DatabaseError",
    ...(fields.C === undefined ? {} : { code: fields.C }),
  });
}

/**
 * Observe the SQL of a wire connection the project opened itself
 *
 * Effect's own PostgreSQL client speaks the protocol past the observed `pg` client, so its statements are read from
 * the frames it sends (Query, or Parse, Bind and Execute) and settled by the replies (CommandComplete, ErrorResponse).
 * Statements sent after an error in the same Sync never run, so they get no event. An exchange the host failed fails
 * every statement it was running. `onStart()` runs as a statement is sent and returns its sequence, so a statement sorts
 * where it started. `onStatement(statement, outcome, error)` receives `{ sql, parameters, tags, started, sequence }`
 * once a statement settled. A frame the observer cannot read, or an `onStatement` that throws, stops it and reaches
 * `onError`, so observing never fails the connection's queries.
 */
export function observePostgresWire({
  onStatement,
  onStart = () => 0,
  onError = () => {},
}: {
  onStatement: (statement: WireStatement, outcome: "succeeded" | "failed", cause?: unknown) => void;
  onStart?: () => number;
  onError?: (cause: unknown) => void;
}) {
  const preparedStatements = new Map<string, { sql: string; parameterTypes: number[] }>();
  const portals = new Map<string, { sql?: string; parameters: unknown[] }>();
  const running: (WireStatement & { batch: number; simple: boolean })[] = [];
  const readSent = createFrameReader(true);
  const readReceived = createFrameReader(false);
  let sentBatch = 0;
  // The startup handshake ends with a ReadyForQuery of its own, before any batch was sent.
  let readyBatch = -1;

  const start = (sql: string, parameters: unknown[], simple: boolean) =>
    running.push({
      sql,
      parameters,
      batch: sentBatch,
      tags: [],
      simple,
      started: performance.now(),
      sequence: onStart(),
    });
  const settle = (statement: (typeof running)[number], outcome: "succeeded" | "failed", error?: unknown) => {
    running.splice(running.indexOf(statement), 1);
    onStatement(statement, outcome, error);
  };
  // Observing is diagnostics: a frame it cannot read stops it, and the connection's queries go on.
  let stopped = false;
  const observe =
    <Input>(read: (value: Input) => void) =>
    (value: Input) => {
      if (stopped) {
        return;
      }

      try {
        read(value);
      } catch (cause) {
        stopped = true;
        onError(cause);
      }
    };

  return {
    sent: observe((bytes: Uint8Array) => {
      for (const { type, body } of readSent(bytes)) {
        if (type === 0x51) {
          // Query: a simple query is its own batch, settled by its ReadyForQuery.
          start(readCString(body, 0).text, [], true);
          sentBatch += 1;
        } else if (type === 0x50) {
          const name = readCString(body, 0);
          const query = readCString(body, name.next);
          preparedStatements.set(name.text, { sql: query.text, parameterTypes: readParameterTypes(body, query.next) });
        } else if (type === 0x42) {
          const portal = readCString(body, 0);
          const statement = preparedStatements.get(readCString(body, portal.next).text);
          portals.set(portal.text, {
            sql: statement?.sql,
            parameters: readBindParameters(body, statement?.parameterTypes ?? []),
          });
        } else if (type === 0x45) {
          const bound = portals.get(readCString(body, 0).text);

          if (bound?.sql !== undefined) {
            start(bound.sql, bound.parameters, false);
          }
        } else if (type === 0x53) {
          sentBatch += 1;
        }
      }
    }),
    received: observe((bytes: Uint8Array) => {
      for (const { type, body } of readReceived(bytes)) {
        const current = running.find((statement) => statement.batch === readyBatch);

        if ((type === 0x43 || type === 0x49) && current !== undefined) {
          // CommandComplete or EmptyQueryResponse: a simple query collects one tag per statement until it is ready.
          if (type === 0x43) {
            current.tags.push(readCString(body, 0).text);
          }

          if (!current.simple) {
            settle(current, "succeeded");
          }
        } else if (type === 0x45 && current !== undefined) {
          settle(current, "failed", readErrorFields(body));
        } else if (type === 0x5a) {
          for (const statement of running.filter((candidate) => candidate.batch === readyBatch)) {
            if (statement.simple) {
              settle(statement, "succeeded");
            } else {
              running.splice(running.indexOf(statement), 1);
            }
          }

          readyBatch += 1;
        }
      }
    }),
    failed: observe((cause: unknown) => {
      for (const statement of running.splice(0)) {
        onStatement(statement, "failed", cause);
      }
    }),
  };
}
