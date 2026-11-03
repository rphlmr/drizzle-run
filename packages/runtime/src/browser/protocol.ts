import type {
  ConfirmedIndex,
  DatabaseDescription,
  Diagnostic,
  DisplayResult,
  ExecutionPhase,
  LogEvent,
  PlannedQuery,
  QueryPlanFill,
  QueryPlanReading,
  QueryPlansReport,
  RawQueryPlan,
  SerializedError,
  SerializedValue,
  SqlEvent,
} from "@drizzle-run/core/contracts";
import {
  EXECUTION_PHASES,
  MAX_SERIALIZED_TEXT_BYTES,
  SerializedErrorSchema,
  serializedErrorShape,
  SerializedValueSchema,
} from "@drizzle-run/core/contracts";
import * as z from "zod/mini";

import { isQueryPlanSize } from "../query-plans/sizes.ts";
import { plainRecord, refined } from "../schema.ts";
import type { WireTransaction } from "../transactions/transactions.ts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_WIRE_VALUE_DEPTH = 64;
const MAX_COMMAND_TAGS = 10_000;
const MAX_WIRE_TRANSACTIONS = 200;
const textEncoder = new TextEncoder();

const commandTagPattern = /^[A-Z]{1,32}$/;
const callSiteFramesPattern = /^\d{1,7}:\d{1,7}(?: \d{1,7}:\d{1,7}){0,7}$/;
const bigintPattern = /^-?\d+$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Generated `line:column` positions in the project bundle, innermost first, captured by the guest at a
 * console call, a `$.display` call, or the db access that started a query. The host maps them to a
 * project file and line, then drops them; they never reach a published event.
 */
export interface WireCallSite {
  frames?: string;
}

/**
 * The command tag Postgres returned for each statement of a query (`UPDATE`, `SELECT`), first word only. The host
 * reads statement roles from them, then drops them; they never reach a published event. SQLite sends none.
 */
export interface WireCommandTags {
  commandTags?: readonly string[];
}

/** A message the execution worker posts to the host; `parseRuntimeWorkerMessage` checks its exact shape. */
export type RuntimeWorkerMessage =
  | { kind: "ready"; kitLoadMs: number }
  | { kind: "progress"; downloadedBytes: number; totalBytes: number }
  | {
      kind: "phase";
      phase: ExecutionPhase;
      status: "running" | "succeeded" | "failed";
      durationMs?: number;
    }
  | { kind: "event"; type: "sql"; payload: SqlEvent & WireCallSite & WireCommandTags }
  | { kind: "event"; type: "log"; payload: LogEvent & WireCallSite }
  | { kind: "event"; type: "display"; payload: DisplayResult & WireCallSite }
  | { kind: "event"; type: "diagnostic"; payload: Diagnostic }
  | { kind: "console"; level: "log" | "error"; text: string }
  | { kind: "compiled"; sourceMap: string }
  | { kind: "database_opened" }
  | { kind: "database_closed"; cleanup: CleanupMode }
  | {
      kind: "report";
      outcome: "succeeded" | "failed";
      value: SerializedValue;
      error?: SerializedError & { phase: ExecutionPhase; code?: "run_timeout" };
      database?: unknown;
      queryPlans?: QueryPlansReport;
      transactions?: readonly WireTransaction[];
    }
  | { kind: "failure"; error: SerializedError }
  | { kind: "closed"; cleanup: { guest: CleanupMode; database: CleanupMode } };

/** How a guest or database worker closed; `reason` says why a close was forced. */
export interface CleanupMode {
  mode: "graceful" | "forced";
  reason?: string;
}

/** A database value in its JSON-safe wire form. */
type WireValue =
  | { type: "undefined" }
  | { type: "primitive"; value: string | number | boolean | null }
  | { type: "bigint" | "date" | "bytes" | "array_buffer"; value: string }
  | { type: "array"; value: WireValue[] }
  | { type: "object"; value: [string, WireValue][] };

// Building blocks

/** Names the first field a message has that its shape does not list. */
function toUnexpectedFieldMessage(issue: z.core.$ZodRawIssue): string | undefined {
  return issue.code === "unrecognized_keys" ? `Unexpected execution worker field: ${issue.keys[0]}` : undefined;
}

