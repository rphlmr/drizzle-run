/** Reading helpers shared by the guide manifest and, later, other manifest kinds. */

/** Where an issue sits inside a manifest, as keys and indexes. */
export type IssuePath = readonly (string | number)[];

/**
 * Format an issue path for a message
 *
 * @example
 * formatIssuePath(["files", "schema.ts"]); // '$["files"]["schema.ts"]'
 * formatIssuePath(["steps", 0]); // '$["steps"][0]'
 */
export function formatIssuePath(path: IssuePath): string {
  return path.reduce<string>(
    (formatted, segment) =>
      typeof segment === "number" ? `${formatted}[${segment}]` : `${formatted}[${JSON.stringify(segment)}]`,
    "$",
  );
}

/** A plain object read from untrusted input. */
export type DataRecord = Record<string, unknown>;

/** Reports one issue; each manifest kind maps it to its own issue type. */
export type ReportIssue<Code extends string> = (path: IssuePath, code: Code, message: string) => void;

/** Report every field of `record` that is not in `knownFields`. */
export function checkKnownFields(
  record: DataRecord,
  knownFields: readonly string[],
  path: IssuePath,
  report: ReportIssue<"UNKNOWN_FIELD">,
): void {
  for (const field of Object.keys(record)) {
    if (!knownFields.includes(field)) {
      report([...path, field], "UNKNOWN_FIELD", `Unknown field: ${field}.`);
    }
  }
}

/** A lowercase slug: letters and digits in groups joined by single dashes, such as `01-transfer`. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Check that a project path is canonical
 *
 * A canonical path is relative, uses forward slashes, and has no empty, `.`, or `..` segment, NUL, or drive letter.
 */
export function isCanonicalProjectPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }

  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
