import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = new URL(".", import.meta.url).pathname;
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const ALLOWED_DEPENDENCIES = ["es-toolkit", "zod"];

/** The optional peer, and the one folder that may import it: only the AI chat link's handshake runs on XState. */
const OPTIONAL_PEER = { name: "xstate", range: "^5.28.0", folder: "connect/" };

function isPackageSpecifier(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isAllowedSpecifier(specifier: string, relativePath: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    ALLOWED_DEPENDENCIES.some((dependency) => isPackageSpecifier(specifier, dependency)) ||
    (isPackageSpecifier(specifier, OPTIONAL_PEER.name) && relativePath.startsWith(OPTIONAL_PEER.folder))
  );
}

// Import and export statements at the start of a line, and dynamic imports. Anchoring at the line start skips
// source text inside string literals, such as a starter project's schema.
const MODULE_SPECIFIER =
  /^\s*(?:import|export)\b[^;"']*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm;

// Core must install and run where only manifests are written, such as a guide editor.
const FORBIDDEN_GLOBALS =
  /\b(?:fetch|indexedDB|localStorage|sessionStorage|document|window|Worker|WebAssembly)\b\s*[.(]/;

describe("core purity", () => {
  it("should depend on es-toolkit and zod only, with xstate as its one optional peer", () => {
    expect(Object.keys(packageManifest.dependencies ?? {})).toEqual(ALLOWED_DEPENDENCIES);
    expect(packageManifest.peerDependencies ?? {}).toEqual({ [OPTIONAL_PEER.name]: OPTIONAL_PEER.range });
    expect(packageManifest.peerDependenciesMeta ?? {}).toEqual({ [OPTIONAL_PEER.name]: { optional: true } });
  });

  it("should import only its own modules, es-toolkit, zod, and xstate in connect, and touch no storage, network, or DOM", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      const relativePath = relative(sourceRoot, file);

      for (const [, fromSpecifier, bareSpecifier, dynamicSpecifier] of source.matchAll(MODULE_SPECIFIER)) {
        const specifier = fromSpecifier ?? bareSpecifier ?? dynamicSpecifier ?? "";

        if (!isAllowedSpecifier(specifier, relativePath)) {
          offenders.push(`${relativePath} imports ${specifier}`);
        }
      }

      if (FORBIDDEN_GLOBALS.test(source)) {
        offenders.push(`${relativePath} uses ${FORBIDDEN_GLOBALS.exec(source)?.[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