/** A plain object with exactly `shape`'s fields, failing with `message` when it is not a plain object. */
function exactRecord<const Shape extends z.core.$ZodShape>(message: string, shape: Shape) {
  return z.pipe(plainRecord(message), z.strictObject(shape, { error: toUnexpectedFieldMessage }));
}

function boundedText(message: string, maxBytes: number) {
  return z
    .string({ error: message })
    .check(z.refine((text) => textEncoder.encode(text).byteLength <= maxBytes, { error: message }));
}

function patternText(message: string, pattern: RegExp) {
  return z.string({ error: message }).check(z.regex(pattern, { error: message }));
}

function finiteNonnegative(message: string) {
  return z.number({ error: message }).check(z.nonnegative({ error: message }));
}

function nonnegativeInteger(message: string) {
  return z.number({ error: message }).check(z.int({ error: message }), z.nonnegative({ error: message }));
}

function positiveInteger(message: string) {
  return z.number({ error: message }).check(z.int({ error: message }), z.positive({ error: message }));
}

function isValidDate(text: string): boolean {
  return Number.isFinite(Date.parse(text));
}

function hasUniqueFieldNames(fields: readonly [string, unknown][]): boolean {
  return new Set(fields.map(([name]) => name)).size === fields.length;
}

const CallSiteFramesSchema = z.optional(patternText("Invalid call site frames", callSiteFramesPattern));

const CleanupModeSchema = exactRecord("Invalid cleanup evidence", {
  mode: z.enum(["graceful", "forced"], { error: "Invalid cleanup evidence fields" }),
  reason: z.optional(z.string({ error: "Invalid cleanup evidence fields" })),
}) satisfies z.ZodMiniType<CleanupMode>;

/** A run error with the phase it happened in, as a failed report carries it. */
export const ExecutionErrorSchema = exactRecord("Invalid execution error", {
  ...serializedErrorShape,
  phase: z.enum(EXECUTION_PHASES, { error: "Invalid execution error phase" }),
  code: z.optional(z.literal("run_timeout")),
}) satisfies z.ZodMiniType<SerializedError & { phase: ExecutionPhase }>;

// Run events

const invalidSqlFields = "Invalid SQL event fields";
const invalidSqlSource = "Invalid SQL event source or size";
const invalidCommandTags = "Invalid SQL event command tags";

const SqlEventSchema = exactRecord("Invalid SQL event", {
  sequence: positiveInteger(invalidSqlFields),
  phase: z.enum(["bootstrap", "seed", "run", "inspect"], { error: invalidSqlFields }),
  origin: z.enum(["kit", "adapter", "drizzle", "managed_client"], { error: invalidSqlFields }),
  kind: z.enum(["generated", "executed"], { error: invalidSqlFields }),
  sql: z
    .string({ error: invalidSqlFields })
    .check(z.refine((sql) => textEncoder.encode(sql).byteLength <= MAX_MESSAGE_BYTES, { error: invalidSqlSource })),
  parameters: z.array(SerializedValueSchema, { error: invalidSqlFields }),
  namedParameters: z.optional(z.record(z.string(), SerializedValueSchema)),
  source: z.optional(z.string({ error: invalidSqlSource })),
  frames: CallSiteFramesSchema,
  durationMs: z.optional(finiteNonnegative("Invalid SQL duration")),
  rowCount: z.optional(nonnegativeInteger("Invalid SQL row count")),
  outcome: z.enum(["succeeded", "failed"], { error: invalidSqlFields }),
  error: z.optional(SerializedErrorSchema),
  commandTags: z.optional(
    z
      .array(patternText(invalidCommandTags, commandTagPattern), { error: invalidCommandTags })
      .check(z.maxLength(MAX_COMMAND_TAGS, { error: invalidCommandTags })),
  ),
}) satisfies z.ZodMiniType<SqlEvent & WireCallSite & WireCommandTags>;

const invalidLogFields = "Invalid log event fields";

const LogEventSchema = exactRecord("Invalid log event", {
  sequence: positiveInteger(invalidLogFields),
  phase: z.enum(["schema", "seed", "run"], { error: invalidLogFields }),
  level: z.enum(["debug", "info", "log", "warn", "error"], { error: invalidLogFields }),
  values: z.array(SerializedValueSchema, { error: invalidLogFields }),
  source: z.optional(z.string({ error: invalidLogFields })),
  frames: CallSiteFramesSchema,
}) satisfies z.ZodMiniType<LogEvent & WireCallSite>;

