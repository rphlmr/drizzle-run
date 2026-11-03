import {
  type GuestSelection,
  listSupportedTargets,
  resolveGuestFlavor,
  resolveSupportedTuple,
  type SupportedRuntimeTuple,
} from "@drizzle-run/core/catalog";
import { parseRunManifest } from "@drizzle-run/core/manifest";
import {
  type ApprovedModuleEntry,
  assertApprovedSpecifier,
  listApprovedModules,
  RUNTIME_CONTEXT_SPECIFIER,
} from "@drizzle-run/core/registry";

import { createTypeEnvironmentFingerprint } from "./content-hash.ts";
import { loadRuntimeAssetDeclarationArtifact } from "./declaration-source.ts";
import {
  generatePlaygroundToolsDeclaration,
  generateRuntimeContextDeclaration,
  generateRuntimeContextModule,
} from "./generated-types.ts";
import { listModuleReferences, listRelativeCandidates } from "./module-references.ts";
import type {
  AddImportedLibrariesOptions,
  CreateProjectTypeEnvironmentOptions,
  DeclarationArtifactLoader,
  ProjectCompilerOptions,
  ProjectTypeEnvironment,
  ProjectTypeFile,
  RunManifest,
} from "./types.ts";

const PROJECT_ROOT = "file:///__drizzle_run_project__";
const GENERATED_ROOT = "file:///__drizzle_run_generated__";

