import { sha256Hex } from "../hash/sha256.ts";

/** What a cloud project's digest reads: the content that syncs, not its timestamps or local revision. */
export interface CloudProjectContent {
  name: unknown;
  manifest: unknown;
  trust?: unknown;
}

// JSON with every object's keys sorted, so the same content in another key order, such as a manifest re-parsed after
// a pull, gives the same text.
function toSortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        )
      : entry,
  );
}

/**
 * Get the digest a cloud project is compared by
 *
 * Hex SHA-256 of its name, manifest and trust as JSON with sorted keys. The page and the Worker compute it from the
 * same record, so an unchanged project is never sent twice, whatever order its keys come in. Timestamps and the local
 * revision are left out: they change without the content changing.
 */
export function digestCloudProject(record: CloudProjectContent): string {
  const content = toSortedJson({ name: record.name, manifest: record.manifest, trust: record.trust });

  return sha256Hex(content);
}