const DisplayEventSchema = exactRecord("Invalid display event", {
  label: boundedText("Invalid display event fields", MAX_SERIALIZED_TEXT_BYTES),
  values: z.array(SerializedValueSchema, { error: "Invalid display event fields" }),
  frames: CallSiteFramesSchema,
}) satisfies z.ZodMiniType<DisplayResult & WireCallSite>;

const DiagnosticEventSchema = exactRecord("Invalid diagnostic event", {
  severity: z.enum(["error", "warning", "info"], { error: "Invalid diagnostic fields" }),
  message: boundedText("Invalid diagnostic fields", MAX_SERIALIZED_TEXT_BYTES),
  code: z.optional(z.string({ error: "Invalid diagnostic code" })),
  source: z.optional(z.string({ error: "Invalid diagnostic source" })),
  line: z.optional(positiveInteger("Invalid diagnostic line")),
  column: z.optional(positiveInteger("Invalid diagnostic column")),
}) satisfies z.ZodMiniType<Diagnostic>;

// Report parts

const invalidTransactionFields = "Invalid transaction fields";
const invalidTransactionErrorFields = "Invalid transaction error fields";

const WireTransactionSchema = exactRecord("Invalid transaction", {
  id: positiveInteger(invalidTransactionFields),
  parent: z.optional(positiveInteger(invalidTransactionFields)),
  phase: z.enum(["seed", "run"], { error: invalidTransactionFields }),
  frames: CallSiteFramesSchema,
  outcome: z.enum(["committed", "rolled_back"], { error: invalidTransactionFields }),
  reason: z.optional(z.enum(["rollback_call", "error"], { error: invalidTransactionFields })),
  error: z.optional(
    exactRecord("Invalid transaction error", {
      name: z.string({ error: invalidTransactionErrorFields }),
      message: boundedText(invalidTransactionErrorFields, MAX_SERIALIZED_TEXT_BYTES),
      frames: CallSiteFramesSchema,
    }),
  ),
  statements: z.array(positiveInteger(invalidTransactionFields), { error: invalidTransactionFields }),
  durationMs: finiteNonnegative("Invalid transaction duration"),
}) satisfies z.ZodMiniType<WireTransaction>;

const WireTransactionsSchema = z
  .array(WireTransactionSchema, { error: "Invalid transaction list" })
  .check(z.maxLength(MAX_WIRE_TRANSACTIONS, { error: "Invalid transaction list" }));

/**
 * The schemas of one part of a query plans report, every issue failing with `message`
 *
 * Plans are data the UI only displays: their numbers are not required to be finite, as the planner reads them from
 * database output.
 */
function createQueryPlanSchemas(message: string) {
  const text = z.string({ error: message });
  const planNumber = z.custom<number>((value) => typeof value === "number", { error: message });
  const size = refined(isQueryPlanSize, message);
  const errorResult = z.object({ error: SerializedErrorSchema }, { error: message });
  const rawPlan = z.discriminatedUnion(
    "database",
    [
      z.object({
        database: z.literal("postgresql"),
        size,
        json: text,
        text,
        analyze: z.optional(z.union([z.object({ json: text, text }), errorResult], { error: message })),
      }),
      z.object({
        database: z.literal("sqlite"),
        size,
        rows: z.array(
          z.object({ id: planNumber, parent: planNumber, notused: planNumber, detail: text }, { error: message }),
          { error: message },
        ),
        timing: z.union(
          [z.object({ samples: planNumber, medianMs: planNumber, minMs: planNumber, maxMs: planNumber }), errorResult],
          { error: message },
        ),
      }),
    ],
    { error: message },
  ) satisfies z.ZodMiniType<RawQueryPlan>;

  return { text, planNumber, size, rawPlan };
}

const invalidPlannedQuery = "Invalid planned query";

