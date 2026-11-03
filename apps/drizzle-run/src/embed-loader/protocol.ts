import { isPlainObject } from "es-toolkit";
import * as z from "zod/mini";

/** The protocol name every embed message carries, so unrelated postMessage traffic is ignored. */
export const EMBED_PROTOCOL = "drizzle-run-embed" as const;
/** The protocol version every embed message carries; a message with another version is rejected. */
export const EMBED_PROTOCOL_VERSION = 1 as const;
/** The largest size in bytes of a settled run's displays, serialized as JSON; the frame drops the displays past it. */
export const EMBED_MAX_RUN_DISPLAYS_BYTES = 64 * 1024;
/** The longest error message, in characters, a settled run carries; the frame truncates a longer one. */
export const EMBED_MAX_RUN_ERROR_LENGTH = 1000;
/**
 * The longest text, in characters, each field of a click-to-load preview takes
 *
 * `mountPlayground` throws for a longer one, so a preview builder cuts its text to fit. The title and description
 * match Drizzle Run's Community listing.
 */
export const EMBED_PREVIEW_LIMITS = {
  titleLength: 160,
  descriptionLength: 140,
  runtimeTextLength: 40,
} as const;

/**
 * Why the frame could not show the playground
 *
 * - `application_load`: the playground could not load, such as on a network failure. A retry may help.
 * - `initialization`: the runtime could not initialize in this page.
 * - `internal`: an unexpected error in the frame after the playground loaded.
 * - `not_found`: the shared link, example or guide step does not exist. A retry cannot help.
 * - `unopenable`: the playground exists, but this version of Drizzle Run cannot open it in an embed. A retry cannot
 *   help; the full playground says why.
 * - `unsupported_host`: the host page has an opaque (`"null"`) origin, such as a `file://` page or a sandboxed frame
 *   without `allow-same-origin`, so the frame cannot answer it. A retry cannot help. The loader also reports it itself,
 *   without loading the frame, when its own page has such an origin.
 *
 * A loader ignores a code it does not know, so a new code needs no new protocol version.
 */
export const EMBED_FRAME_ERROR_CODES = [
  "application_load",
  "initialization",
  "internal",
  "not_found",
  "unopenable",
  "unsupported_host",
] as const;

/** A code of {@link EMBED_FRAME_ERROR_CODES}. */
export type EmbedFrameErrorCode = (typeof EMBED_FRAME_ERROR_CODES)[number];

/** A per-attempt handshake token: 32 lowercase hex characters, passed to the frame in its URL hash. */
export type EmbedNonce = string;

/**
 * What an embed opens: a shared snapshot, or an official example
 *
 * An example with `step` opens that step of the example's guide, by step id.
 */
export type EmbedTarget =
  | { snapshotId: string; example?: never; step?: never }
  | { example: string; step?: string; snapshotId?: never };

/** The loader's answer to the frame's hello: what to open. */
export type EmbedConnectMessage = {
  protocol: typeof EMBED_PROTOCOL;
  version: typeof EMBED_PROTOCOL_VERSION;
  kind: "connect";
  nonce: EmbedNonce;
} & EmbedTarget;

/** The frame's first message, sent once its page loads, asking the loader to connect. */
export type EmbedHelloMessage = {
  protocol: typeof EMBED_PROTOCOL;
  version: typeof EMBED_PROTOCOL_VERSION;
  kind: "hello";
  nonce: EmbedNonce;
};

/**
 * What the frame can do in its page: run (`available`), show the author's recorded run because the page cannot run
 * it (`recorded`), or neither.
 */
export type EmbedCapabilityStatus = "available" | "recorded" | "embedding_context_unsupported" | "browser_unsupported";

/** A JSON value: how a settled run's display values travel to the host. */
export type EmbedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EmbedJsonValue[]
  | { readonly [key: string]: EmbedJsonValue };

/**
 * One `$.display` call of a settled run: its label, and its values in Drizzle Run's serialized form, such as
 * `{ type: "primitive", value: 1 }` or `{ type: "array", value: [...] }`.
 */
