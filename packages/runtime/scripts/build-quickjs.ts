import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSupportedTuple } from "@drizzle-run/core/catalog";
import { listApprovedModules, listGuestImages, type GuestImage } from "@drizzle-run/core/registry";
import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";
import * as z from "zod/mini";

import { installGuests } from "../../../scripts/guests/install.ts";
import { guestAssetPrefix } from "../src/quickjs/selection.ts";

const runtimeDirectory = fileURLToPath(new URL("../", import.meta.url));
const images = listGuestImages();
const guestInstalls = await installGuests(images.map((image) => image.id));
const guestInstall = guestInstalls[0];

if (process.argv.includes("--typecheck")) {
  const typecheckDirectory = resolve(runtimeDirectory, ".cache/quickjs");
  const configuration = resolve(typecheckDirectory, "tsconfig.json");
  await mkdir(typecheckDirectory, { recursive: true });
  await writeFile(
    configuration,
    JSON.stringify(
      {
        extends: resolve(runtimeDirectory, "tsconfig.quickjs.json"),
        compilerOptions: {
          paths: {
            pg: [resolve(guestInstall.directory, "node_modules/@types/pg/index.d.ts")],
            "@libsql/client": [resolve(guestInstall.directory, "node_modules/@libsql/client/lib-esm/node.d.ts")],
            "zod/mini": [resolve(runtimeDirectory, "node_modules/zod/mini/index.d.ts")],
            xstate: [resolve(runtimeDirectory, "node_modules/xstate/dist/declarations/src/index.d.ts")],
            "drizzle-orm/node-postgres": [
              resolve(guestInstall.directory, "node_modules/drizzle-orm/node-postgres/index.d.ts"),
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  const result = spawnSync(resolve(runtimeDirectory, "node_modules/.bin/tsc"), ["-p", configuration], {
    cwd: runtimeDirectory,
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

const outputDirectory = resolve(runtimeDirectory, "../../.cache/runtime-assets/quickjs");
const runtimeRequire = createRequire(new URL("../package.json", import.meta.url));
const builtinNames = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const ResolutionErrorSchema = z.object({ code: z.enum(["MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]) });
const resolvedPluginData = Symbol("resolved");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const ManifestSchema = z.object({ dependencies: z.record(z.string(), z.string()) });

/** Ask the bundler for public exports without executing optional native drivers. */
async function readExports(path: string): Promise<string[]> {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  return Object.values(result.metafile.outputs)
    .flatMap((output) => output.exports)
    .toSorted();
}

async function buildGuest({ image, dialect }: { image: GuestImage; dialect: "postgresql" | "sqlite" }) {
  const guestInstall = guestInstalls.find((install) => install.imageId === image.id);

  if (!guestInstall) {
    throw new Error(`Missing guest installation: ${image.id}`);
  }

  const { dependencies } = ManifestSchema.parse(
    JSON.parse(await readFile(resolve(guestInstall.directory, "package.json"), "utf8")),
  );
  const guestRequire = createRequire(resolve(guestInstall.directory, "package.json"));
  const guestOutput = resolve(outputDirectory, guestAssetPrefix({ imageId: image.id, dialect }));
  const kitSpecifier =
    image.releaseLine === "legacy"
      ? "drizzle-kit/api"
      : dialect === "postgresql"
        ? "drizzle-kit/api-postgres"
        : "drizzle-kit/payload/sqlite";
  await mkdir(guestOutput, { recursive: true });

  const approved = Object.fromEntries(
    [dialect].map((dialect) => {
      const tuple = findSupportedTuple({
        target: { dialect },
        ormVersion: image.ormVersion,
        kitVersion: image.kitVersion,
      });

      if (!tuple) {
        throw new Error(`The pinned QuickJS guest is not registered for ${dialect}`);
      }
      const specifiers = listApprovedModules({ tuple, guestFlavor: image.guestFlavor })
        .filter((entry) => entry.visibility === "user" && entry.runtimeArtifact.loader === "guest_package")
        .flatMap((entry) => entry.allowedSpecifiers);

      return [dialect, specifiers];
    }),
  );
  const specifiers = [...new Set(Object.values(approved).flat())];
  const resolvedSpecifiers = new Map<string, string>();

  // Resolve import conditions with the same bundler used for the guest, without loading dependency code.
  await build({
    stdin: {
      contents: [...specifiers, kitSpecifier].map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n"),
      resolveDir: guestInstall.directory,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "quickjs-import-paths",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData === resolvedPluginData) {
              return undefined;
            }

            const resolution = await builder.resolve(args.path, {
              kind: "import-statement",
              resolveDir: guestInstall.directory,
              pluginData: resolvedPluginData,
            });

            if (resolution.errors.length > 0) {
              return resolution;
            }

            resolvedSpecifiers.set(args.path, resolution.path);

            return { path: resolution.path, external: true };
          });
        },
      },
    ],
  });

  function getResolvedSpecifier(specifier: string) {
    const path = resolvedSpecifiers.get(specifier);

    if (!path) {
      throw new Error(`Missing pinned ESM dependency: ${specifier}`);
    }

    return path;
  }

  const publishedExports = Object.fromEntries(
    await Promise.all(
      specifiers.map(async (specifier) => {
        return [specifier, await readExports(getResolvedSpecifier(specifier))];
      }),
    ),
  );
  const entry = `
  globalThis.Buffer = Buffer;
  export { configureProjectFiles } from ${JSON.stringify(resolve(runtimeDirectory, "scripts/quickjs/filesystem.ts"))};
  ${image.releaseLine === "legacy" ? 'import * as singleStoreCore from "drizzle-orm/singlestore-core"; export const kitInternalModules = { singleStoreCore };' : ""}
  import { ${dialect === "sqlite" && image.releaseLine === "legacy" ? "generateSQLiteDrizzleJson as generateDrizzleJson, generateSQLiteMigration as generateMigration" : "generateDrizzleJson, generateMigration"} } from ${JSON.stringify(getResolvedSpecifier(kitSpecifier))};
  import { drizzle } from ${JSON.stringify(dialect === "postgresql" ? "drizzle-orm/node-postgres" : "drizzle-orm/libsql/web")};
  import { createPostgresClient } from ${JSON.stringify(resolve(runtimeDirectory, "../../guests/quickjs-client.ts"))};
  ${dialect === "postgresql" ? `import { createPostgresGuestSession } from ${JSON.stringify(resolve(runtimeDirectory, "../../guests/quickjs-postgres.ts"))};` : ""}
  ${dialect === "sqlite" ? `import { createSqliteGuestClient } from ${JSON.stringify(resolve(runtimeDirectory, "../../guests/quickjs-sqlite.ts"))}; import { ResultSetImpl } from "@libsql/core/util";` : ""}
  export { encodeResult } from ${JSON.stringify(resolve(runtimeDirectory, "../../guests/quickjs-client.ts"))};
  export { createRunObservation } from ${JSON.stringify(resolve(runtimeDirectory, "../../guests/quickjs-observation.ts"))};
  export { initializeExecution, applyPostgresBootstrap } from ${JSON.stringify(resolve(runtimeDirectory, "../../guests/quickjs-execution.ts"))};
  export const modules = { ${specifiers.map((specifier) => `get ${JSON.stringify(specifier)}() { return require(${JSON.stringify(getResolvedSpecifier(specifier))}); }`).join(",\n")} };
  export async function initializeRun(schema, env, observation) {
    ${dialect === "postgresql" ? "const session = createPostgresGuestSession(observation);" : ""}
    const client = observation.observeClient(${dialect === "postgresql" ? "await createPostgresClient(session.main)" : "createSqliteGuestClient(ResultSetImpl)"}, ${JSON.stringify(dialect)});
    const db = ${image.releaseLine === "legacy" ? "drizzle(client, { schema })" : "drizzle({ client, relations: schema.relations ?? {}, paramsInErrors: true })"};
    return { client, db: observation.observeDatabase(db), schema, env, target: { dialect: ${JSON.stringify(dialect)} }, ${dialect === "postgresql" ? 'postgresConnection: Object.freeze({ username: "postgres", database: "postgres", stream: session.connection }), close: session.close' : "close: async () => {}"} };
  }
  export async function generateSql(schema) {
    const previous = await generateDrizzleJson({});
    const current = await generateDrizzleJson(schema, previous.id);
    return generateMigration(previous, current);
  }
`;
  const guest = await build({
    stdin: { contents: entry, resolveDir: runtimeDirectory, sourcefile: "quickjs-guest-entry.ts", loader: "ts" },
    bundle: true,
    format: "iife",
    globalName: "kitProbe",
    platform: "browser",
    target: "es2022",
    inject: [resolve(runtimeDirectory, "scripts/quickjs/globals.ts")],
    define: { "import.meta.url": '"file:///dependencies.js"', global: "globalThis" },
    minify: true,
    write: false,
    metafile: true,
    logLevel: "error",
    plugins: [
      {
        name: "quickjs-pinned-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /^(node:)?[^./]/ }, async (args) => {
            if (args.pluginData === resolvedPluginData) {
              return undefined;
            }

            const name = args.path.replace(/^node:/, "");

            if (builtinNames.has(name)) {
              if (name === "fs" || name === "crypto") {
                return {
                  path: resolve(runtimeDirectory, "scripts/quickjs", name === "fs" ? "filesystem.ts" : "crypto.ts"),
                };
              }

              const overrides: Record<string, string> = { module: "module.ts", async_hooks: "async-context.ts" };

              return {
                path: overrides[name]
                  ? resolve(runtimeDirectory, "scripts/quickjs", overrides[name])
                  : runtimeRequire.resolve(`unenv/node/${name}`),
              };
            }

            if (args.path.startsWith("unenv")) {
              return { path: runtimeRequire.resolve(args.path) };
            }

            if (args.path === "xstate") {
              return builder.resolve(args.path, {
                resolveDir: runtimeDirectory,
                kind: "import-statement",
                pluginData: resolvedPluginData,
              });
            }

            const packageName = args.path.startsWith("@")
              ? args.path.split("/").slice(0, 2).join("/")
              : args.path.split("/")[0];
            const pinned = Object.hasOwn(dependencies, packageName) || packageName === "@libsql/core";

            try {
              (pinned ? guestRequire : createRequire(args.importer)).resolve(args.path);
            } catch (cause) {
              if (ResolutionErrorSchema.safeParse(cause).success) {
                return { path: args.path, external: true };
              }

              throw cause;
            }

            const resolution = await builder.resolve(args.path, {
              resolveDir: pinned ? guestInstall.directory : args.resolveDir,
              kind: pinned ? "import-statement" : args.kind,
              pluginData: resolvedPluginData,
            });

            return { ...resolution, pluginData: undefined };
          });
        },
      },
    ],
  });
  const ormDirectory = dirname(guestRequire.resolve("drizzle-orm"));
  const foreignOrmInputs = Object.keys(guest.metafile.inputs).filter(
    (path) => path.includes("/node_modules/drizzle-orm/") && !resolve(path).startsWith(`${ormDirectory}/`),
  );

  if (foreignOrmInputs.length > 0) {
    throw new Error(`QuickJS guest contains a foreign ORM installation: ${foreignOrmInputs.join(", ")}`);
  }

  await Promise.all([
    writeFile(resolve(guestOutput, "execution.guest.js"), guest.outputFiles[0].contents),
    writeFile(
      resolve(guestOutput, "catalog.json"),
      JSON.stringify(
        { selection: { imageId: image.id, dialect }, pins: dependencies, approved, exports: publishedExports },
        null,
        2,
      ),
    ),
  ]);

  console.log(`QuickJS ${image.id}/${dialect}: ${guest.outputFiles[0].contents.length} guest bytes`);
}

for (const image of images) {
  for (const dialect of ["postgresql", "sqlite"] as const) {
    await buildGuest({ image, dialect });
  }
}

await Promise.all([
  ...["quickjs.wasm", "encoding.so", "url.so"].map((name) =>
    copyFile(runtimeRequire.resolve(`quickjs-wasi/${name}`), resolve(outputDirectory, name)),
  ),
  copyFile(runtimeRequire.resolve("esbuild-wasm/esbuild.wasm"), resolve(outputDirectory, "esbuild.wasm")),
  copyFile(
    resolve(dirname(runtimeRequire.resolve("@electric-sql/pglite-pgvector")), "vector.tar.gz"),
    resolve(outputDirectory, "vector.tar.gz"),
  ),
  ...["pglite.wasm", "pglite.data", "initdb.wasm"].map((name) =>
    copyFile(resolve(dirname(runtimeRequire.resolve("@electric-sql/pglite")), name), resolve(outputDirectory, name)),
  ),
  copyFile(runtimeRequire.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"), resolve(outputDirectory, "sqlite3.wasm")),
]);

await build({
  entryPoints: {
    browser: resolve(runtimeDirectory, "src/quickjs/browser.ts"),
    "execution-worker": resolve(runtimeDirectory, "src/quickjs/browser-worker.ts"),
    "database-worker": resolve(runtimeDirectory, "src/database/browser-worker.ts"),
  },
  outdir: outputDirectory,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2025",
  external: ["node:fs", "node:fs/promises", "node:path", "node:url", "node:module", "node:crypto"],
});
await build({
  entryPoints: [resolve(runtimeDirectory, "src/quickjs/node-worker.ts")],
  outfile: resolve(outputDirectory, "node-worker.js"),
  banner: {
    js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2025",
  alias: { "esbuild-wasm": runtimeRequire.resolve("esbuild-wasm/lib/browser.js") },
  external: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "quickjs-wasi"],
});

await build({
  entryPoints: [resolve(runtimeDirectory, "src/database/node-worker.ts")],
  outfile: resolve(outputDirectory, "node-database-worker.js"),
  banner: {
    js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2025",
  external: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
});

const database = await PGlite.create();

try {
  const image = await database.dumpDataDir("gzip");
  await writeFile(resolve(outputDirectory, "postgres-template.tar.gz"), new Uint8Array(await image.arrayBuffer()));
} finally {
  await database.close();
}

console.log(`QuickJS assets: ${outputDirectory}`);
