/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunManifest } from "@drizzle-run/core/manifest";
import { createProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { serveLocalRuntimeAssets } from "../../test/editor/local-runtime-assets";
import { isolateProjectTypeEnvironment, namespaceProjectTypeEnvironment } from "./session-environment";

beforeAll(serveLocalRuntimeAssets);
afterAll(() => vi.unstubAllGlobals());

type Dialect = RunManifest["target"]["dialect"];
type ReleaseLine = "legacy" | "next";

const compilerSessionId = "a3c19e72b5d84f61a902d6e7c8b3f405";
const secondSessionId = "5e0d7c2a9b1f48e3a6c4d8b2f1e09a37";

function createManifest(dialect: Dialect, releaseLine: ReleaseLine): RunManifest {
  const isPostgres = dialect === "postgresql";
  const schemaSource = isPostgres
    ? `import { pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
`
    : `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
`;

  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect },
    dependencies:
      releaseLine === "legacy"
        ? { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" }
        : { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    entrypoints: { schema: "schema.ts", run: "run.ts" },
    files: {
      "schema.ts": schemaSource,
      "helpers.ts": `import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { users } from "./schema.ts";

export type UserInsert = InferInsertModel<typeof users>;
export type UserSelect = InferSelectModel<typeof users>;
export const formatUser = (user: UserSelect): string => user.name;
export const exampleInsert: UserInsert = { name: "Ada" };
`,
      "run.ts": `import { db, schema } from "@drizzle-run/runtime/context";
import { eq } from "drizzle-orm";
import { exampleInsert, formatUser, type UserInsert } from "./helpers.ts";

const rows = await db.select().from(schema.users).where(eq(schema.users.id, 1));
for (const row of rows) {
  const exactId: number = row.id;
  const exactName: string = row.name;
  const formattedName: string = formatUser(row);
  // @ts-expect-error inferred select columns preserve their scalar types
  const wrongName: number = row.name;
  void exactId;
  void exactName;
  void formattedName;
  void wrongName;
}

const validInsert: UserInsert = { name: "Grace" };
await db.insert(schema.users).values(validInsert);
// @ts-expect-error inferred insert columns reject a numeric name
await db.insert(schema.users).values({ name: 42 });
void exampleInsert;
export default rows;
`,
    },
  };
}

function virtualUriToDiskPath(root: string, uri: string): string {
  const parsed = new URL(uri);
  const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");

  return join(root, pathname);
}

function materializeEnvironment(root: string, environment: Awaited<ReturnType<typeof createProjectTypeEnvironment>>) {
  const files = environment.files.map((file) => ({
    ...file,
    uri: virtualUriToDiskPath(root, file.uri),
  }));
  const projectRoot = "file:///__drizzle_run_project__";
  const diskProjectRoot = join(root, "__drizzle_run_project__");

  for (const file of files) {
    mkdirSync(dirname(file.uri), { recursive: true });
    const content = file.content.replaceAll(projectRoot, diskProjectRoot);
    writeFileSync(file.uri, content);
  }

  return files;
}

function compileEnvironment(...environments: Awaited<ReturnType<typeof createProjectTypeEnvironment>>[]): string {
  const [environment] = environments;
  const root = join(
    tmpdir(),
    `drizzle-run-editor-inference-${environments.map((item) => item.fingerprint).join("-")}-${compilerSessionId}`,
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  try {
    const files = environments.flatMap((item) => materializeEnvironment(root, item));
    const paths = Object.fromEntries(
      Object.entries(environment.compilerOptions.paths).map(([specifier, targets]) => [
        specifier,
        targets.map((uri) => virtualUriToDiskPath(root, uri)),
      ]),
    );
    const typeRoots = environments
      .flatMap((item) => item.compilerOptions.typeRoots ?? [])
      .map((uri) => virtualUriToDiskPath(root, uri));
    const configPath = join(root, "tsconfig.json");
    const projectFiles = files.filter((file) => file.kind === "project" || file.kind === "generated");
    writeFileSync(
      configPath,
      JSON.stringify({
        compilerOptions: {
          ...environment.compilerOptions,
          paths,
          ...(typeRoots.length === 0 ? {} : { typeRoots }),
          skipLibCheck: true,
        },
        files: projectFiles.map((file) => file.uri),
      }),
    );

    const tscPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/runtime/node_modules/typescript/bin/tsc",
    );

    if (!existsSync(tscPath)) {
      throw new Error(`TypeScript compiler is missing: ${tscPath}`);
    }

    try {
      return execFileSync(process.execPath, [tscPath, "-p", configPath, "--pretty", "false"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (cause) {
      const stdout = typeof cause === "object" && cause !== null && "stdout" in cause ? String(cause.stdout) : "";
      const stderr = typeof cause === "object" && cause !== null && "stderr" in cause ? String(cause.stderr) : "";

      if (stdout.length === 0 && stderr.length === 0) {
        throw cause;
      }

      return `${stdout}${stderr}`;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("editor session type namespace inference", () => {
  for (const dialect of ["postgresql", "sqlite"] as const) {
    for (const releaseLine of ["legacy", "next"] as const) {
      it(`preserves ORM row inference for ${dialect} ${releaseLine} projects`, async () => {
        const environment = await createProjectTypeEnvironment(createManifest(dialect, releaseLine));
        const scopedEnvironment = namespaceProjectTypeEnvironment(environment, compilerSessionId);
        const projectUris = scopedEnvironment.files.filter((file) => file.kind === "project").map((file) => file.uri);

        expect(projectUris.length).toBe(3);
        expect(projectUris.every((uri) => uri.includes(`/${compilerSessionId}/`))).toBe(true);
        expect(compileEnvironment(scopedEnvironment)).toBe("");
      }, 120_000);
    }
  }
});

const isolated = async (manifest: RunManifest, sessionId: string, globals: boolean) =>
  isolateProjectTypeEnvironment(
    namespaceProjectTypeEnvironment(
      await createProjectTypeEnvironment(manifest, { contextDeclaration: "module" }),
      sessionId,
    ),
    sessionId,
    { globals },
  );

describe("side by side editor type environments", () => {
  for (const dialect of ["postgresql", "sqlite"] as const) {
    it(`gives each side its own Drizzle types in one ${dialect} program`, async () => {
      const legacy = createManifest(dialect, "legacy");
      const next = createManifest(dialect, "next");

      legacy.files["run.ts"] =
        `// @ts-expect-error 0.45 has no defineRelations\nimport { defineRelations } from "drizzle-orm";\nvoid defineRelations;\n${legacy.files["run.ts"]}`;
      next.files["run.ts"] =
        `import { defineRelations } from "drizzle-orm";\nvoid defineRelations;\n${next.files["run.ts"]}`;

      const sides = await Promise.all([
        isolated(legacy, compilerSessionId, true),
        isolated(next, secondSessionId, false),
      ]);

      expect(sides.every((side) => Object.keys(side.compilerOptions.paths).length === 0)).toBe(true);
      expect(compileEnvironment(...sides)).toBe("");
    }, 120_000);
  }
});
