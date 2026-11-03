/** A value as JSON writes it: what a definition in source and its parsed form are compared as. */
function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? "null");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPathText(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (text, part) => (typeof part === "number" ? `${text}[${part}]` : text === "" ? part : `${text}.${part}`),
    "",
  );
}

/**
 * Find the first place where a parsed value differs from what was written
 *
 * Parsing leaves out `guestFlavor: "slim"`, the default, so a definition that spells it out still matches. Returns
 * `undefined` when both are the same, or the path of the first difference, such as `sides[0].dependencies`.
 */
function findChangedPath(
  written: unknown,
  parsed: unknown,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | undefined {
  if (Array.isArray(written) && Array.isArray(parsed)) {
    if (written.length !== parsed.length) {
      return path;
    }

    for (const [index, item] of written.entries()) {
      const changed = findChangedPath(item, parsed[index], [...path, index]);

      if (changed !== undefined) {
        return changed;
      }
    }

    return undefined;
  }

  if (isPlainObject(written) && isPlainObject(parsed)) {
    const keys = [...new Set([...Object.keys(written), ...Object.keys(parsed)])].toSorted();

    for (const key of keys) {
      const isDefaultFlavor = key === "guestFlavor" && written[key] === "slim" && !Object.hasOwn(parsed, key);

      if (isDefaultFlavor) {
        continue;
      }

      const changed = findChangedPath(written[key], parsed[key], [...path, key]);

      if (changed !== undefined) {
        return changed;
      }
    }

    return undefined;
  }

  return Object.is(written, parsed) ? undefined : path;
}

/**
 * Assert that a manifest defined in source parses to itself
 *
 * Parsing follows an older Legacy fix release to the current one, so a definition pinned to one would return values
 * that differ from what runs. Normal forms parsing leaves out, such as `guestFlavor: "slim"`, still match. `kind`
 * names the manifest in the message, such as "guide", with the first path that changed.
 */
export function assertParsedAsWritten(definition: unknown, parsed: unknown, kind: string): void {
  const changed = findChangedPath(toJsonValue(definition), toJsonValue(parsed));

  if (changed === undefined) {
    return;
  }

  const where = changed.length === 0 ? "" : ` at ${toPathText(changed)}`;
  // A pin, such as `project.dependencies.drizzle-orm`; a `meta` field of that name is the author's own data.
  const changedPin = changed.at(-2) === "dependencies" && !changed.includes("meta");
  const hint = changedPin
    ? "most likely because it pins an older Legacy fix release. Pin the release it is parsed to."
    : "so it runs differently from what is written. Write it as it parses.";

  throw new Error(`This ${kind} manifest changes when parsed${where}, ${hint}`);
}
