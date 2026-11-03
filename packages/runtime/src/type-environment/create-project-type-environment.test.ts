import {
  GUEST_FLAVORS,
  hasGuestFlavor,
  listSupportedTargets,
  listSupportedTuples,
  resolveSupportedTuple,
} from "@drizzle-run/core/catalog";
import type { LegacyRunDependencies } from "@drizzle-run/core/manifest";
import { listApprovedModules, type ApprovedModuleEntry } from "@drizzle-run/core/registry";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";

import { serveLocalRuntimeAssets } from "../../test/type-environment/local-runtime-assets.ts";
import { addImportedLibraries, createProjectTypeEnvironment } from "./create-project-type-environment.ts";
import type { DeclarationArtifactLoader, ProjectTypeEnvironment, RunManifest } from "./types.ts";

beforeAll(serveLocalRuntimeAssets);

/** Every approved module of every shipped guest. */
function listEveryApprovedModule(): ApprovedModuleEntry[] {
  const entries = listSupportedTargets().flatMap((target) =>
    listSupportedTuples(target).flatMap((tuple) =>
      GUEST_FLAVORS.filter((guestFlavor) => hasGuestFlavor(tuple, guestFlavor)).flatMap((guestFlavor) =>
        listApprovedModules({ tuple, guestFlavor }),
      ),
    ),
  );

  return [...new Set(entries)];
}
afterAll(() => vi.unstubAllGlobals());

const stubDeclarationLoader: DeclarationArtifactLoader = async (entry) => [
  {
    uri: `file:///__drizzle_run_types__/${encodeURIComponent(entry.packageName)}@${entry.version}/index.d.ts`,
    content: `declare module ${JSON.stringify(entry.packageName)} {}`,
  },
];

