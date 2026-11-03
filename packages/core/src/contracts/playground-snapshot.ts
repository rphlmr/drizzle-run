import * as z from "zod/mini";

import { sha256Hex } from "../hash/sha256.ts";
import { findRetiredPair, type RetiredPair } from "../manifest/retired-pair.ts";
import { RUN_MANIFEST_ISSUE_CODES } from "../manifest/schema.ts";
import type { RunManifest, RunManifestIssue } from "../manifest/types.ts";
import { safeParseRunManifest } from "../manifest/validation.ts";
import type { PairManifest } from "../pair/types.ts";
import {
  findInPlacePairRelease,
  findRetiredPairSides,
  isPairManifestLike,
  safeParsePairManifest,
} from "../pair/validation.ts";
import { formatIssuePath } from "../shared/records.ts";
import { DataRecordSchema, refined, reportIssue, toContractIssues, withIssueCode } from "../shared/schema.ts";

/** Largest canonical snapshot JSON, in UTF-8 bytes. */
export const MAX_PLAYGROUND_SNAPSHOT_BYTES = 1024 * 1024;

/** A shared project: one version (a run manifest) or side by side (a pair manifest). */
export interface PlaygroundSnapshot<Manifest extends RunManifest | PairManifest = RunManifest | PairManifest> {
  snapshotVersion: 1;
  name: string;
  manifest: Manifest;
}

/** One problem found in a snapshot, at a path inside it. */
export type PlaygroundSnapshotIssue = Omit<RunManifestIssue, "code"> & {
  code: RunManifestIssue["code"] | "UNSUPPORTED_VERSION" | "SNAPSHOT_TOO_LARGE";
};

/** The result of `safeParsePlaygroundSnapshot`: the snapshot, or every issue found. */
export type SafeParsePlaygroundSnapshotResult =
  | { success: true; data: PlaygroundSnapshot }
  | { success: false; issues: readonly PlaygroundSnapshotIssue[] };

const encoder = new TextEncoder();

const SNAPSHOT_TOO_LARGE_MESSAGE = "Playground snapshot exceeds the 1 MiB serialized JSON limit.";

/** Canonical JSON written so far, and its size in UTF-8 bytes. */
interface CanonicalJsonWriter {
  chunks: string[];
  byteLength: number;
}

/** Throws a `RangeError` once the written JSON passes `MAX_PLAYGROUND_SNAPSHOT_BYTES`. */
function appendChunk(writer: CanonicalJsonWriter, chunk: string, chunkBytes: number): void {
  writer.byteLength += chunkBytes;

  if (writer.byteLength > MAX_PLAYGROUND_SNAPSHOT_BYTES) {
    throw new RangeError(SNAPSHOT_TOO_LARGE_MESSAGE);
  }

  writer.chunks.push(chunk);
}

/** Punctuation is ASCII, so its length is its byte count. */
function appendPunctuation(writer: CanonicalJsonWriter, punctuation: string): void {
  appendChunk(writer, punctuation, punctuation.length);
}

function appendJsonString(writer: CanonicalJsonWriter, value: string): void {
  // Each character takes at least one byte, so a longer string cannot fit; skip encoding it.
  if (value.length > MAX_PLAYGROUND_SNAPSHOT_BYTES) {
    throw new RangeError(SNAPSHOT_TOO_LARGE_MESSAGE);
  }

  const encoded = JSON.stringify(value);

  appendChunk(writer, encoded, encoder.encode(encoded).byteLength);
}

/** Writes JSON with object keys sorted and `undefined` fields dropped, so equal values give equal text. */
function appendCanonical(writer: CanonicalJsonWriter, value: unknown): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    const encoded = JSON.stringify(value);

    appendChunk(writer, encoded, encoder.encode(encoded).byteLength);
    return;
  }

  if (typeof value === "string") {
    appendJsonString(writer, value);
    return;
  }

  if (Array.isArray(value)) {
    appendPunctuation(writer, "[");

    for (const [index, entry] of value.entries()) {
      if (index > 0) {
        appendPunctuation(writer, ",");
      }

      appendCanonical(writer, entry);
    }

    appendPunctuation(writer, "]");
    return;
  }

  if (typeof value === "object" && value !== null) {
    const fields: [string, unknown][] = Object.entries(value);
    const entries = fields
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    appendPunctuation(writer, "{");

    for (const [index, [key, entry]] of entries.entries()) {
      if (index > 0) {
        appendPunctuation(writer, ",");
      }

      appendJsonString(writer, key);
      appendPunctuation(writer, ":");
      appendCanonical(writer, entry);
    }

    appendPunctuation(writer, "}");
    return;
  }

  throw new TypeError(`Cannot canonicalize ${typeof value}.`);
}