function createPlannedQuerySchema() {
  const { text, planNumber, rawPlan } = createQueryPlanSchemas(invalidPlannedQuery);
  const confirmedIndex = z.object(
    {
      trigger: z.enum(["filtered_scan", "foreign_key_join", "sorted_limit"], { error: invalidPlannedQuery }),
      table: text,
      schema: z.optional(text),
      columns: z.array(text, { error: invalidPlannedQuery }),
      name: text,
      drizzle: text,
      measure: z.object(
        {
          unit: z.enum(["cost", "ms"], { error: invalidPlannedQuery }),
          before: planNumber,
          after: planNumber,
        },
        { error: invalidPlannedQuery },
      ),
      before: rawPlan,
      after: rawPlan,
    },
    { error: invalidPlannedQuery },
  ) satisfies z.ZodMiniType<ConfirmedIndex>;
  const reading = z.object(
    {
      summary: text,
      verdict: z.discriminatedUnion(
        "kind",
        [
          z.object({ kind: z.literal("stays_fast") }),
          z.object({ kind: z.literal("grows"), tables: z.array(text, { error: invalidPlannedQuery }) }),
        ],
        { error: invalidPlannedQuery },
      ),
      indexes: z.array(confirmedIndex, { error: invalidPlannedQuery }),
    },
    { error: invalidPlannedQuery },
  ) satisfies z.ZodMiniType<QueryPlanReading>;

  return z.pipe(
    plainRecord(invalidPlannedQuery),
    z.object({
      sequences: z.array(planNumber, { error: invalidPlannedQuery }),
      sql: text,
      parameters: z.array(SerializedValueSchema, { error: invalidPlannedQuery }),
      namedParameters: z.optional(z.record(z.string(), SerializedValueSchema)),
      raw: z.array(rawPlan, { error: invalidPlannedQuery }),
      reading: z.optional(reading),
      error: z.optional(SerializedErrorSchema),
    }),
  ) satisfies z.ZodMiniType<PlannedQuery>;
}

const PlannedQuerySchema = createPlannedQuerySchema();

const invalidQueryPlans = "Invalid query plans report";

function createQueryPlansReportSchema() {
  const { text, planNumber, size } = createQueryPlanSchemas(invalidQueryPlans);
  const fill = z.object(
    {
      size,
      tables: z.array(
        z.object({ name: text, schema: z.optional(text), rows: planNumber }, { error: invalidQueryPlans }),
        { error: invalidQueryPlans },
      ),
      durationMs: planNumber,
    },
    { error: invalidQueryPlans },
  ) satisfies z.ZodMiniType<QueryPlanFill>;
  const skipped = z.object(
    { sequences: z.array(planNumber, { error: invalidQueryPlans }), reason: text },
    { error: invalidQueryPlans },
  );

  return exactRecord(invalidQueryPlans, {
    settings: z.pipe(
      plainRecord(invalidQueryPlans),
      z.object({ size, measureRealTime: z.boolean({ error: invalidQueryPlans }) }),
    ),
    dialect: z.enum(["postgresql", "sqlite"], { error: invalidQueryPlans }),
    fills: z.array(fill, { error: invalidQueryPlans }),
    queries: z.array(PlannedQuerySchema, { error: invalidQueryPlans }),
    skipped: z.array(skipped, { error: invalidQueryPlans }),
    durationMs: finiteNonnegative("Invalid query plans duration"),
    error: z.optional(SerializedErrorSchema),
  }) satisfies z.ZodMiniType<QueryPlansReport>;
}

const QueryPlansReportSchema = createQueryPlansReportSchema();

const wireValueSchemas: z.ZodMiniType<WireValue>[] = [];