const legacyDependencies: LegacyRunDependencies = { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" };

const legacyPostgresManifest: RunManifest = {
  kind: "drizzle-run",
  manifestVersion: 1,
  target: { dialect: "postgresql" },
  dependencies: legacyDependencies,
  files: {
    "schema.ts": 'export const users = { table: "users" };',
    "run.ts": 'import { db } from "@drizzle-run/runtime/context"; export default db;',
  },
  entrypoints: { schema: "schema.ts", run: "run.ts" },
};

function makeNextManifest(files: Readonly<Record<string, string>> = {}): RunManifest {
  return {
    ...legacyPostgresManifest,
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: {
      "schema.ts":
        'import { pgTable, serial } from "drizzle-orm/pg-core";\nexport const users = pgTable("users", { id: serial() });',
      "run.ts": 'import { db } from "@drizzle-run/runtime/context";\nexport default db;',
      ...files,
    },
  };
}

/** The packages whose declarations an environment holds, as their virtual folders name them, sorted. */
function listLoadedPackages(environment: ProjectTypeEnvironment): string[] {
  const packages = new Set(
    environment.files
      .filter((file) => file.kind === "library")
      .map((file) => {
        const folder = decodeURIComponent(file.uri.slice("file:///__drizzle_run_types__/".length).split("/")[0] ?? "");

        return folder.startsWith("node-postgres__") ? "@types/pg+@types/node" : folder.replace(/@[^@]+$/, "");
      }),
  );

  return [...packages].toSorted();
}

function getRuntimeTarget(manifest: RunManifest) {
  const target = listSupportedTargets().find((candidate) => candidate.dialect === manifest.target.dialect);

  if (target === undefined) {
    throw new Error(`No runtime target for ${manifest.target.dialect}`);
  }

  return target;
}

describe("createProjectTypeEnvironment", () => {
  it("should expose only the fingerprint, the compiler options and the files", () => {
    expectTypeOf<keyof ProjectTypeEnvironment>().toEqualTypeOf<"fingerprint" | "compilerOptions" | "files">();
  });

  it("should generate exact PostgreSQL context and lexical tool declarations", async () => {
    const environment = await createProjectTypeEnvironment(legacyPostgresManifest, {
      loadDeclarationArtifact: stubDeclarationLoader,
    });
    const context = environment.files.find((file) => file.uri.endsWith("/context.d.ts"));
    const tools = environment.files.find((file) => file.uri.endsWith("/playground-tools.d.ts"));

    expect(context?.content).toContain('import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema>');
    expect(context?.content).toContain(`file:///__drizzle_run_project__/${environment.fingerprint}/schema.ts`);
    expect(context?.content).toContain('const target: {"dialect":"postgresql"}');
    expect(tools?.content).toContain("declare const $:");
    expect(environment.compilerOptions.paths["drizzle-zod"]).toBeDefined();
  });

  it("should resolve the context specifier to its declaration", async () => {
    const environment = await createProjectTypeEnvironment(legacyPostgresManifest, {
      loadDeclarationArtifact: stubDeclarationLoader,
    });
    const context = environment.files.find((file) => file.uri.endsWith("/context.d.ts"));

    expect(environment.compilerOptions.paths["@drizzle-run/runtime/context"]).toEqual([context?.uri]);
  });

  it("should change its fingerprint so consumers can dispose stale types", async () => {
    const first = await createProjectTypeEnvironment(legacyPostgresManifest, {
      loadDeclarationArtifact: stubDeclarationLoader,
    });
    const second = await createProjectTypeEnvironment(
      {
        ...legacyPostgresManifest,
        files: { ...legacyPostgresManifest.files, "run.ts": "export default 2;" },
      },
      { loadDeclarationArtifact: stubDeclarationLoader },
    );

    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.files.some((file) => file.uri.includes(first.fingerprint))).toBe(true);
    expect(second.files.some((file) => file.uri.includes(first.fingerprint))).toBe(false);
  });

  it("should generate dialect-specific SQLite typing for the RC5 release pair", async () => {
    const environment = await createProjectTypeEnvironment(
      {
        kind: "drizzle-run",
        manifestVersion: 1,
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
        files: { "schema.ts": "export const users = {};" },
        entrypoints: { schema: "schema.ts" },
      },
      { loadDeclarationArtifact: stubDeclarationLoader },
    );
    const context = environment.files.find((file) => file.uri.endsWith("/context.d.ts"));

    expect(context?.content).toContain('import("drizzle-orm/libsql").LibSQLDatabase<SchemaRelations>');
    expect(environment.compilerOptions.paths["drizzle-orm/typebox"]).toBeDefined();
    expect(environment.compilerOptions.paths["drizzle-zod"]).toBeUndefined();
  });

  it("should use the package-owned declaration closures by default", async () => {
    const environment = await createProjectTypeEnvironment(legacyPostgresManifest);
    const tuple = resolveSupportedTuple({
      target: getRuntimeTarget(legacyPostgresManifest),
      ormVersion: legacyPostgresManifest.dependencies["drizzle-orm"],
      kitVersion: legacyPostgresManifest.dependencies["drizzle-kit"],
    });
    const entries = listApprovedModules({ tuple, guestFlavor: "slim" }).filter(
      (entry) =>
        entry.visibility === "user" &&
        entry.packageName !== "@drizzle-run/runtime" &&
        legacyPostgresManifest.dependencies[entry.packageName as keyof typeof legacyPostgresManifest.dependencies] ===
          entry.version,
    );

    for (const entry of entries) {
      for (const specifier of entry.allowedSpecifiers) {
        const index = entry.allowedSpecifiers.indexOf(specifier);
        const uri = entry.types.virtualPaths[index];
        expect(environment.files.some((file) => file.uri === uri)).toBe(true);
      }
    }

    expect(environment.files.some((file) => file.uri.endsWith("/_dependencies/%40types/pg/index.d.ts"))).toBe(true);
    expect(
      environment.files.some((file) => file.uri.endsWith("/_dependencies/_node_types/%40types/node/index.d.ts")),
    ).toBe(true);
    expect(environment.compilerOptions.paths.pg).toBeDefined();
    expect(environment.compilerOptions.typeRoots).toEqual([
      expect.stringContaining("/_dependencies/_node_types/%40types"),
    ]);
    expect(listEveryApprovedModule().length).toBeGreaterThan(0);
  });

  it("should not load PostgreSQL driver dependencies into SQLite environments", async () => {
    const environment = await createProjectTypeEnvironment({
      ...legacyPostgresManifest,
      target: { dialect: "sqlite" },
      dependencies: {
        "drizzle-orm": "0.45.4",
        "drizzle-kit": "0.31.11",
      },
    });

    expect(environment.compilerOptions.typeRoots).toBeUndefined();
    expect(environment.compilerOptions.paths.pg).toBeUndefined();
    expect(environment.files.some((file) => file.uri.includes("/_dependencies/"))).toBe(false);
  });

  it("should keep every approved user specifier backed by a declaration entrypoint", async () => {
    const tuple = resolveSupportedTuple({
      target: getRuntimeTarget(legacyPostgresManifest),
      ormVersion: legacyPostgresManifest.dependencies["drizzle-orm"],
      kitVersion: legacyPostgresManifest.dependencies["drizzle-kit"],
    });
    const environment = await createProjectTypeEnvironment({
      ...legacyPostgresManifest,
      files: {
        "schema.ts": "export const users = {};",
        "run.ts": "export default undefined;",
      },
      entrypoints: { schema: "schema.ts", run: "run.ts" },
    });

    for (const entry of listApprovedModules({ tuple, guestFlavor: "slim" })) {
      if (
        entry.visibility !== "user" ||
        entry.packageName === "@drizzle-run/runtime" ||
        !Object.hasOwn(legacyPostgresManifest.dependencies, entry.packageName)
      ) {
        continue;
      }

      for (const uri of entry.types.virtualPaths) {
        expect(environment.files.some((file) => file.uri === uri)).toBe(true);
      }
    }
  });

  it("should use URL-safe declaration artifact filenames", () => {
    for (const entry of listEveryApprovedModule()) {
      if (entry.visibility !== "user" || entry.allowedSpecifiers.length === 0) {
        continue;
      }

      expect(entry.types.closureArtifact.manifestPath).toMatch(/^\.\/artifacts\/declarations\/[A-Za-z0-9_.-]+\.json$/);
      expect(entry.types.closureArtifact.manifestPath).not.toMatch(/[@%]/);
    }
  });

  it.each(["postgresql", "sqlite"] as const)(
    "should load every Legacy validator's declarations for %s when the project imports it, unpinned",
    async (dialect) => {
      const validatorSpecifiers = [
        "drizzle-zod",
        "drizzle-valibot",
        "drizzle-typebox",
        "drizzle-arktype",
        "zod",
        "valibot",
        "arktype",
        "@sinclair/typebox",
      ];
      const environment = await createProjectTypeEnvironment({
        ...legacyPostgresManifest,
        target: { dialect },
        files: {
          "schema.ts": validatorSpecifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n"),
        },
        entrypoints: { schema: "schema.ts" },
      });

      for (const specifier of validatorSpecifiers) {
        expect(environment.compilerOptions.paths[specifier]).toBeDefined();
        expect(environment.files.some((file) => file.uri === environment.compilerOptions.paths[specifier]?.[0])).toBe(
          true,
        );
      }
    },
  );

  it("should load only the declarations a Next project and its context import", async () => {
    const environment = await createProjectTypeEnvironment(makeNextManifest());

    expect(listLoadedPackages(environment)).toEqual(["@types/pg+@types/node", "drizzle-orm"]);
    expect(environment.compilerOptions.paths.valibot).toBeDefined();
    expect(environment.compilerOptions.paths["drizzle-orm/valibot"]).toBeDefined();
  });

  it("should load the packages an imported package's declarations import", async () => {
    const environment = await createProjectTypeEnvironment({
      ...legacyPostgresManifest,
      files: {
        ...legacyPostgresManifest.files,
        "validation.ts": 'import { createInsertSchema } from "drizzle-valibot";',
      },
    });

    expect(listLoadedPackages(environment)).toEqual([
      "@types/pg+@types/node",
      "drizzle-orm",
      "drizzle-valibot",
      "valibot",
    ]);
  });

  it("should follow a Next subpath to the validator it imports, and no further", async () => {
    const environment = await createProjectTypeEnvironment(
      makeNextManifest({ "validation.ts": 'import { createInsertSchema } from "drizzle-orm/valibot";' }),
    );

    expect(listLoadedPackages(environment)).toEqual(["@types/pg+@types/node", "drizzle-orm", "valibot"]);
  });

  it("should follow drizzle-zod and drizzle-orm/zod to zod through its v4 subpath", async () => {
    const [legacy, next] = await Promise.all([
      createProjectTypeEnvironment({
        ...legacyPostgresManifest,
        files: {
          ...legacyPostgresManifest.files,
          "validation.ts": 'import { createInsertSchema } from "drizzle-zod";',
        },
      }),
      createProjectTypeEnvironment(
        makeNextManifest({ "validation.ts": 'import { createInsertSchema } from "drizzle-orm/zod";' }),
      ),
    ]);

    expect(listLoadedPackages(legacy)).toEqual(["@types/pg+@types/node", "drizzle-orm", "drizzle-zod", "zod"]);
    expect(listLoadedPackages(next)).toEqual(["@types/pg+@types/node", "drizzle-orm", "zod"]);
    expect(next.compilerOptions.paths["zod/v4"]).toBeDefined();
  });

  it("should load every approved package with libraries: all", async () => {
    const manifest = makeNextManifest();
    const environment = await createProjectTypeEnvironment(manifest, { libraries: "all" });
    const tuple = resolveSupportedTuple({
      target: getRuntimeTarget(manifest),
      ormVersion: "1.0.0-rc.5",
      kitVersion: "1.0.0-rc.5",
    });

    const userEntries = listApprovedModules({ tuple, guestFlavor: "slim" }).filter(
      (entry) => entry.visibility === "user" && entry.packageName !== "@drizzle-run/runtime",
    );
    const loadedUris = new Set(environment.files.map((file) => file.uri));

    expect(userEntries.filter((entry) => !loadedUris.has(entry.types.declarationRoot))).toEqual([]);
  });
});

describe("addImportedLibraries", () => {
  it("should return the same environment when every import is loaded", async () => {
    const manifest = makeNextManifest();
    const environment = await createProjectTypeEnvironment(manifest);

    const next = await addImportedLibraries(environment, manifest, Object.values(manifest.files));

    expect(next).toBe(environment);
  });

  it("should append the declarations of a new import and keep the fingerprint and paths", async () => {
    const manifest = makeNextManifest();
    const environment = await createProjectTypeEnvironment(manifest);

    const next = await addImportedLibraries(environment, manifest, [
      ...Object.values(manifest.files),
      'import { z } from "zod";',
    ]);

    expect(listLoadedPackages(next)).toEqual(["@types/pg+@types/node", "drizzle-orm", "zod"]);
    expect(next.files.slice(0, environment.files.length)).toEqual(environment.files);
    expect(next.fingerprint).toBe(environment.fingerprint);
    expect(next.compilerOptions).toEqual(environment.compilerOptions);
  });
});