function toCanonicalJson(value: unknown): string {
  const writer: CanonicalJsonWriter = { chunks: [], byteLength: 0 };

  appendCanonical(writer, value);

  return writer.chunks.join("");
}

/** The issue codes a snapshot reports beyond the base ones. */
const PLAYGROUND_SNAPSHOT_ISSUE_CODES = [
  ...RUN_MANIFEST_ISSUE_CODES,
  "UNSUPPORTED_VERSION",
  "SNAPSHOT_TOO_LARGE",
] as const satisfies readonly PlaygroundSnapshotIssue["code"][];

/** A plain object with enumerable string-keyed data fields only, reported as one issue otherwise. */
const SnapshotRecordSchema = z.pipe(
  refined<object>(
    (value) => DataRecordSchema.safeParse(value).success,
    withIssueCode("INVALID_TYPE", "Expected a plain snapshot object."),
  ),
  DataRecordSchema,
);

const SnapshotNameSchema = z
  .string({ error: "Snapshot name must be text." })
  .check(z.refine((name) => name.trim().length > 0, { error: "Snapshot name cannot be empty." }));

/** A one-version or side-by-side manifest, with its issues under the snapshot's `manifest` field. */
const SnapshotManifestSchema = z.transform((manifest: unknown, payload): RunManifest | PairManifest => {
  let result: ReturnType<typeof safeParsePairManifest> | ReturnType<typeof safeParseRunManifest>;

  try {
    result = isPairManifestLike(manifest) ? safeParsePairManifest(manifest) : safeParseRunManifest(manifest);
  } catch {
    reportIssue(payload, { code: "INVALID_VALUE", message: "Manifest could not be parsed." });

    return z.NEVER;
  }

  if (result.success) {
    return result.data;
  }

  for (const issue of result.issues) {
    reportIssue(payload, issue);
  }

  return z.NEVER;
});

/** Check that the snapshot's canonical JSON fits in `MAX_PLAYGROUND_SNAPSHOT_BYTES`. */
function checkSnapshotSize(
  snapshot: PlaygroundSnapshot,
  payload: { issues: z.core.$ZodRawIssue[]; value: unknown },
): void {
  try {
    toCanonicalJson(snapshot);
  } catch (cause) {
    if (!(cause instanceof RangeError)) {
      throw cause;
    }

    reportIssue(payload, { code: "SNAPSHOT_TOO_LARGE", message: cause.message });
  }
}

/**
 * A shared project snapshot
 *
 * Holds a run or pair manifest, reports unknown fields, and fails with `SNAPSHOT_TOO_LARGE` alone when its canonical
 * JSON passes `MAX_PLAYGROUND_SNAPSHOT_BYTES`.
 */
export const PlaygroundSnapshotSchema = z.pipe(
  z.pipe(
    SnapshotRecordSchema,
    z.strictObject({
      snapshotVersion: z.literal(1, { error: "Expected snapshot version 1." }),
      name: SnapshotNameSchema,
      manifest: SnapshotManifestSchema,
    }),
  ),
  z.transform(({ name, manifest }, payload): PlaygroundSnapshot => {
    const snapshot: PlaygroundSnapshot = { snapshotVersion: 1, name, manifest };

    checkSnapshotSize(snapshot, payload);

    return snapshot;
  }),
);

/**
 * A published snapshot whose manifest is read as plain data, so a retired pair can still be found in it
 *
 * Its digest is computed over the manifest exactly as published.
 */
export const RetiredPairSnapshotSchema = z.pipe(
  SnapshotRecordSchema,
  z.strictObject({
    snapshotVersion: z.literal(1),
    name: SnapshotNameSchema,
    manifest: DataRecordSchema,
  }),
);

/** Thrown by `parsePlaygroundSnapshot` with every issue found, one per message line. */
export class PlaygroundSnapshotValidationError extends TypeError {
  readonly issues: readonly PlaygroundSnapshotIssue[];

