import { isShippedSpecifier, resolveApprovedModule } from "../registry/approved-modules.ts";
import { resolveGuestFlavor, type GuestSelection } from "../registry/guest-images.ts";
import { resolveSupportedTuple } from "../registry/selectors.ts";
import type { RunManifest } from "./types.ts";

const CODE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

// `import x from "a"`, `import "a"`, `import type { X } from "a"`, `export * from "a"` and `export { x } from "a"`.
const STATIC_IMPORT_PATTERN =
  /\b(?:import|export)\b[\s\w$*{},]*?\bfrom\s*(["'])([^"'\n]+)\1|\bimport\s*(["'])([^"'\n]+)\3/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/**
 * Blank out comments and track positions outside string literals
 *
 * Every comment character becomes a space. Strings retain their positions so specifiers can be read, but a match
 * must start outside them. Template text is skipped while `${}` expressions are scanned as code.
 */
function stripComments(source: string): { code: string; syntaxOffsets: ReadonlySet<number> } {
  let result = "";
  let index = 0;
  const syntaxOffsets = new Set<number>();
  const frames: ({ type: "template" } | { type: "code"; braceDepth: number })[] = [{ type: "code", braceDepth: 0 }];

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    const frame = frames.at(-1);

    if (frame === undefined) {
      break;
    }

    if (frame.type === "template") {
      if (char === "\\") {
        result += source.slice(index, index + 2);
        index += 2;
        continue;
      }

      if (char === "`") {
        frames.pop();
      } else if (char === "$" && next === "{") {
        frames.push({ type: "code", braceDepth: 0 });
        result += "${";
        index += 2;
        continue;
      }

      result += char;
      index += 1;
      continue;
    }

    if (char === "`") {
      frames.push({ type: "template" });
      result += char;
      index += 1;
      continue;
    }

    if (char === "{") {
      frame.braceDepth += 1;
    } else if (char === "}") {
      if (frame.braceDepth === 0 && frames.length > 1) {
        frames.pop();
      } else {
        frame.braceDepth -= 1;
      }
    }

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;

      result += " ".repeat(stop - index);
      index = stop;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;

      result += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }

    if (char === '"' || char === "'") {
      let stop = index + 1;

      while (stop < source.length && source[stop] !== char) {
        stop += source[stop] === "\\" ? 2 : 1;
      }

      result += source.slice(index, stop + 1);
      index = stop + 1;
      continue;
    }

    if (char === "i" || char === "e") {
      syntaxOffsets.add(index);
    }

    result += char;
    index += 1;
  }

  return { code: result, syntaxOffsets };
}

/** Whether a specifier names a package rather than a project file or a URL. */
function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
}

/**
 * List the packages a project's code files import
 *
 * Reads static, type-only, re-export and dynamic imports with a string specifier from every code file, skipping
 * comments, relative imports and URLs. Returns each specifier once, sorted.
 */
export function listProjectImports(files: Readonly<Record<string, string>>): string[] {
  const specifiers = new Set<string>();

  for (const [path, source] of Object.entries(files)) {
    if (!CODE_FILE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      continue;
    }

    const { code, syntaxOffsets } = stripComments(source);

    for (const match of code.matchAll(STATIC_IMPORT_PATTERN)) {
      if (syntaxOffsets.has(match.index)) {
        specifiers.add(match[2] ?? match[4] ?? "");
      }
    }

    for (const match of code.matchAll(DYNAMIC_IMPORT_PATTERN)) {
      if (syntaxOffsets.has(match.index)) {
        specifiers.add(match[2] ?? "");
      }
    }
  }

  return [...specifiers].filter((specifier) => specifier !== "" && isPackageSpecifier(specifier)).toSorted();
}

/**
 * Find the imports a guest cannot serve
 *
 * The specifiers another guest for the same database ships but this one does not, such as `drizzle-zod` on Next or
 * `effect` on a slim guest. A specifier no guest ships, such as a typo, is left to the compiler. Keeps the given order.
 */
export function findUnavailableImports(specifiers: readonly string[], guest: GuestSelection): string[] {
  return specifiers.filter(
    (specifier) =>
      resolveApprovedModule(guest, specifier) === undefined && isShippedSpecifier(guest.tuple.target, specifier),
  );
}

/** Join names as prose: "a", "a and b", "a, b and c". */
function formatNames(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Describe imports a guest cannot serve
 *
 * Such as "drizzle-zod is not available with orm 1.0.0-rc.5 · kit 1.0.0-rc.5. Pick another release.", naming the
 * Effect flavor when the guest is one.
 */
export function describeUnavailableImports(specifiers: readonly string[], guest: GuestSelection): string {
  const { tuple, guestFlavor } = guest;
  const release = `orm ${tuple.ormVersion} · kit ${tuple.kitVersion}${guestFlavor === "effect" ? " with Effect" : ""}`;

  return `${formatNames(specifiers)} ${specifiers.length === 1 ? "is" : "are"} not available with ${release}. Pick another release.`;
}

/**
 * Assert that a manifest's guest serves every package its files import
 *
 * Reads the guest from the manifest's pair and `guestFlavor`. Throws with `describeUnavailableImports` when it does
 * not, so a move to a pair that cannot run the files fails up front instead of at the next compile.
 */
export function assertImportsAvailable(manifest: RunManifest): void {
  const guest = {
    tuple: resolveSupportedTuple({
      target: manifest.target,
      ormVersion: manifest.dependencies["drizzle-orm"],
      kitVersion: manifest.dependencies["drizzle-kit"],
    }),
    guestFlavor: resolveGuestFlavor(manifest),
  };
  const unavailable = findUnavailableImports(listProjectImports(manifest.files), guest);

  if (unavailable.length > 0) {
    throw new Error(describeUnavailableImports(unavailable, guest));
  }
}