/** The encoded database value schema at one nesting depth; deeper than 64 levels is invalid. */
function getWireValueSchema(depth: number): z.ZodMiniType<WireValue> {
  const cached = wireValueSchemas[depth];

  if (cached !== undefined) {
    return cached;
  }

  const invalidValue = "Invalid encoded database value";
  const invalidScalar = "Invalid encoded database scalar";
  const childSchema = z.lazy(() => getWireValueSchema(depth + 1));
  const schema: z.ZodMiniType<WireValue> =
    depth > MAX_WIRE_VALUE_DEPTH
      ? z.never({ error: invalidValue })
      : z.pipe(
          z.pipe(plainRecord(invalidValue), z.looseObject({ type: z.string({ error: invalidValue }) })),
          z.discriminatedUnion(
            "type",
            [
              z.strictObject({ type: z.literal("undefined") }, { error: toUnexpectedFieldMessage }),
              z.strictObject(
                {
                  type: z.literal("primitive"),
                  value: z.union([z.null(), z.string(), z.boolean(), z.number()], {
                    error: "Invalid encoded database primitive",
                  }),
                },
                { error: toUnexpectedFieldMessage },
              ),
              z.strictObject(
                {
                  type: z.literal("bigint"),
                  value: z
                    .string({ error: invalidScalar })
                    .check(z.regex(bigintPattern, { error: "Invalid encoded database bigint" })),
                },
                { error: toUnexpectedFieldMessage },
              ),
              z.strictObject(
                {
                  type: z.literal("date"),
                  value: z
                    .string({ error: invalidScalar })
                    .check(z.refine(isValidDate, { error: "Invalid encoded database date" })),
                },
                { error: toUnexpectedFieldMessage },
              ),
              z.strictObject(
                {
                  type: z.literal(["bytes", "array_buffer"]),
                  value: z
                    .string({ error: invalidScalar })
                    .check(z.regex(base64Pattern, { error: "Invalid encoded database bytes" })),
                },
                { error: toUnexpectedFieldMessage },
              ),
              z.strictObject(
                {
                  type: z.literal("array"),
                  value: z.array(childSchema, { error: "Invalid encoded database array" }),
                },
                { error: toUnexpectedFieldMessage },
              ),
              z.strictObject(
                {
                  type: z.literal("object"),
                  value: z
                    .array(
                      z.tuple([z.string({ error: "Invalid encoded database object field" }), childSchema], {
                        error: "Invalid encoded database object field",
                      }),
                      { error: "Invalid encoded database object" },
                    )
                    .check(z.refine(hasUniqueFieldNames, { error: "Duplicate encoded database object field" })),
                },
                { error: toUnexpectedFieldMessage },
              ),
            ],
            { error: "Unknown encoded database value type" },
          ),
        );

  wireValueSchemas[depth] = schema;

  return schema;
}

const WireValueSchema = getWireValueSchema(0);

// Database description

const DatabaseNameSchema = z.string({ error: "Invalid database object name" });

const StringCollectionSchema = z.array(z.string({ error: "Invalid string collection" }), {
  error: "Invalid string collection",
});

const invalidTableCollections = "Invalid database table collections";
const invalidTableKeys = "Invalid database table keys or checks";
const invalidColumnFields = "Invalid database column fields";
const invalidTablesOrViews = "Invalid database tables or views";

const DatabaseColumnSchema = exactRecord("Invalid database column", {
  name: DatabaseNameSchema,
  dataType: z.string({ error: invalidColumnFields }),
  nullable: z.boolean({ error: invalidColumnFields }),
  defaultValue: z.optional(z.string({ error: invalidColumnFields })),
  generatedExpression: z.optional(z.string({ error: invalidColumnFields })),
});

const DatabaseForeignKeySchema = exactRecord("Invalid database foreign key", {
  columns: StringCollectionSchema,
  referencedTable: DatabaseNameSchema,
  referencedColumns: StringCollectionSchema,
});

const DatabaseIndexSchema = exactRecord("Invalid database index", {
  name: DatabaseNameSchema,
  columns: StringCollectionSchema,
  unique: z.boolean({ error: "Invalid database index uniqueness" }),
});

const databaseTableShape = {
  name: DatabaseNameSchema,
  columns: z.array(DatabaseColumnSchema, { error: invalidTableCollections }),
  primaryKey: z.array(z.string({ error: invalidTableKeys }), { error: invalidTableCollections }),
  foreignKeys: z.array(DatabaseForeignKeySchema, { error: invalidTableCollections }),
  indexes: z.array(DatabaseIndexSchema, { error: invalidTableCollections }),
  checks: z.array(z.string({ error: invalidTableKeys }), { error: invalidTableCollections }),
};

const DatabaseTableSchema = exactRecord("Invalid database table", databaseTableShape);

const SqliteTableSchema = exactRecord("Invalid database table", {
  ...databaseTableShape,
  sql: z.optional(z.string({ error: "Invalid SQLite table metadata" })),
  autoIncrement: z.boolean({ error: "Invalid SQLite table metadata" }),
});

const DatabaseViewSchema = exactRecord("Invalid database view", {
  name: DatabaseNameSchema,
  definition: z.optional(z.string({ error: "Invalid database view definition" })),
});

