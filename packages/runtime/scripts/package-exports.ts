/** The fields of a package's `package.json` that decide what it exports. */
export interface PackageExportsMetadata {
  name: string;
  version: string;
  exports?: unknown;
}

/** A specifier a pinned package version cannot serve, and why. */
export interface UnresolvedSpecifier {
  specifier: string;
  reason: string;
}

/**
 * Resolve a subpath through the wildcard patterns of an exports map
 *
 * Effect publishes its subpaths as `"./*": "./dist/*.js"`. The most specific pattern wins, as in Node. Returns the
 * export target with `*` replaced, or `undefined` when no pattern matches or the match is excluded with `null`.
 */
export function resolveExportPattern(exportsValue: Readonly<Record<string, unknown>>, subpath: string): unknown {
  const patterns = Object.keys(exportsValue)
    .filter((key) => key.split("*").length === 2)
    .toSorted((left, right) => right.indexOf("*") - left.indexOf("*"));

  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*");

    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const match = subpath.slice(prefix.length, subpath.length - suffix.length);
      const target = exportsValue[pattern];

      return target === null ? undefined : (JSON.parse(JSON.stringify(target).replaceAll("*", match)) as unknown);
    }
  }

  return undefined;
}

/** Whether an exports value maps subpaths, such as `"./value"`, rather than conditions for the package itself. */
function isSubpathExports(exportsValue: unknown): exportsValue is Readonly<Record<string, unknown>> {
  return (
    typeof exportsValue === "object" &&
    exportsValue !== null &&
    !Array.isArray(exportsValue) &&
    Object.keys(exportsValue).some((key) => key.startsWith("."))
  );
}

/** Get the exports subpath of a specifier, `.` for the package itself. */
function toSubpath(packageName: string, specifier: string): string {
  return specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
}

/**
 * Whether a package's exports map exposes a specifier
 *
 * An exact key or a wildcard pattern counts, unless it maps to `null`. A package without `exports` exposes every file,
 * so only its declaration lookup decides; a non-subpath exports value exposes only the package itself.
 */
export function isSpecifierExported(packageMetadata: PackageExportsMetadata, specifier: string): boolean {
  const exportsValue = packageMetadata.exports;
  const subpath = toSubpath(packageMetadata.name, specifier);

  if (exportsValue === undefined) {
    return true;
  }

  if (!isSubpathExports(exportsValue)) {
    return subpath === ".";
  }

  if (Object.hasOwn(exportsValue, subpath)) {
    return exportsValue[subpath] !== null;
  }

  return resolveExportPattern(exportsValue, subpath) !== undefined;
}

/**
 * Find the specifiers a pinned package version cannot serve
 *
 * Each one must be in the package's exports map and resolve to a declaration file through `resolveDeclaration`,
 * which throws when it finds none. Returns one problem per specifier that fails, in the given order; empty when every
 * specifier resolves.
 */
export function findUnresolvedSpecifiers({
  packageMetadata,
  specifiers,
  resolveDeclaration,
}: {
  packageMetadata: PackageExportsMetadata;
  specifiers: readonly string[];
  resolveDeclaration: (specifier: string) => string;
}): UnresolvedSpecifier[] {
  return specifiers.flatMap((specifier) => {
    if (!isSpecifierExported(packageMetadata, specifier)) {
      return [{ specifier, reason: `${packageMetadata.name}@${packageMetadata.version} does not export it` }];
    }

    try {
      resolveDeclaration(specifier);

      return [];
    } catch {
      return [
        { specifier, reason: `${packageMetadata.name}@${packageMetadata.version} has no declaration file for it` },
      ];
    }
  });
}
