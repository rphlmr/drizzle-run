// A pattern match, not a parse: a reference it invents only loads one more package, so it leans towards
// over-matching. Doc comment lines are skipped, since their examples import packages the code never does.

const tripleSlashReference = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']/gm;
const moduleReference = /\b(?:from|import|require)\s*\(?\s*["']([^"'\s[\]{}()]+)["']/g;
const commentLine = /^\s*(?:\*|\/\/(?!\/)|\/\*).*$/gm;

/** The modules a file refers to: relative paths to resolve beside it, and bare package specifiers. */
export interface ModuleReferences {
  relative: readonly string[];
  bare: readonly string[];
}

/** List the module specifiers `content` imports, re-exports, requires or references, in first-seen order. */
export function listModuleReferences(content: string): ModuleReferences {
  const relative = new Set<string>();
  const bare = new Set<string>();
  const add = (specifier: string) => (isRelativeSpecifier(specifier) ? relative : bare).add(specifier);

  for (const [, kind, specifier] of content.matchAll(tripleSlashReference)) {
    if (kind === "path") {
      relative.add(specifier.startsWith(".") ? specifier : `./${specifier}`);
    } else {
      bare.add(specifier);
    }
  }

  for (const [, specifier] of content.replace(commentLine, "").matchAll(moduleReference)) {
    add(specifier);
  }

  return { relative: [...relative], bare: [...bare] };
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

const declarationExtensions = [".d.ts", ".ts", ".d.mts", ".mts", ".d.cts", ".cts"];
// An import may name the emitted file (`./a.js`) or, with `allowImportingTsExtensions`, the source (`./a.ts`); either
// resolves to the declaration file beside it. Longer extensions first, so `.d.ts` is not read as `.ts`.
const importToDeclarationExtensions: Readonly<Record<string, readonly string[]>> = {
  ".d.ts": [],
  ".d.mts": [],
  ".d.cts": [],
  ".js": [".d.ts", ".ts"],
  ".mjs": [".d.mts", ".mts"],
  ".cjs": [".d.cts", ".cts"],
  ".jsx": [".d.ts", ".tsx"],
  ".ts": [".d.ts"],
  ".mts": [".d.mts"],
  ".cts": [".d.cts"],
  ".tsx": [".d.ts"],
};

/**
 * List the virtual URIs a relative specifier can resolve to from `fromUri`, in TypeScript's lookup order
 *
 * The URIs are decoded: compare them with decoded file URIs. A specifier that leaves the virtual root resolves to none.
 */
export function listRelativeCandidates(fromUri: string, specifier: string): readonly string[] {
  const root = "file:///";
  const directory = decodeURIComponent(fromUri.slice(root.length)).split("/").slice(0, -1);
  const segments = [...directory];

  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return [];
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  const path = `${root}${segments.join("/")}`;
  const importExtension = Object.keys(importToDeclarationExtensions).find((extension) => path.endsWith(extension));
  const declarationsOfImport =
    importExtension === undefined
      ? []
      : (importToDeclarationExtensions[importExtension] ?? []).map(
          (extension) => `${path.slice(0, -importExtension.length)}${extension}`,
        );

  return [
    path,
    ...declarationsOfImport,
    ...declarationExtensions.map((extension) => `${path}${extension}`),
    ...declarationExtensions.map((extension) => `${path}/index${extension}`),
  ];
}