const PostgresSchemaDescriptionSchema = exactRecord("Invalid PostgreSQL schema description", {
  name: DatabaseNameSchema,
  tables: z.array(DatabaseTableSchema, { error: invalidTablesOrViews }),
  views: z.array(DatabaseViewSchema, { error: invalidTablesOrViews }),
  enums: z.array(
    exactRecord("Invalid PostgreSQL enum", {
      name: DatabaseNameSchema,
      values: z.array(z.string({ error: "Invalid PostgreSQL enum values" }), {
        error: "Invalid PostgreSQL enum values",
      }),
    }),
    { error: "Invalid PostgreSQL schema collections" },
  ),
  sequences: z.array(exactRecord("Invalid PostgreSQL sequence", { name: DatabaseNameSchema }), {
    error: "Invalid PostgreSQL schema collections",
  }),
});

const DatabaseDescriptionSchema = z.pipe(
  z.pipe(
    plainRecord("Invalid database description"),
    z.looseObject({ dialect: z.enum(["postgresql", "sqlite"], { error: "Invalid database dialect" }) }),
  ),
  z.discriminatedUnion("dialect", [
    z.strictObject(
      {
        dialect: z.literal("sqlite"),
        tables: z.array(SqliteTableSchema, { error: invalidTablesOrViews }),
        views: z.array(DatabaseViewSchema, { error: invalidTablesOrViews }),
      },
      { error: toUnexpectedFieldMessage },
    ),
    z.strictObject(
      {
        dialect: z.literal("postgresql"),
        schemas: z.array(PostgresSchemaDescriptionSchema, { error: "Invalid PostgreSQL schemas" }),
      },
      { error: toUnexpectedFieldMessage },
    ),
  ]),
) satisfies z.ZodMiniType<DatabaseDescription>;

// Execution worker messages

const invalidPhase = "Invalid execution worker phase";
const invalidConsole = "Invalid execution worker console message";

const EventMessageSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject(
      { kind: z.literal("event"), type: z.literal("sql"), payload: SqlEventSchema },
      { error: toUnexpectedFieldMessage },
    ),
    z.strictObject(
      { kind: z.literal("event"), type: z.literal("log"), payload: LogEventSchema },
      { error: toUnexpectedFieldMessage },
    ),
    z.strictObject(
      { kind: z.literal("event"), type: z.literal("display"), payload: DisplayEventSchema },
      { error: toUnexpectedFieldMessage },
    ),
    z.strictObject(
      { kind: z.literal("event"), type: z.literal("diagnostic"), payload: DiagnosticEventSchema },
      { error: toUnexpectedFieldMessage },
    ),
  ],
  { error: "Invalid execution worker event type" },
);

const ReportMessageSchema = z
  .strictObject(
    {
      kind: z.literal("report"),
      outcome: z.enum(["succeeded", "failed"], { error: "Invalid execution worker report outcome" }),
      value: SerializedValueSchema,
      error: z.optional(ExecutionErrorSchema),
      database: z.optional(WireValueSchema),
      queryPlans: z.optional(QueryPlansReportSchema),
      transactions: z.optional(WireTransactionsSchema),
    },
    { error: toUnexpectedFieldMessage },
  )
  .check(
    z.refine((report) => report.outcome !== "failed" || report.error !== undefined, {
      error: "Failed execution report has no error",
    }),
    z.refine((report) => report.outcome !== "succeeded" || report.error === undefined, {
      error: "Successful execution report contains an error",
    }),
  );