export type EmbedRunDisplay = {
  label: string;
  values: readonly EmbedJsonValue[];
};

/**
 * A small summary of a run that settled in the frame
 *
 * Its displays are bounded: past {@link EMBED_MAX_RUN_DISPLAYS_BYTES} of JSON, the frame drops the remaining displays
 * and sets `truncated`.
 */
export type EmbedRunSummary = {
  outcome: "succeeded" | "failed" | "cancelled";
  /** The side that ran, in the order of the share's sides; only in a side-by-side embed. */
  side?: 0 | 1;
  /** Why the run failed, up to {@link EMBED_MAX_RUN_ERROR_LENGTH} characters; only when it failed. */
  error?: string;
  displays: readonly EmbedRunDisplay[];
  /** `true` when displays were dropped to stay within {@link EMBED_MAX_RUN_DISPLAYS_BYTES}. */
  truncated: boolean;
};

/**
 * A message the frame sends after the handshake: ready, its capability, an error, or a settled run.
 */
export type EmbedFrameMessage =
  | {
      protocol: typeof EMBED_PROTOCOL;
      version: typeof EMBED_PROTOCOL_VERSION;
      kind: "ready";
      nonce: EmbedNonce;
    }
  | {
      protocol: typeof EMBED_PROTOCOL;
      version: typeof EMBED_PROTOCOL_VERSION;
      kind: "capability";
      nonce: EmbedNonce;
      status: EmbedCapabilityStatus;
    }
  | {
      protocol: typeof EMBED_PROTOCOL;
      version: typeof EMBED_PROTOCOL_VERSION;
      kind: "error";
      nonce: EmbedNonce;
      code: EmbedFrameErrorCode;
    }
  | {
      protocol: typeof EMBED_PROTOCOL;
      version: typeof EMBED_PROTOCOL_VERSION;
      kind: "run-settled";
      nonce: EmbedNonce;
      run: EmbedRunSummary;
    };

const noncePattern = /^[a-f0-9]{32}$/;
const snapshotIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
/** An example slug or a guide step id: lowercase words joined by hyphens. */
const slugPattern = /^(?=.{1,128}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Deep enough for any display value: each serialized level nests two JSON levels. */
const MAX_JSON_DEPTH = 160;

const SnapshotIdSchema = z.string().check(z.regex(snapshotIdPattern));
const SlugSchema = z.string().check(z.regex(slugPattern));
const SnapshotTargetSchema = z.object({
  snapshotId: SnapshotIdSchema,
  example: z.optional(z.undefined()),
  step: z.optional(z.undefined()),
});
const ExampleTargetSchema = z.object({
  snapshotId: z.optional(z.undefined()),
  example: SlugSchema,
  step: z.optional(SlugSchema),
});
const envelope = {
  protocol: z.literal(EMBED_PROTOCOL),
  version: z.literal(EMBED_PROTOCOL_VERSION),
  nonce: z.string().check(z.regex(noncePattern)),
};
const HelloMessageSchema = z.strictObject({
  ...envelope,
  kind: z.literal("hello"),
}) satisfies z.ZodMiniType<EmbedHelloMessage>;
const ConnectMessageSchema = z.union([
  z.strictObject({ ...envelope, kind: z.literal("connect"), snapshotId: SnapshotIdSchema }),
  z.strictObject({ ...envelope, kind: z.literal("connect"), example: SlugSchema, step: z.exactOptional(SlugSchema) }),
]) satisfies z.ZodMiniType<EmbedConnectMessage>;
const JsonValueSchema = z.custom<EmbedJsonValue>((value) => isJsonValue(value));
const RunDisplaySchema = z.strictObject({ label: z.string(), values: z.array(JsonValueSchema) });
const RunSummarySchema = z
  .strictObject({
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    side: z.exactOptional(z.union([z.literal(0), z.literal(1)])),
    error: z.exactOptional(z.string().check(z.maxLength(EMBED_MAX_RUN_ERROR_LENGTH))),
    displays: z
      .array(RunDisplaySchema)
      .check(z.refine((displays) => getEmbedJsonByteLength(displays) <= EMBED_MAX_RUN_DISPLAYS_BYTES)),
    truncated: z.boolean(),
  })
  .check(
    z.refine((run) => run.error === undefined || run.outcome === "failed"),
  ) satisfies z.ZodMiniType<EmbedRunSummary>;
const FrameMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("ready") }),
  z.strictObject({
    ...envelope,
    kind: z.literal("capability"),
    status: z.enum(["available", "recorded", "embedding_context_unsupported", "browser_unsupported"]),
  }),
  z.strictObject({ ...envelope, kind: z.literal("error"), code: z.enum(EMBED_FRAME_ERROR_CODES) }),
  z.strictObject({ ...envelope, kind: z.literal("run-settled"), run: RunSummarySchema }),
]) satisfies z.ZodMiniType<EmbedFrameMessage>;

