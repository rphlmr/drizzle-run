import type { SupportedRuntimeTuple } from "@drizzle-run/core/catalog";
import type { ApprovedModuleEntry } from "@drizzle-run/core/registry";

export type { RunManifest } from "@drizzle-run/core/manifest";

/** The fixed compiler options of a project type environment, with its `paths` to the virtual declarations */
export interface ProjectCompilerOptions {
  target: "ES2025";
  module: "ESNext";
  moduleResolution: "Bundler";
  lib: readonly [
    "ES2022",
    "ES2023.Array",
    "ES2023.Collection",
    "ES2024.ArrayBuffer",
    "ES2024.Collection",
    "ES2024.Object",
    "ES2024.Promise",
    "ES2024.Regexp",
    "ES2024.String",
    "ES2025.Collection",
    "ES2025.Float16",
    "ES2025.Iterator",
    "ES2025.Promise",
    "ES2025.Regexp",
    "DOM",
    "WebWorker",
  ];
  strict: true;
  allowImportingTsExtensions: true;
  resolveJsonModule: true;
  isolatedModules: true;
  noEmit: true;
  paths: Readonly<Record<string, readonly string[]>>;
  typeRoots?: readonly string[];
}

/** One file of a project type environment, keyed by its virtual URI */
export interface ProjectTypeFile {
  uri: string;
  content: string;
  kind: "project" | "library" | "generated";
}

/** The files and compiler options an editor needs to type-check a playground project */
export interface ProjectTypeEnvironment {
  fingerprint: string;
  compilerOptions: ProjectCompilerOptions;
  files: readonly ProjectTypeFile[];
}

/** One declaration file of a packaged library artifact */
export interface DeclarationArtifactFile {
  uri: string;
  content: string;
}

/** Loads the declaration files of an approved module for a runtime tuple */
export type DeclarationArtifactLoader = (
  entry: ApprovedModuleEntry,
  tuple: SupportedRuntimeTuple,
) => Promise<readonly DeclarationArtifactFile[]>;

/** Options of `createProjectTypeEnvironment` */
export interface CreateProjectTypeEnvironmentOptions {
  /** Loads an approved module's declarations; defaults to the runtime assets. */
  loadDeclarationArtifact?: DeclarationArtifactLoader;
  /**
   * `imported` (default) loads the declarations the project and its generated context import, and the packages those
   * import in turn. `all` loads every approved package of the guest.
   */
  libraries?: "imported" | "all";
  /**
   * `ambient` (default) declares the context specifier with a `declare module` block. `module`
   * writes a module file the `paths` entries resolve to, so two environments can share one program.
   */
  contextDeclaration?: "ambient" | "module";
}

/** Options of `addImportedLibraries` */
export interface AddImportedLibrariesOptions {
  /** Loads an approved module's declarations; defaults to the runtime assets. */
  loadDeclarationArtifact?: DeclarationArtifactLoader;
}
