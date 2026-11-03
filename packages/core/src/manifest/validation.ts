import { formatIssuePath } from "../shared/records.ts";
import { toContractIssues } from "../shared/schema.ts";
import { RUN_MANIFEST_ISSUE_CODES, RunManifestSchema } from "./schema.ts";
import type { RunManifest, RunManifestIssue, SafeParseRunManifestResult } from "./types.ts";

export { MAX_RUN_ENV_BYTES, MAX_RUN_FILES, MAX_RUN_SOURCE_BYTES } from "./schema.ts";

/**
 * Validate a run manifest
 *
 * Checks every field, the pinned pair against the catalog, file paths and extensions, entrypoints, and the size
 * limits. Returns every issue found instead of throwing.
 */
export function safeParseRunManifest(input: unknown): SafeParseRunManifestResult {
  const result = RunManifestSchema.safeParse(input);

  if (!result.success) {
    const issues: RunManifestIssue[] = toContractIssues(result.error.issues, RUN_MANIFEST_ISSUE_CODES);

    return { success: false, issues };
  }

  return { success: true, data: result.data };
}

/** Thrown by `parseRunManifest` with every issue found, one per message line. */
export class RunManifestValidationError extends TypeError {
  readonly issues: readonly RunManifestIssue[];

  constructor(issues: readonly RunManifestIssue[]) {
    super(issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"));
    this.name = "RunManifestValidationError";
    this.issues = issues;
  }
}

/**
 * Parse a run manifest
 *
 * Throws `RunManifestValidationError` with every issue `safeParseRunManifest` finds.
 */
export function parseRunManifest(input: unknown): RunManifest {
  const result = safeParseRunManifest(input);

  if (!result.success) {
    throw new RunManifestValidationError(result.issues);
  }

  return result.data;
}
