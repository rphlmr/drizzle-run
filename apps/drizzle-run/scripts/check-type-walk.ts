import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GUEST_FLAVORS,
  type GuestFlavor,
  type SupportedRuntimeTuple,
  hasGuestFlavor,
  listSupportedTuples,
} from "@drizzle-run/core/catalog";
import { type RunManifest, parseRunManifest } from "@drizzle-run/core/manifest";
import { listApprovedModules } from "@drizzle-run/core/registry";
import { type ProjectTypeEnvironment, createProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";

interface TypeScriptCompiler {
  ScriptTarget: { ESNext: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
  createSourceFile(fileName: string, source: string, languageVersion: number): unknown;
  createProgram(
    rootNames: string[],
    options: Record<string, unknown>,
    host: {
      getSourceFile(fileName: string, languageVersion: number): unknown;
      getDefaultLibFileName(): string;
      writeFile(): void;
      getCurrentDirectory(): string;
      getCanonicalFileName(fileName: string): string;
      useCaseSensitiveFileNames(): boolean;
      getNewLine(): string;
      fileExists(fileName: string): boolean;
      readFile(fileName: string): string | undefined;
      directoryExists(): boolean;
      getDirectories(): string[];
    },
  ): { getSourceFiles(): { fileName: string }[] };
}

// Checks that the editor's lazy type loading reaches every declaration file the editor's TypeScript reads.
// Opt-in, as it compiles about a thousand programs: run `pnpm build` and `pnpm runtime-assets` first.

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeAssetDir = resolve(rootDir, ".cache/runtime-assets/r2");
const runtimeAssetRoute = "/runtime-assets/";
// The TypeScript build Monaco runs in the editor, which can differ from the workspace compiler.
const monacoTypeScriptDir = new URL(
  "../node_modules/monaco-editor/esm/vs/languages/features/typescript/lib/",
  import.meta.url,
);
const libraryRoot = "file:///__drizzle_run_types__/";

const { typescript: ts }: { typescript: TypeScriptCompiler } = await import(
  new URL("typescriptServices.js", monacoTypeScriptDir).href
);
const { libFileMap }: { libFileMap: Record<string, string> } = await import(
  new URL("lib.js", monacoTypeScriptDir).href
);

/** @param {string | URL | Request} input */
globalThis.fetch = async (input) => {
  const { pathname } = new URL(input instanceof Request ? input.url : input, "https://drizzle.run/");

  if (!pathname.startsWith(runtimeAssetRoute)) {
    throw new Error(`The type walk check only serves runtime assets, but got a request for ${pathname}`);
  }

  try {
    return new Response(await readFile(join(runtimeAssetDir, ...pathname.slice(runtimeAssetRoute.length).split("/"))));
  } catch {
    return new Response(null, { status: 404 });
  }
};

/** A project on one guest whose run file imports only `specifier`. */
function makeManifest({
  tuple,
  guestFlavor,
  specifier,
}: {
  tuple: SupportedRuntimeTuple;
  guestFlavor: GuestFlavor;
  specifier: string;
}): RunManifest {
  return parseRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: tuple.target.dialect },
    dependencies: { "drizzle-orm": tuple.ormVersion, "drizzle-kit": tuple.kitVersion },
    ...(guestFlavor === "slim" ? {} : { guestFlavor }),
    files: {
      "schema.ts": "export {};",
      "run.ts": `import * as probe from ${JSON.stringify(specifier)};\nexport { probe };`,
    },
    entrypoints: { schema: "schema.ts", run: "run.ts" },
  });
}

/** List the library files Monaco's TypeScript loads for `environment`, reading them from `availableFiles`. */
function listCompiledLibraryFiles(environment: ProjectTypeEnvironment, availableFiles: Map<string, string>) {
  const readSource = (fileName: string) =>
    availableFiles.get(fileName) ?? libFileMap[fileName.slice(fileName.lastIndexOf("/") + 1)];
  const host = {
    getSourceFile: (fileName: string, languageVersion: number) => {
      const source = readSource(fileName);

      return source === undefined ? undefined : ts.createSourceFile(fileName, source, languageVersion);
    },
    getDefaultLibFileName: () => "lib.es2022.full.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName: string) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName: string) => readSource(fileName) !== undefined,
    readFile: readSource,
    directoryExists: () => true,
    getDirectories: () => [],
  };
  // Must match the resolution options src/editor/environment.ts gives Monaco.
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    isolatedModules: true,
    skipLibCheck: true,
    paths: { ...environment.compilerOptions.paths },
    ...(environment.compilerOptions.typeRoots === undefined
      ? {}
      : { typeRoots: [...environment.compilerOptions.typeRoots] }),
  };
  const rootNames = environment.files.filter((file) => file.kind !== "library").map((file) => file.uri);

  return ts
    .createProgram(rootNames, options, host)
    .getSourceFiles()
    .map((sourceFile) => sourceFile.fileName)
    .filter((fileName) => fileName.startsWith(libraryRoot));
}

const misses = [];

for (const tuple of listSupportedTuples()) {
  for (const guestFlavor of GUEST_FLAVORS.filter((flavor) => hasGuestFlavor(tuple, flavor))) {
    const guestName = `${tuple.target.dialect} ${tuple.ormVersion} ${guestFlavor}`;
    const specifiers = listApprovedModules({ tuple, guestFlavor })
      .filter((entry) => entry.visibility === "user" && entry.packageName !== "@drizzle-run/runtime")
      .flatMap((entry) => entry.allowedSpecifiers);

    const fullEnvironment = await createProjectTypeEnvironment(
      makeManifest({ tuple, guestFlavor, specifier: "drizzle-orm" }),
      { libraries: "all" },
    );
    const allLibraryFiles = fullEnvironment.files
      .filter((file) => file.kind === "library")
      .map((file) => [file.uri, file.content] as const);

    for (const specifier of specifiers) {
      const environment = await createProjectTypeEnvironment(makeManifest({ tuple, guestFlavor, specifier }));
      const walkedFiles = new Map(environment.files.map((file) => [file.uri, file.content]));
      const compiledFiles = listCompiledLibraryFiles(environment, new Map([...allLibraryFiles, ...walkedFiles]));
      const missedFiles = compiledFiles.filter((fileName) => !walkedFiles.has(fileName));

      if (missedFiles.length > 0) {
        misses.push(`${guestName}, ${specifier}: ${missedFiles.length} files, such as ${missedFiles[0]}`);
      }
    }

    console.log(`${guestName}: ${specifiers.length} specifiers checked`);
  }
}

if (misses.length > 0) {
  console.error(`The type walk misses files the editor's TypeScript loads:\n${misses.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("The type walk reaches every file the editor's TypeScript loads.");
}
