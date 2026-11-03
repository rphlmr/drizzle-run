import { DIALECT_IDS, GUEST_FLAVORS, resolveGuestFlavor } from "@drizzle-run/core/catalog";
import type { PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import type { PairSide } from "@drizzle-run/core/pair";
import * as z from "zod/mini";

// The seed script imports this file with Node's type stripping, so it keeps to package imports.

const textEncoder = new TextEncoder();

const SnapshotPairSchema = z.object({
  dialect: z.enum(DIALECT_IDS),
  orm: z.string(),
  kit: z.string(),
  guestFlavor: z.enum(GUEST_FLAVORS),
  name: z.optional(z.string()),
});

/** The database, ORM and Kit versions and guest flavor a snapshot (or one of its sides) runs, and a side's name. */
export type SnapshotPair = z.output<typeof SnapshotPairSchema>;

const SnapshotPairsSchema = z.union([z.tuple([SnapshotPairSchema]), z.tuple([SnapshotPairSchema, SnapshotPairSchema])]);

const SnapshotSummaryJsonSchema = z.object({
  name: z.string(),
  pairs: SnapshotPairsSchema,
  files: z.record(z.string(), z.string()),
});

/**
 * The view of one snapshot that its Community listing and link preview read
 *
 * Its name, the pair of each side (one for a run, two for a side by side), and a SHA-256 digest per file path.
 */
export type SnapshotSummaryJson = z.output<typeof SnapshotSummaryJsonSchema>;

/**
 * The summary of a snapshot, stored beside it at publish
 *
 * Lets Community and link previews read the snapshot's name, pairs and files without loading the payload.
 */
export async function toSnapshotSummaryJson(snapshot: PlaygroundSnapshot): Promise<string> {
  const fileDigests = await Promise.all(
    Object.entries(toSummaryFiles(snapshot)).map(async ([path, content]) => [path, await digestText(content)] as const),
  );
  const summary: SnapshotSummaryJson = {
    name: snapshot.name,
    pairs: toSnapshotPairs(snapshot),
    files: Object.fromEntries(fileDigests),
  };

  return JSON.stringify(summary);
}

/** A summary `toSnapshotSummaryJson` wrote; throws when it does not read, since only this Worker writes it. */
export function readSnapshotSummary(summaryJson: string): SnapshotSummaryJson {
  return SnapshotSummaryJsonSchema.parse(JSON.parse(summaryJson));
}

/** The `pairs` of a summary `toSnapshotSummaryJson` wrote, as JSON; throws when they do not read. */
export function readSnapshotPairs(pairsJson: string): SnapshotSummaryJson["pairs"] {
  return SnapshotPairsSchema.parse(JSON.parse(pairsJson));
}

/** The files a snapshot's summary digests: a side-by-side snapshot's per-side file counts both copies as one. */
function toSummaryFiles(snapshot: PlaygroundSnapshot): Record<string, string> {
  const { manifest } = snapshot;
  const files: Record<string, string> = { ...manifest.files };

  if (!("sides" in manifest)) {
    return files;
  }

  const sideFiles = manifest.sides.map((side) => side.files);
  const perSidePaths = new Set(sideFiles.flatMap((side) => Object.keys(side)));

  for (const path of perSidePaths) {
    files[path] = JSON.stringify(sideFiles.map((side) => side[path] ?? null));
  }

  return files;
}

function toSnapshotPairs({ manifest }: PlaygroundSnapshot): SnapshotSummaryJson["pairs"] {
  if (!("sides" in manifest)) {
    return [toSnapshotPair(manifest)];
  }

  const [left, right] = manifest.sides;

  return [toSnapshotPair(left), toSnapshotPair(right)];
}

function toSnapshotPair(side: Pick<PairSide, "name" | "target" | "dependencies" | "guestFlavor">): SnapshotPair {
  return {
    dialect: side.target.dialect,
    orm: side.dependencies["drizzle-orm"],
    kit: side.dependencies["drizzle-kit"],
    guestFlavor: resolveGuestFlavor(side),
    ...(side.name === undefined ? {} : { name: side.name }),
  };
}

async function digestText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
