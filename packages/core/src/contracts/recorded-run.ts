import * as z from "zod/mini";

import type { RunManifest } from "../manifest/types.ts";
import { getGuestLockDigest, resolveGuestFlavor, toGuestImageId } from "../registry/guest-images.ts";
import { DIALECT_IDS } from "../releases/dialects.ts";
import { formatIssuePath } from "../shared/records.ts";
import type { DataRecord } from "../shared/records.ts";
import {
  createDataRecordSchema,
  refined,
  reportIssue,
  toContractIssues,
  withIssueCode,
  type ContractIssue,
} from "../shared/schema.ts";
import type {
  Diagnostic,
  DisplayResult,
  ExecutionPhase,
  LogEvent,
  PhaseStatus,
  RunTransaction,
  SqlEvent,
  TransactionStatementRole,
} from "./result.ts";
import type { CleanupEvidence, RunResult, RunEvent } from "./runtime.ts";
import { SerializedErrorSchema, SerializedValueSchema } from "./serialization-schema.ts";

/** Largest recorded run JSON, in UTF-8 bytes. */
export const MAX_RECORDED_RUN_BYTES = 256 * 1024;

/** A run that succeeded, as the runtime returns it. */
export type SucceededRunResult = Extract<RunResult, { outcome: "succeeded" }>;

/**
 * The part of a succeeded run a recording keeps
 *
 * Embeds show Results, Story and SQL only, so the database description and query plans, which can be large, are left
 * out to keep the size cap for the output readers see.
 */
export type RecordedRunResult = Omit<SucceededRunResult, "database" | "queryPlans">;

/**
 * The guest image a recorded run ran on
 *
 * A companion refresh keeps the image id and changes its lock digest, so the pair is what the snapshot digest pins and
 * the lock digest is what tells a recording made before the refresh apart.
 */
export interface RecordedGuest {
  imageId: string;
  /** The image's lock digest from the generated guest catalog, as `getGuestLockDigest` returns it. */
  lockDigest: string;
}

/**
 * A succeeded run of a published snapshot, kept so readers who cannot run it still see its output
 *
 * A one-version snapshot records its `result`; a side-by-side one records both `sides`, in side order. `guests` holds
 * the guest each run ran on, in the same order.
 */
export type RecordedRun = {
  recordingVersion: 1;
  /** The content digest of the snapshot revision the run ran, as `digestPlaygroundSnapshot` returns it. */
  snapshotDigest: string;
  /** When the run finished, as an ISO 8601 time. */
  recordedAt: string;
} & (
  | { result: RecordedRunResult; guests: readonly [RecordedGuest]; sides?: never }
  | {
      sides: readonly [RecordedRunResult, RecordedRunResult];
      guests: readonly [RecordedGuest, RecordedGuest];
      result?: never;
    }
);

/** One problem found in a recorded run, at a path inside it. */
export interface RecordedRunIssue {
  path: readonly (string | number)[];
  code: "INVALID_TYPE" | "UNKNOWN_FIELD" | "INVALID_VALUE" | "UNSUPPORTED_VERSION" | "RECORDING_TOO_LARGE";
  message: string;
}

/** The result of `safeParseRecordedRun`: the recording, or the issues found. */
export type SafeParseRecordedRunResult =
  | { success: true; data: RecordedRun }
  | { success: false; issues: readonly RecordedRunIssue[] };

/** Thrown by `parseRecordedRun` with every issue found, one per message line. */
export class RecordedRunValidationError extends TypeError {
  readonly issues: readonly RecordedRunIssue[];