// Exclude ES2023.Intl, ES2024.SharedMemory and ES2025.Intl because the guest does not implement
// their full API surface.
const GUEST_LIBRARIES: ProjectCompilerOptions["lib"] = [
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

function normalizeProjectPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");

  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid virtual project path: ${path}`);
  }

  return normalized;
}

function toProjectUri(fingerprint: string, path: string): string {
  const encodedPath = normalizeProjectPath(path).split("/").map(encodeURIComponent).join("/");

  return `${PROJECT_ROOT}/${fingerprint}/${encodedPath}`;
}

function getSelectedEntries(guest: GuestSelection): readonly ApprovedModuleEntry[] {
  const userEntries = listApprovedModules(guest).filter(
    (entry) => entry.visibility === "user" && entry.packageName !== "@drizzle-run/runtime",
  );

  return Object.freeze([...new Map(userEntries.map((entry) => [entry.runtimeArtifact.id, entry])).values()]);
}

function assertArtifactFiles(entry: ApprovedModuleEntry, files: readonly { uri: string; content: string }[]): void {
  if (files.length === 0) {
    throw new Error(`Declaration artifact is empty: ${entry.types.closureArtifact.id}`);
  }

  if (!files.some((file) => file.uri === entry.types.declarationRoot)) {
    throw new Error(`Declaration artifact is missing its root: ${entry.types.declarationRoot}`);
  }

  const seenUris = new Set<string>();

  for (const file of files) {
    if (!file.uri.startsWith("file:///__drizzle_run_types__/")) {
      throw new Error(`Declaration artifact used an unstable virtual URI: ${file.uri}`);
    }

    if (seenUris.has(file.uri)) {
      throw new Error(`Duplicate declaration URI: ${file.uri}`);
    }

    seenUris.add(file.uri);
  }
}

/** The guest a manifest runs on, with the approved modules its code may import */
interface ProjectGuest {
  tuple: SupportedRuntimeTuple;
  guest: GuestSelection;
  entries: readonly ApprovedModuleEntry[];
}

function resolveProjectGuest(manifest: RunManifest): ProjectGuest {
  const runtimeTarget = listSupportedTargets().find((target) => target.dialect === manifest.target.dialect);

  if (runtimeTarget === undefined) {
    throw new Error(`Unsupported database dialect: ${manifest.target.dialect}`);
  }

  const tuple = resolveSupportedTuple({
    target: runtimeTarget,
    ormVersion: manifest.dependencies["drizzle-orm"],
    kitVersion: manifest.dependencies["drizzle-kit"],
  });
  const guest = { tuple, guestFlavor: resolveGuestFlavor(manifest) };

  return { tuple, guest, entries: getSelectedEntries(guest) };
}

async function loadEntryFiles(
  entry: ApprovedModuleEntry,
  { tuple }: ProjectGuest,
  loadDeclarationArtifact: DeclarationArtifactLoader,
): Promise<readonly ProjectTypeFile[]> {
  const files = await loadDeclarationArtifact(entry, tuple);
  assertArtifactFiles(entry, files);

  return files.map((file) => ({ ...file, kind: "library" as const }));
}

/**
 * Load the declarations `sources` reach and `loadedFiles` lack
 *
 * Follows imports: from each approved specifier the sources import to its declaration entrypoint, through the relative
 * imports of the declarations, to the approved packages those import in turn. A package that is never reached is never
 * loaded, so a project that imports only `drizzle-orm/pg-core` does not load effect, even though other subpaths of
 * drizzle-orm import it. Returns the new library files, in load order.
 */
async function loadReachedLibraries(
  projectGuest: ProjectGuest,
  sources: readonly string[],
  loadedFiles: readonly ProjectTypeFile[],
  loadDeclarationArtifact: DeclarationArtifactLoader,
): Promise<ProjectTypeFile[]> {
  const targetsBySpecifier = new Map(
    projectGuest.entries.flatMap((entry) =>
      entry.allowedSpecifiers.map((specifier, index) => [specifier, { entry, uri: entry.types.virtualPaths[index] }]),
    ),
  );
  const filesByUri = new Map(loadedFiles.map((file) => [decodeURIComponent(file.uri), file]));
  const loadedArtifactIds = new Set(
    projectGuest.entries
      .filter((entry) => filesByUri.has(decodeURIComponent(entry.types.declarationRoot)))
      .map((entry) => entry.types.closureArtifact.id),
  );
  const addedFiles: ProjectTypeFile[] = [];
  const walkedUris = new Set<string>();
  let pendingSpecifiers = new Set(sources.flatMap((source) => listModuleReferences(source).bare));

  while (pendingSpecifiers.size > 0) {
    const reachedTargets = [...pendingSpecifiers].flatMap((specifier) => targetsBySpecifier.get(specifier) ?? []);
    const missingEntries = [
      ...new Map(
        reachedTargets
          .map(({ entry }) => entry)
          .filter((entry) => !loadedArtifactIds.has(entry.types.closureArtifact.id))
          .map((entry) => [entry.types.closureArtifact.id, entry]),
      ).values(),
    ];

    // Load the packages this round reached
    const loadedEntryFiles = await Promise.all(
      missingEntries.map((entry) => loadEntryFiles(entry, projectGuest, loadDeclarationArtifact)),
    );

    for (const [index, entry] of missingEntries.entries()) {
      loadedArtifactIds.add(entry.types.closureArtifact.id);

      for (const file of loadedEntryFiles[index] ?? []) {
        const uri = decodeURIComponent(file.uri);

        if (!filesByUri.has(uri)) {
          filesByUri.set(uri, file);
          addedFiles.push(file);
        }
      }
    }

    // Walk their declarations from the entrypoints the specifiers name
    const pendingUris = reachedTargets.flatMap(({ uri }) => (uri === undefined ? [] : [decodeURIComponent(uri)]));
    pendingSpecifiers = new Set();

    while (pendingUris.length > 0) {
      const uri = pendingUris.pop() ?? "";
      const file = filesByUri.get(uri);

      if (walkedUris.has(uri) || file === undefined) {
        continue;
      }

      walkedUris.add(uri);
      const references = listModuleReferences(file.content);

      for (const specifier of references.relative) {
        const resolvedUri = listRelativeCandidates(uri, specifier).find((candidate) => filesByUri.has(candidate));

        if (resolvedUri !== undefined) {
          pendingUris.push(resolvedUri);
        }
      }

      for (const specifier of references.bare) {
        const target = targetsBySpecifier.get(specifier);

        if (target !== undefined && !walkedUris.has(decodeURIComponent(target.uri ?? ""))) {
          pendingSpecifiers.add(specifier);
        }
      }
    }
  }

  return addedFiles;
}

async function loadAllLibraries(
  projectGuest: ProjectGuest,
  loadDeclarationArtifact: DeclarationArtifactLoader,
): Promise<ProjectTypeFile[]> {
  const libraryUris = new Set<string>();
  const files: ProjectTypeFile[] = [];

  for (const entry of projectGuest.entries) {
    for (const file of await loadEntryFiles(entry, projectGuest, loadDeclarationArtifact)) {
      if (!libraryUris.has(file.uri)) {
        libraryUris.add(file.uri);
        files.push(file);
      }
    }
  }

  return files;
}

/** Map the PostgreSQL driver's own dependencies, such as `pg`, to the driver declarations among `files`. */
function addDriverPaths(paths: Record<string, readonly string[]>, files: readonly ProjectTypeFile[]): void {
  const dependencyMarker = "/_dependencies/";

  for (const file of files) {
    if (!file.uri.includes(dependencyMarker) || !file.uri.endsWith("/__entry__.d.ts")) {
      continue;
    }

    const suffix = file.uri.slice(file.uri.indexOf(dependencyMarker) + dependencyMarker.length);
    const encodedSegments = suffix.slice(0, -"/__entry__.d.ts".length).split("/");
    const firstName = decodeURIComponent(encodedSegments[0] ?? "");
    const packageSegments = firstName.startsWith("@") ? encodedSegments.slice(0, 2) : encodedSegments.slice(0, 1);
    const packageName = packageSegments.map(decodeURIComponent).join("/");
    const packageBase = file.uri.slice(0, -"__entry__.d.ts".length);
    paths[packageName] = [file.uri];
    paths[`${packageName}/*`] = [`${packageBase}*`];

    if (packageName === "@types/pg") {
      paths.pg = [file.uri];
    }
  }
}

/**
 * Create the TypeScript environment of a playground project
 *
 * Returns the project files, the approved library declarations and the generated context and `$` tools
 * declarations, keyed by virtual URIs under a content fingerprint, with the compiler options that resolve them.
 * `paths` maps every approved specifier; by default only the declarations the project and the generated context import
 * are loaded, and `addImportedLibraries` loads the ones a later edit imports. Throws when the manifest is invalid, its
 * pair is not supported, the schema entrypoint is missing, or a declaration artifact fails to load, is empty, rootless
 * or uses an unstable URI.
 */
export async function createProjectTypeEnvironment(
  input: RunManifest,
  options: CreateProjectTypeEnvironmentOptions = {},
): Promise<ProjectTypeEnvironment> {
  const manifest = parseRunManifest(input);
  const projectGuest = resolveProjectGuest(manifest);
  const { tuple, guest, entries } = projectGuest;
  const schemaPath = normalizeProjectPath(manifest.entrypoints.schema);

  if (!(schemaPath in manifest.files)) {
    throw new Error(`Schema entrypoint does not exist: ${schemaPath}`);
  }

  const fingerprint = await createTypeEnvironmentFingerprint({
    target: manifest.target,
    tuple: tuple.id,
    dependencies: manifest.dependencies,
    guestFlavor: guest.guestFlavor,
    files: manifest.files,
    entrypoints: manifest.entrypoints,
    env: manifest.env,
    randomSeed: manifest.randomSeed,
  });
  const projectFiles: ProjectTypeFile[] = Object.entries(manifest.files).map(([path, content]) => ({
    uri: toProjectUri(fingerprint, path),
    content,
    kind: "project" as const,
  }));

  // Generate the context and `$` tools declarations
  const schemaUri = toProjectUri(fingerprint, schemaPath);
  const generateContext =
    options.contextDeclaration === "module" ? generateRuntimeContextModule : generateRuntimeContextDeclaration;
  const generatedFiles: ProjectTypeFile[] = [
    {
      uri: `${GENERATED_ROOT}/${fingerprint}/context.d.ts`,
      content: generateContext({
        target: manifest.target,
        tuple,
        schemaUri,
      }),
      kind: "generated",
    },
    {
      uri: `${GENERATED_ROOT}/${fingerprint}/playground-tools.d.ts`,
      content: generatePlaygroundToolsDeclaration(),
      kind: "generated",
    },
  ];

  // Load the library declarations
  const loadDeclarationArtifact = options.loadDeclarationArtifact ?? loadRuntimeAssetDeclarationArtifact;
  const loadLibraries = () => {
    switch (options.libraries ?? "imported") {
      case "all":
        return loadAllLibraries(projectGuest, loadDeclarationArtifact);
      case "imported":
        return loadReachedLibraries(
          projectGuest,
          [...projectFiles, ...generatedFiles].map((file) => file.content),
          [],
          loadDeclarationArtifact,
        );
    }
  };
  const libraryFiles = await loadLibraries();
  const files = [...projectFiles, ...libraryFiles, ...generatedFiles];

  // Map approved specifiers to their declarations
  const paths: Record<string, readonly string[]> = {};

  for (const entry of entries) {
    for (const [index, specifier] of entry.allowedSpecifiers.entries()) {
      assertApprovedSpecifier(guest, specifier);
      const virtualPath = entry.types.virtualPaths[index];

      if (virtualPath === undefined) {
        throw new Error(`Type registry is missing a virtual path for ${specifier}`);
      }

      paths[specifier] = [virtualPath];
    }
  }

  const ormEntry = entries.find((entry) => entry.packageName === "drizzle-orm");

  if (manifest.target.dialect === "postgresql" && ormEntry !== undefined) {
    addDriverPaths(paths, files);
  }

  paths[RUNTIME_CONTEXT_SPECIFIER] = [`${GENERATED_ROOT}/${fingerprint}/context.d.ts`];

  const compilerOptions: ProjectCompilerOptions = {
    target: "ES2025",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: GUEST_LIBRARIES,
    strict: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    paths: Object.freeze(paths),
    ...(manifest.target.dialect === "postgresql" && ormEntry?.types.driverArtifact !== undefined
      ? { typeRoots: [`${ormEntry.types.driverArtifact.root}/_dependencies/_node_types/%40types`] }
      : {}),
  };

  return Object.freeze({
    fingerprint,
    compilerOptions: Object.freeze(compilerOptions),
    files: Object.freeze(files),
  });
}

/**
 * Add the declarations of newly imported packages to a project's type environment
 *
 * Loads what `sources` (the project's current file contents) reach and `environment` lacks, the same way
 * `createProjectTypeEnvironment` does on open. Returns `environment` itself when nothing is missing, so a caller can
 * skip the update, and otherwise a new environment with the library files appended. `input` is the manifest the
 * environment was created from. Throws when a declaration artifact fails to load or check.
 */
export async function addImportedLibraries(
  environment: ProjectTypeEnvironment,
  input: RunManifest,
  sources: readonly string[],
  options: AddImportedLibrariesOptions = {},
): Promise<ProjectTypeEnvironment> {
  const manifest = parseRunManifest(input);
  const addedFiles = await loadReachedLibraries(
    resolveProjectGuest(manifest),
    sources,
    environment.files.filter((file) => file.kind === "library"),
    options.loadDeclarationArtifact ?? loadRuntimeAssetDeclarationArtifact,
  );

  if (addedFiles.length === 0) {
    return environment;
  }

  const files = [...environment.files, ...addedFiles];
  const paths = { ...environment.compilerOptions.paths };

  if (manifest.target.dialect === "postgresql") {
    addDriverPaths(paths, addedFiles);
  }

  return Object.freeze({
    ...environment,
    compilerOptions: Object.freeze({ ...environment.compilerOptions, paths: Object.freeze(paths) }),
    files: Object.freeze(files),
  });
}