const RuntimeWorkerMessageSchema = z.pipe(
  z.pipe(
    plainRecord("Invalid execution worker message"),
    z.looseObject({ kind: z.string({ error: "Invalid execution worker message" }) }),
  ),
  z.discriminatedUnion(
    "kind",
    [
      z.strictObject(
        { kind: z.literal("ready"), kitLoadMs: finiteNonnegative("Invalid kitLoadMs") },
        { error: toUnexpectedFieldMessage },
      ),
      z
        .strictObject(
          {
            kind: z.literal("progress"),
            downloadedBytes: nonnegativeInteger("Invalid downloadedBytes"),
            totalBytes: nonnegativeInteger("Invalid totalBytes"),
          },
          { error: toUnexpectedFieldMessage },
        )
        .check(
          z.refine((progress) => progress.downloadedBytes <= progress.totalBytes, {
            error: "Invalid execution worker download progress",
          }),
        ),
      z.strictObject(
        {
          kind: z.literal("phase"),
          phase: z.enum(EXECUTION_PHASES, { error: invalidPhase }),
          status: z.enum(["running", "succeeded", "failed"], { error: invalidPhase }),
          durationMs: z.optional(finiteNonnegative("Invalid durationMs")),
        },
        { error: toUnexpectedFieldMessage },
      ),
      EventMessageSchema,
      z.strictObject(
        {
          kind: z.literal("console"),
          level: z.enum(["log", "error"], { error: invalidConsole }),
          text: boundedText(invalidConsole, MAX_SERIALIZED_TEXT_BYTES),
        },
        { error: toUnexpectedFieldMessage },
      ),
      z.strictObject(
        {
          kind: z.literal("compiled"),
          sourceMap: boundedText("Invalid compiled source map message", MAX_MESSAGE_BYTES),
        },
        { error: toUnexpectedFieldMessage },
      ),
      z.strictObject({ kind: z.literal("database_opened") }, { error: toUnexpectedFieldMessage }),
      z.strictObject(
        { kind: z.literal("database_closed"), cleanup: CleanupModeSchema },
        { error: toUnexpectedFieldMessage },
      ),
      ReportMessageSchema,
      z.strictObject({ kind: z.literal("failure"), error: SerializedErrorSchema }, { error: toUnexpectedFieldMessage }),
      z.strictObject(
        {
          kind: z.literal("closed"),
          cleanup: exactRecord("Invalid worker cleanup evidence", {
            guest: CleanupModeSchema,
            database: CleanupModeSchema,
          }),
        },
        { error: toUnexpectedFieldMessage },
      ),
    ],
    { error: "Unknown execution worker message" },
  ),
) satisfies z.ZodMiniType<RuntimeWorkerMessage>;

/** Throws the first problem a schema found, as the `TypeError` callers of this protocol expect. */
function parseOrThrow<Output>(schema: z.ZodMiniType<Output>, input: unknown, fallbackMessage: string): Output {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new TypeError(result.error.issues[0]?.message ?? fallbackMessage);
  }

  return result.data;
}

function assertJsonBudget(input: unknown): void {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(input);
  } catch (cause) {
    throw new TypeError("Execution worker message is not JSON serializable", { cause });
  }

  if (serialized === undefined || textEncoder.encode(serialized).byteLength > MAX_MESSAGE_BYTES) {
    throw new RangeError("Execution worker message exceeds 2 MiB");
  }
}

/**
 * Parse an execution worker message
 *
 * Throws a `RangeError` when the input exceeds the 2 MiB message budget, and a `TypeError` naming the first problem
 * when it has an unknown kind, an unexpected field, or an invalid value.
 */
export function parseRuntimeWorkerMessage(input: unknown): RuntimeWorkerMessage {
  assertJsonBudget(input);

  return parseOrThrow(RuntimeWorkerMessageSchema, input, "Invalid execution worker message");
}

function decodeWireValue(value: WireValue): unknown {
  switch (value.type) {
    case "undefined":
      return undefined;

    case "primitive":
      return value.value;

    case "bigint":
      return BigInt(value.value);

    case "date":
      return new Date(value.value);

    case "bytes":
    case "array_buffer": {
      const bytes = Uint8Array.from(atob(value.value), (character) => character.charCodeAt(0));

      return value.type === "bytes" ? bytes : bytes.buffer;
    }

    case "array":
      return value.value.map(decodeWireValue);

    case "object":
      return Object.fromEntries(value.value.map(([key, entry]) => [key, decodeWireValue(entry)]));
  }
}

/**
 * Decode the wire form of a database description
 *
 * Restores bigints, dates and bytes, then throws a `TypeError` when the input is not a valid encoded value or the
 * result is not a valid description.
 */
export function decodeDatabaseDescription(input: unknown): DatabaseDescription {
  const encoded = parseOrThrow(WireValueSchema, input, "Invalid encoded database value");

  return parseOrThrow(DatabaseDescriptionSchema, decodeWireValue(encoded), "Invalid database description");
}