  constructor(issues: readonly RecordedRunIssue[]) {
    super(issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"));
    this.name = "RecordedRunValidationError";
    this.issues = issues;
  }
}

/** Past this many issues the rest are dropped, so a broken recording cannot produce a huge error. */
const MAX_REPORTED_ISSUES = 20;

const RECORDED_RUN_ISSUE_CODES = [
  "UNSUPPORTED_VERSION",
  "RECORDING_TOO_LARGE",
] as const satisfies readonly RecordedRunIssue["code"][];

const encoder = new TextEncoder();

const PlainObjectSchema = createDataRecordSchema("Expected an object.");

/** A field the object must have, reported as missing by its own name before its schema reads it. */
function required<Schema extends z.core.$ZodType>(schema: Schema) {
  return z.pipe(
    refined<unknown>((value) => value !== undefined, {
      error: (issue) => `Missing field: ${String(issue.path?.at(-1))}.`,
      params: { code: "INVALID_TYPE" },
    }),
    schema,
  );
}

const TextSchema = z.string({ error: "Expected text." });

const FiniteNumberSchema = refined<number>(
  (value) => typeof value === "number" && Number.isFinite(value),
  withIssueCode("INVALID_TYPE", "Expected a finite number."),
);

const IntegerSchema = refined<number>(Number.isSafeInteger, withIssueCode("INVALID_TYPE", "Expected an integer."));

/** Accepts exactly one of `values`. */
function oneOf<const Value extends z.core.util.Literal>(values: readonly Value[]) {
  return z.literal(values, {
    error: `Expected one of ${values.map((allowed) => JSON.stringify(allowed)).join(", ")}.`,
  });
}

/** Accepts one of the keys of a record that lists every member of a union, so the list cannot drift from its type. */
function keyOf<Member extends string>(members: Readonly<Record<Member, true>>) {
  return oneOf(Object.keys(members).filter((key): key is Member => Object.hasOwn(members, key)));
}

function listOf<Item extends z.core.$ZodType>(item: Item) {
  return z.array(item, { error: "Expected a list." });
}

function recordOf<Item extends z.core.$ZodType>(item: Item) {
  return z.pipe(PlainObjectSchema, z.record(z.string(), item));
}

/**
 * An object whose `type` field picks the shape of the rest
 *
 * Takes the union built by `unionByType` at the call site: zod types `z.pipe` against the union's input, which it can
 * only read from concrete shapes, not from a generic list of them.
 */
function taggedByType<Union extends z.core.$ZodType<unknown, DataRecord>>(union: Union) {
  return z.pipe(PlainObjectSchema, union);
}

/** The union `taggedByType` checks, failing with the allowed `types` when `type` matches none of `shapes`. */
function unionByType<const Shapes extends readonly [z.core.$ZodTypeDiscriminable, ...z.core.$ZodTypeDiscriminable[]]>(
  types: readonly string[],
  shapes: Shapes,
) {
  return z.discriminatedUnion("type", shapes, { error: `Expected type to be one of ${types.join(", ")}.` });
}

// Every member of each union the result uses, so a new member fails to compile until it is listed here.
const executionPhases: Record<ExecutionPhase, true> = {
  validate: true,
  resolve: true,
  load_artifacts: true,
  compile: true,
  evaluate_schema: true,
  generate_bootstrap: true,
  open_database: true,
  apply_bootstrap: true,
  initialize_context: true,
  seed: true,
  run: true,
  inspect: true,
  plan: true,
  cleanup: true,
};

const phaseStatuses: Record<PhaseStatus, true> = {
  pending: true,
  running: true,
  succeeded: true,
  skipped: true,
  failed: true,
  cancelled: true,
};

const diagnosticSeverities: Record<Diagnostic["severity"], true> = { error: true, warning: true, info: true };

const sqlPhases: Record<SqlEvent["phase"], true> = { bootstrap: true, seed: true, run: true, inspect: true };

const sqlOrigins: Record<SqlEvent["origin"], true> = {
  kit: true,
  adapter: true,
  drizzle: true,
  managed_client: true,
};

const logPhases: Record<LogEvent["phase"], true> = { schema: true, seed: true, run: true };

const logLevels: Record<LogEvent["level"], true> = { debug: true, info: true, log: true, warn: true, error: true };

const cleanupModes: Record<CleanupEvidence["mode"], true> = { graceful: true, forced: true };

const transactionPhases: Record<RunTransaction["phase"], true> = { seed: true, run: true };

const transactionOutcomes: Record<RunTransaction["outcome"], true> = { committed: true, rolled_back: true };
const transactionWrites: Record<RunTransaction["writes"], true> = { kept: true, undone: true };

const transactionReasons: Record<NonNullable<RunTransaction["reason"]>, true> = { rollback_call: true, error: true };

const transactionStatementRoles: Record<TransactionStatementRole, true> = {
  begin: true,
  commit: true,
  rollback: true,
  savepoint: true,
  release: true,
  rollback_to: true,
  read: true,
  write: true,
};

const timingKeys: Record<ExecutionPhase | "total", true> = { ...executionPhases, total: true };

/** An object with these fields only. */
function objectOf<Shape extends z.core.$ZodLooseShape>(shape: Shape) {
  return z.pipe(PlainObjectSchema, z.strictObject(shape));
}

const TargetSchema = objectOf({ dialect: required(oneOf(DIALECT_IDS)) });

const DiagnosticSchema = objectOf({
  severity: required(keyOf(diagnosticSeverities)),
  message: required(TextSchema),
  code: z.optional(TextSchema),
  source: z.optional(TextSchema),
  line: z.optional(IntegerSchema),
  column: z.optional(IntegerSchema),
}) satisfies z.ZodMiniType<Diagnostic>;

const SqlEventSchema = objectOf({
  sequence: required(IntegerSchema),
  phase: required(keyOf(sqlPhases)),
  origin: required(keyOf(sqlOrigins)),
  kind: required(oneOf(["generated", "executed"])),
  sql: required(TextSchema),
  parameters: required(listOf(SerializedValueSchema)),
  namedParameters: z.optional(z.record(z.string(), SerializedValueSchema)),
  outcome: required(oneOf(["succeeded", "failed"])),
  source: z.optional(TextSchema),
  line: z.optional(IntegerSchema),
  durationMs: z.optional(FiniteNumberSchema),
  rowCount: z.optional(IntegerSchema),
  error: z.optional(SerializedErrorSchema),
}) satisfies z.ZodMiniType<SqlEvent>;

const LogEventSchema = objectOf({
  sequence: required(IntegerSchema),
  phase: required(keyOf(logPhases)),
  level: required(keyOf(logLevels)),
  values: required(listOf(SerializedValueSchema)),
  source: z.optional(TextSchema),
  line: z.optional(IntegerSchema),
}) satisfies z.ZodMiniType<LogEvent>;

const DisplayResultSchema = objectOf({
  label: required(TextSchema),
  values: required(listOf(SerializedValueSchema)),
  source: z.optional(TextSchema),
  line: z.optional(IntegerSchema),
}) satisfies z.ZodMiniType<DisplayResult>;

const RunEventSchema = taggedByType(
  unionByType(
    ["diagnostic", "sql", "log", "display"],
    [
      z.strictObject({
        type: z.literal("diagnostic"),
        sequence: required(IntegerSchema),
        payload: required(DiagnosticSchema),
      }),
      z.strictObject({ type: z.literal("sql"), sequence: required(IntegerSchema), payload: required(SqlEventSchema) }),
      z.strictObject({ type: z.literal("log"), sequence: required(IntegerSchema), payload: required(LogEventSchema) }),
      z.strictObject({
        type: z.literal("display"),
        sequence: required(IntegerSchema),
        payload: required(DisplayResultSchema),
      }),
    ],
  ),
) satisfies z.ZodMiniType<RunEvent>;

const RunTransactionSchema = objectOf({
  id: required(IntegerSchema),
  phase: required(keyOf(transactionPhases)),
  outcome: required(keyOf(transactionOutcomes)),
  writes: required(keyOf(transactionWrites)),
  statements: required(
    listOf(objectOf({ sequence: required(IntegerSchema), role: required(keyOf(transactionStatementRoles)) })),
  ),
  durationMs: required(FiniteNumberSchema),
  parent: z.optional(IntegerSchema),
  source: z.optional(TextSchema),
  line: z.optional(IntegerSchema),
  reason: z.optional(keyOf(transactionReasons)),
  error: z.optional(
    objectOf({
      name: required(TextSchema),
      message: required(TextSchema),
      source: z.optional(TextSchema),
      line: z.optional(IntegerSchema),
    }),
  ),
}) satisfies z.ZodMiniType<RunTransaction>;

const CleanupEvidenceSchema = objectOf({
  mode: required(keyOf(cleanupModes)),
  reason: z.optional(TextSchema),
}) satisfies z.ZodMiniType<CleanupEvidence>;

const TimingsSchema = recordOf(FiniteNumberSchema).check(
  z.superRefine((timings, payload) => {
    for (const key of Object.keys(timings)) {
      if (!Object.hasOwn(timingKeys, key)) {
        reportIssue(payload, { path: [key], code: "UNKNOWN_FIELD", message: `Unknown timing: ${key}.` });
      }
    }
  }),
);

const RecordedRunResultSchema = objectOf({
  version: required(oneOf([1])),
  target: required(TargetSchema),
  tuple: required(
    objectOf({
      id: required(TextSchema),
      target: required(TargetSchema),
      ormVersion: required(TextSchema),
      kitVersion: required(TextSchema),
    }),
  ),
  random: required(
    objectOf({
      effectiveSeed: required(IntegerSchema),
      source: required(oneOf(["provided", "derived", "generated"])),
      derivation: required(oneOf(["run-manifest-sha256-u32-v1", "crypto-u32-v1"])),
      generator: required(oneOf(["mulberry32-v1"])),
    }),
  ),
  phases: required(
    listOf(
      objectOf({
        phase: required(keyOf(executionPhases)),
        status: required(keyOf(phaseStatuses)),
        startedAt: z.optional(TextSchema),
        durationMs: z.optional(FiniteNumberSchema),
      }),
    ),
  ),
  diagnostics: required(listOf(DiagnosticSchema)),
  sql: required(listOf(SqlEventSchema)),
  logs: required(listOf(LogEventSchema)),
  value: required(SerializedValueSchema),
  displays: required(listOf(DisplayResultSchema)),
  events: required(listOf(RunEventSchema)),
  cleanupErrors: required(listOf(SerializedErrorSchema)),
  cleanup: required(objectOf({ guest: required(CleanupEvidenceSchema), database: required(CleanupEvidenceSchema) })),
  timings: required(TimingsSchema),
  ok: required(oneOf([true])),
  outcome: required(oneOf(["succeeded"])),
  transactions: z.optional(listOf(RunTransactionSchema)),
}) satisfies z.ZodMiniType<RecordedRunResult>;

const RecordedSidesSchema = listOf(RecordedRunResultSchema).check(
  z.superRefine(
    (sides, payload) => {
      if (Array.isArray(sides) && sides.length !== 2) {
        reportIssue(payload, {
          code: "INVALID_VALUE",
          message: `Expected the two sides' runs, but got ${sides.length}.`,
        });
      }
    },
    { when: () => true },
  ),
);

const RecordedGuestSchema = objectOf({
  imageId: required(
    refined<string>(
      (value) => typeof value === "string" && value.length > 0,
      withIssueCode("INVALID_VALUE", "Expected a guest image id."),
    ),
  ),
  lockDigest: required(
    refined<string>(
      (value) => typeof value === "string" && /^sha256-[a-f0-9]{64}$/.test(value),
      withIssueCode("INVALID_VALUE", "Expected a sha256- lock digest with 64 lowercase hex characters."),
    ),
  ),
}) satisfies z.ZodMiniType<RecordedGuest>;

/**
 * A recorded run
 *
 * One succeeded run, or both sides' in side order, with the guest each ran on, against a 64 character hex snapshot
 * digest. The size limit and the
 * recording version are checked by `safeParseRecordedRun` before the shape.
 */
export const RecordedRunSchema = z.pipe(
  objectOf({
    recordingVersion: required(oneOf([1])),
    snapshotDigest: required(
      refined<string>(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
        withIssueCode("INVALID_VALUE", "Expected a 64 character lowercase hex SHA-256 digest."),
      ),
    ),
    recordedAt: required(
      refined<string>(
        (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
        withIssueCode("INVALID_VALUE", "Expected an ISO 8601 time."),
      ),
    ),
    result: z.optional(RecordedRunResultSchema),
    sides: z.optional(RecordedSidesSchema),
    guests: required(listOf(RecordedGuestSchema)),
  }).check(
    z.superRefine(
      (recording, payload) => {
        if (Object.hasOwn(recording, "result") === Object.hasOwn(recording, "sides")) {
          reportIssue(payload, {
            code: "INVALID_VALUE",
            message: "Expected either result, for one version, or sides, for side by side.",
          });
        }
      },
      { when: (payload) => typeof payload.value === "object" && payload.value !== null },
    ),
  ),
  z.transform(({ result, sides, guests, ...envelope }, payload): RecordedRun => {
    const [firstSide, secondSide] = sides ?? [];
    const [firstGuest, secondGuest, ...extraGuests] = guests;
    const guestCount = result === undefined ? 2 : 1;

    if (guests.length !== guestCount || firstGuest === undefined || extraGuests.length > 0) {
      reportIssue(payload, {
        path: ["guests"],
        code: "INVALID_VALUE",
        message: `Expected the guest of each run, ${guestCount}, but got ${guests.length}.`,
      });

      return z.NEVER;
    }

    if (result !== undefined) {
      return { ...envelope, result, guests: [firstGuest] };
    }

    if (firstSide !== undefined && secondSide !== undefined && secondGuest !== undefined) {
      return { ...envelope, sides: [firstSide, secondSide], guests: [firstGuest, secondGuest] };
    }

    reportIssue(payload, {
      code: "INVALID_VALUE",
      message: "Expected either result, for one version, or sides, for side by side.",
    });

    return z.NEVER;
  }),
);

/** The `recordingVersion` field alone, read before the rest so a newer recording is told apart from a broken one. */
const RecordingVersionSchema = z.pipe(PlainObjectSchema, z.looseObject({ recordingVersion: z.optional(z.unknown()) }));

function toByteLength(json: string): number {
  return encoder.encode(json).byteLength;
}

function toRecordedRunIssues(issues: readonly z.core.$ZodIssue[]): RecordedRunIssue[] {
  const contractIssues: ContractIssue<RecordedRunIssue["code"]>[] = toContractIssues(issues, RECORDED_RUN_ISSUE_CODES);

  return contractIssues.slice(0, MAX_REPORTED_ISSUES);
}

/**
 * Validate a recorded run
 *
 * Accepts only succeeded runs, one or both sides', without their database description or query plans, against a 64 character hex snapshot
 * digest, whose JSON fits in `MAX_RECORDED_RUN_BYTES`. Reports unknown fields and at most 20 issues. Never throws
 * for invalid input; the recording it returns is a detached copy.
 */
export function safeParseRecordedRun(input: unknown): SafeParseRecordedRunResult {
  // Check the version first, so a newer recording is told apart from a broken one
  const version = RecordingVersionSchema.safeParse(input);

  if (version.success && Object.hasOwn(version.data, "recordingVersion") && version.data.recordingVersion !== 1) {
    return {
      success: false,
      issues: [{ path: ["recordingVersion"], code: "UNSUPPORTED_VERSION", message: "Expected recording version 1." }],
    };
  }

  // Check the size before walking the value
  let json: string;

  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    return {
      success: false,
      issues: [{ path: [], code: "INVALID_TYPE", message: "Expected a recording that serializes to JSON." }],
    };
  }

  if (toByteLength(json) > MAX_RECORDED_RUN_BYTES) {
    return {
      success: false,
      issues: [
        {
          path: [],
          code: "RECORDING_TOO_LARGE",
          message: `A recorded run must be at most ${MAX_RECORDED_RUN_BYTES / 1024} KiB of JSON.`,
        },
      ],
    };
  }

  // Check the shape
  const checked = RecordedRunSchema.safeParse(input);

  if (!checked.success) {
    return { success: false, issues: toRecordedRunIssues(checked.error.issues) };
  }

  // Check the detached copy too: a `toJSON` method can give it another shape than the input's
  const recording = RecordedRunSchema.safeParse(JSON.parse(json));

  if (!recording.success) {
    return { success: false, issues: toRecordedRunIssues(recording.error.issues) };
  }

  return { success: true, data: recording.data };
}

/**
 * Parse a recorded run
 *
 * Throws `RecordedRunValidationError` with every issue `safeParseRecordedRun` finds.
 */
export function parseRecordedRun(input: unknown): RecordedRun {
  const result = safeParseRecordedRun(input);

  if (!result.success) {
    throw new RecordedRunValidationError(result.issues);
  }

  return result.data;
}

/** What `createRecordedRun` made of a run. */
export type CreateRecordedRunResult =
  | { status: "recorded"; recording: RecordedRun }
  /** The run did not succeed, or its result is not one the runtime returns. */
  | { status: "unrecordable" }
  | { status: "too_large"; maxBytes: number };

function toRecordedRunResult(result: SucceededRunResult): RecordedRunResult {
  const { database: _database, queryPlans: _queryPlans, ...kept } = result;
  return kept;
}

/**
 * Create a recording of a succeeded run
 *
 * Takes the run of a one-version snapshot as `result`, or both runs of a side-by-side one as `sides`. Leaves out the
 * database description and query plans, which embeds never show. A run that did not succeed is `unrecordable`; one
 * whose recording passes `MAX_RECORDED_RUN_BYTES` is `too_large`.
 */
export function createRecordedRun({
  snapshotDigest: digest,
  recordedAt: time,
  ...ran
}: {
  snapshotDigest: string;
  recordedAt: string;
} & (
  | { result: RunResult; guests: readonly [RecordedGuest] }
  | { sides: readonly [RunResult, RunResult]; guests: readonly [RecordedGuest, RecordedGuest] }
)): CreateRecordedRunResult {
  const results: readonly RunResult[] = "sides" in ran ? ran.sides : [ran.result];
  const succeeded = results.filter((result): result is SucceededRunResult => result.outcome === "succeeded");

  if (succeeded.length !== results.length) {
    return { status: "unrecordable" };
  }

  const envelope = { recordingVersion: 1 as const, snapshotDigest: digest, recordedAt: time };
  const [first, second] = succeeded.map(toRecordedRunResult);
  const recording: RecordedRun | undefined =
    first === undefined
      ? undefined
      : "sides" in ran
        ? second === undefined
          ? undefined
          : { ...envelope, sides: [first, second], guests: ran.guests }
        : { ...envelope, result: first, guests: ran.guests };

  if (recording === undefined) {
    return { status: "unrecordable" };
  }

  const parsed = safeParseRecordedRun(recording);

  if (parsed.success) {
    return { status: "recorded", recording: parsed.data };
  }

  return parsed.issues.some((issue) => issue.code === "RECORDING_TOO_LARGE")
    ? { status: "too_large", maxBytes: MAX_RECORDED_RUN_BYTES }
    : { status: "unrecordable" };
}

/**
 * Get the guest a manifest runs on, as a recording stores it
 *
 * Its pair's image in its guest flavor, with that image's lock digest from the generated catalog. Returns `null` when
 * the catalog ships no such image.
 */
export function toRecordedGuest(manifest: Pick<RunManifest, "dependencies" | "guestFlavor">): RecordedGuest | null {
  const imageId = toGuestImageId({
    ormVersion: manifest.dependencies["drizzle-orm"],
    kitVersion: manifest.dependencies["drizzle-kit"],
    guestFlavor: resolveGuestFlavor(manifest),
  });
  const lockDigest = getGuestLockDigest(imageId);

  return lockDigest === null ? null : { imageId, lockDigest };
}

/**
 * Find the first guest of a recording that the catalog has replaced
 *
 * A guest is replaced when the catalog no longer ships its image, or ships it with another lock digest, as after a
 * companion refresh. Returns `null` when every run of the recording ran on a guest the catalog still ships.
 */
export function findReplacedGuest(recording: Pick<RecordedRun, "guests">): RecordedGuest | null {
  return recording.guests.find((guest) => getGuestLockDigest(guest.imageId) !== guest.lockDigest) ?? null;
}