/**
 * Read the target of a message or of loader options
 *
 * Reads `snapshotId`, or `example` with an optional `step`, and ignores other fields. Returns `null` when none of them
 * is valid, or when both kinds are present. The target it returns has exactly the fields it read.
 */
export function readEmbedTarget(value: Record<string, unknown>): EmbedTarget | null {
  const snapshot = SnapshotTargetSchema.safeParse(value);

  if (snapshot.success) {
    return { snapshotId: snapshot.data.snapshotId };
  }

  const example = ExampleTargetSchema.safeParse(value);

  if (!example.success) {
    return null;
  }

  const { example: slug, step } = example.data;

  return step === undefined ? { example: slug } : { example: slug, step };
}

/**
 * Get the address of the frame that opens a target
 *
 * @example
 * getEmbedFramePath({ example: "transactions", step: "02-savepoint" }); // "/embed/examples/transactions/02-savepoint"
 */
export function getEmbedFramePath(target: EmbedTarget): string {
  if (target.snapshotId !== undefined) {
    return `/embed/${target.snapshotId}`;
  }

  return `/embed/examples/${target.example}${target.step === undefined ? "" : `/${target.step}`}`;
}

/**
 * Get the address of the full playground for a target, where it runs in its own tab
 *
 * @example
 * getEmbedPlaygroundPath({ example: "transactions", step: "02-savepoint" }); // "/examples/transactions?step=02-savepoint"
 */
export function getEmbedPlaygroundPath(target: EmbedTarget): string {
  if (target.snapshotId !== undefined) {
    return `/s/${target.snapshotId}`;
  }

  return `/examples/${target.example}${target.step === undefined ? "" : `?step=${target.step}`}`;
}

/**
 * Parse a message the frame posted after the handshake
 *
 * Returns `null` for anything else: another protocol or version, a malformed nonce, an unknown kind, or extra keys.
 */
export function parseEmbedFrameMessage(value: unknown): EmbedFrameMessage | null {
  const parsed = FrameMessageSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * Get the size in bytes of a value serialized as JSON
 *
 * The frame bounds a settled run's displays with it, and the loader checks them with it.
 */
export function getEmbedJsonByteLength(value: EmbedJsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isJsonValue(value: unknown, depth = 0): value is EmbedJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (depth >= MAX_JSON_DEPTH) {
    return false;
  }

  const items = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : null;

  return items !== null && items.every((item) => isJsonValue(item, depth + 1));
}

/**
 * Parse the frame's hello message
 *
 * Returns `null` for any other message, a malformed nonce, or extra keys.
 */
export function parseEmbedHelloMessage(value: unknown): EmbedHelloMessage | null {
  const parsed = HelloMessageSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * Parse the loader's connect message, on the frame side
 *
 * Returns `null` for any other message, a malformed nonce or target, or extra keys.
 */
export function parseEmbedConnectMessage(value: unknown): EmbedConnectMessage | null {
  const parsed = ConnectMessageSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
