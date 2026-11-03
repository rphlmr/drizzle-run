import type { PairSideIndex } from "@drizzle-run/core/pair";
import { pairSide } from "@drizzle-run/core/pair";
import type { ProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";
import { createProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { serveLocalRuntimeAssets } from "../../test/editor/local-runtime-assets";
import { findGuide, isPairGuide } from "../guides/catalog";
import { isolateProjectTypeEnvironment, namespaceProjectTypeEnvironment } from "./session-environment";

beforeAll(serveLocalRuntimeAssets);
afterAll(() => vi.unstubAllGlobals());

/** The part of the TypeScript 5 API these checks call; this repository's TypeScript 7 ships no compiler API. */
interface MonacoTypeScript {
  ScriptTarget: { ESNext: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
  ScriptSnapshot: { fromString(text: string): unknown };
  createLanguageService(host: object): {
    getQuickInfoAtPosition(fileName: string, position: number): { displayParts?: unknown } | undefined;
    getSemanticDiagnostics(fileName: string): readonly { messageText: unknown }[];
  };
  displayPartsToString(parts: unknown): string;
  flattenDiagnosticMessageText(message: unknown, newLine: string): string;
}

const monacoTypeScriptRoot = "../../node_modules/monaco-editor/esm/vs/languages/features/typescript/lib";
const { typescript: ts }: { typescript: MonacoTypeScript } = await import(
  /* @vite-ignore */ `${monacoTypeScriptRoot}/typescriptServices.js`
);
const { libFileMap }: { libFileMap: Readonly<Record<string, string>> } = await import(
  /* @vite-ignore */ `${monacoTypeScriptRoot}/lib.js`
);

/** The shipped side-by-side project of the relational queries guide. */
function getRelationalQueriesProject() {
  const guide = findGuide("relational-queries");

  if (guide === undefined || !isPairGuide(guide)) {
    throw new Error("Expected the relational-queries guide to walk a side-by-side project");
  }

  return guide.project;
}

const sessionIds = ["11111111111111111111111111111111", "22222222222222222222222222222222"] as const;

/** The environment `prepareEditor` gives one side of the relational queries guide. */
async function makeSideEnvironment({ side, isolated }: { side: PairSideIndex; isolated: boolean }) {
  const manifest = pairSide(getRelationalQueriesProject(), side);
  const generated = await createProjectTypeEnvironment(manifest, isolated ? { contextDeclaration: "module" } : {});
  const namespaced = namespaceProjectTypeEnvironment(generated, sessionIds[side]);

  return isolated ? isolateProjectTypeEnvironment(namespaced, sessionIds[side], { globals: side === 0 }) : namespaced;
}

/** A language service whose host reads files as Monaco's TypeScript worker does, with `prepareEditor`'s options. */
function createEditorLanguageService(environments: readonly ProjectTypeEnvironment[]) {
  const files = new Map(environments.flatMap((environment) => environment.files.map((file) => [file.uri, file])));
  const [{ compilerOptions }] = environments;
  const readText = (fileName: string): string | undefined =>
    files.get(fileName)?.content ?? libFileMap[fileName] ?? libFileMap[`lib.${fileName}.d.ts`];

  return ts.createLanguageService({
    getCompilationSettings: () => ({
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
      paths: Object.fromEntries(Object.entries(compilerOptions.paths).map(([key, paths]) => [key, [...paths]])),
      ...(compilerOptions.typeRoots === undefined ? {} : { typeRoots: [...compilerOptions.typeRoots] }),
    }),
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName: string) => {
      const text = readText(fileName);

      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.esnext.full.d.ts",
    readFile: readText,
    fileExists: (fileName: string) => readText(fileName) !== undefined,
  });
}

/** The hover text of `authors` in the environment's `query.ts`, and the semantic errors of that file. */
function getAuthorsType(service: ReturnType<typeof createEditorLanguageService>, environment: ProjectTypeEnvironment) {
  const query = environment.files.find((file) => file.kind === "project" && file.uri.endsWith("/query.ts"));

  if (query === undefined) {
    throw new Error(`Expected query.ts in the environment ${environment.fingerprint}`);
  }

  const hover = service.getQuickInfoAtPosition(query.uri, query.content.indexOf("authors") + 1);
  const errors = service
    .getSemanticDiagnostics(query.uri)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

  return { hover: ts.displayPartsToString(hover?.displayParts), errors };
}

describe("editor type environments", () => {
  it("should type relational query results in a single editor", async () => {
    const environment = await makeSideEnvironment({ side: 1, isolated: false });

    const { hover, errors } = getAuthorsType(createEditorLanguageService([environment]), environment);

    expect(errors).toEqual([]);
    expect(hover).toContain("name: string");
  }, 60_000);

  it("should type relational query results on both sides of one program", async () => {
    const environments = await Promise.all([
      makeSideEnvironment({ side: 0, isolated: true }),
      makeSideEnvironment({ side: 1, isolated: true }),
    ]);
    const service = createEditorLanguageService(environments);

    for (const environment of environments) {
      const { hover, errors } = getAuthorsType(service, environment);

      expect(errors).toEqual([]);
      expect(hover).toContain("name: string");
    }
  }, 60_000);
});
