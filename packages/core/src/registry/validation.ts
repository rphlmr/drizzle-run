import type { ApprovedModuleEntry } from "./types.ts";

/** A mismatch between an approved module's runtime artifact, its types, or another module's specifiers. */
export interface RegistryValidationIssue {
  code: "MISSING_RUNTIME" | "MISSING_TYPES" | "DUPLICATE_SPECIFIER";
  message: string;
}

/**
 * Check that every user-visible approved module has both a runtime and types
 *
 * Also reports a specifier owned by two modules in the same tuple. Internal modules are skipped. Returns an empty
 * array when the registry is consistent.
 */
export function validateRuntimeTypeSymmetry(
  entries: readonly ApprovedModuleEntry[],
): readonly RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  const ownerBySpecifierKey = new Map<string, string>();

  for (const entry of entries) {
    if (entry.visibility !== "user") {
      continue;
    }

    const moduleId = `${entry.packageName}@${entry.version}`;

    if (entry.allowedSpecifiers.length > 0 && entry.runtimeArtifact.id.length === 0) {
      issues.push({
        code: "MISSING_RUNTIME",
        message: `${moduleId} has no runtime artifact`,
      });
    }

    if (
      entry.allowedSpecifiers.length > 0 &&
      (entry.types.closureArtifact.id.length === 0 ||
        entry.types.declarationRoot.length === 0 ||
        entry.types.virtualPaths.length !== entry.allowedSpecifiers.length)
    ) {
      issues.push({
        code: "MISSING_TYPES",
        message: `${moduleId} has no type closure`,
      });
    }

    for (const tupleId of entry.tupleIds) {
      for (const specifier of entry.allowedSpecifiers) {
        const specifierKey = `${tupleId}:${specifier}`;
        const previousOwner = ownerBySpecifierKey.get(specifierKey);

        if (previousOwner !== undefined && previousOwner !== moduleId) {
          issues.push({
            code: "DUPLICATE_SPECIFIER",
            message: `${specifier} has two owners for ${tupleId}: ${previousOwner} and ${moduleId}`,
          });
        }

        ownerBySpecifierKey.set(specifierKey, moduleId);
      }
    }
  }

  return issues;
}