  constructor(issues: readonly PlaygroundSnapshotIssue[]) {
    super(issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"));
    this.name = "PlaygroundSnapshotValidationError";
    this.issues = issues;
  }
}

/**
 * Validate a shared project snapshot
 *
 * Accepts a run or pair manifest, reports unknown fields, and fails with `SNAPSHOT_TOO_LARGE` when its canonical JSON
 * passes `MAX_PLAYGROUND_SNAPSHOT_BYTES`. Never throws for invalid input.
 */
export function safeParsePlaygroundSnapshot(input: unknown): SafeParsePlaygroundSnapshotResult {
  const result = PlaygroundSnapshotSchema.safeParse(input);

  if (!result.success) {
    return { success: false, issues: toContractIssues(result.error.issues, PLAYGROUND_SNAPSHOT_ISSUE_CODES) };
  }

  return { success: true, data: result.data };
}

/**
 * Parse a shared project snapshot
 *
 * Throws `PlaygroundSnapshotValidationError` with every issue `safeParsePlaygroundSnapshot` finds.
 */
export function parsePlaygroundSnapshot(input: unknown): PlaygroundSnapshot {
  const result = safeParsePlaygroundSnapshot(input);

  if (!result.success) {
    throw new PlaygroundSnapshotValidationError(result.issues);
  }

  return result.data;
}

/**
 * Get a snapshot's canonical JSON
 *
 * Keys are sorted and `undefined` fields dropped, so equal snapshots give equal text. Throws
 * `PlaygroundSnapshotValidationError` when the snapshot is invalid.
 */
export function canonicalPlaygroundSnapshot(input: PlaygroundSnapshot): string {
  return toCanonicalJson(parsePlaygroundSnapshot(input));
}

/**
 * Get a snapshot's SHA-256 digest
 *
 * Hex digest of its canonical JSON. Throws `PlaygroundSnapshotValidationError` when the snapshot is invalid.
 */
export function digestPlaygroundSnapshot(input: PlaygroundSnapshot): string {
  return sha256Hex(canonicalPlaygroundSnapshot(input));
}

/** A snapshot ready to store: validated once, with its canonical JSON and that JSON's SHA-256 hex digest. */
export interface PublishedPlaygroundSnapshot {
  snapshot: PlaygroundSnapshot;
  canonicalJson: string;
  digest: string;
}

/**
 * Parse a snapshot to publish
 *
 * Validates the input once and serializes the result, where `canonicalPlaygroundSnapshot` and
 * `digestPlaygroundSnapshot` each validate again. Throws `PlaygroundSnapshotValidationError` with every issue
 * `safeParsePlaygroundSnapshot` finds.
 */
export function parsePublishedPlaygroundSnapshot(input: unknown): PublishedPlaygroundSnapshot {
  const snapshot = parsePlaygroundSnapshot(input);
  const canonicalJson = toCanonicalJson(snapshot);

  return { snapshot, canonicalJson, digest: sha256Hex(canonicalJson) };
}

/**
 * A published snapshot whose ORM/Kit pair the catalog no longer ships. Its
 * manifest stays exactly as published (valid except for the pair), so its
 * digest still matches the stored one.
 */
export type RetiredPairSnapshot = z.output<typeof RetiredPairSnapshotSchema>;

/**
 * Find a snapshot whose only problem is a retired pair
 *
 * Recognizes a snapshot that only needs a supported pair to open; undefined for anything else, including a snapshot
 * past the size limit. A side by side counts when a side is on an older Legacy version, which follows the Legacy pair
 * in place, or on a removed pair that needs a choice (`findRetiredPairSides` lists each one): its pair is that side's.
 */
export function findRetiredPairSnapshot(
  input: unknown,
): { snapshot: RetiredPairSnapshot; retiredPair: RetiredPair } | undefined {
  const parsed = RetiredPairSnapshotSchema.safeParse(input);

  if (!parsed.success) {
    return undefined;
  }

  const snapshot = parsed.data;
  const retiredPair = isPairManifestLike(snapshot.manifest)
    ? (findInPlacePairRelease(snapshot.manifest) ?? findFirstRetiredSidePair(snapshot.manifest))
    : findRetiredPair(snapshot.manifest);

  try {
    toCanonicalJson(snapshot);
  } catch {
    return undefined;
  }

  return retiredPair === undefined ? undefined : { snapshot, retiredPair };
}

function findFirstRetiredSidePair(manifest: unknown): RetiredPair | undefined {
  const [retiredSide] = findRetiredPairSides(manifest) ?? [];

  if (retiredSide === undefined) {
    return undefined;
  }

  const { target, releaseLine, ormVersion, kitVersion } = retiredSide;

  return { target, releaseLine, ormVersion, kitVersion };
}

/** Get a retired-pair snapshot's canonical JSON, as published. */
export function canonicalRetiredPairSnapshot(input: RetiredPairSnapshot): string {
  return toCanonicalJson(input);
}

/** Get a retired-pair snapshot's SHA-256 digest, which matches the one stored when it was published. */
export function digestRetiredPairSnapshot(input: RetiredPairSnapshot): string {
  return sha256Hex(canonicalRetiredPairSnapshot(input));
}
