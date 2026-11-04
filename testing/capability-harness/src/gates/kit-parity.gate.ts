import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

import type * as Esbuild from "esbuild";
import type * as QuickjsWasi from "quickjs-wasi";
import * as z from "zod";

import { loadNodeAssets } from "../../../../packages/runtime/src/quickjs/node-assets.ts";
import { createExecutionVm } from "../../../../packages/runtime/src/quickjs/vm.ts";
import { createGuestPackageLocator } from "../../../../scripts/guests/guest-installs.ts";
import type { GuestPackage } from "../../../../scripts/guests/guest-packages.ts";
import type { Dialect } from "./contract.ts";

const runtimeRequire = createRequire(new URL("../../../../packages/runtime/package.json", import.meta.url));
const { build }: typeof Esbuild = runtimeRequire("esbuild");
const { EvalFlags }: typeof QuickjsWasi = runtimeRequire("quickjs-wasi");
const expectedIds = z
  .array(z.string())
  .parse(JSON.parse(await readFile(new URL("../kit-corpus/case-ids.json", import.meta.url), "utf8")));
const CorpusSchema = z.object({
  cases: z.array(
    z.object({
      id: z.string(),
      schema: z.function({ input: z.tuple([]), output: z.unknown() }),
      empty: z.optional(z.boolean()),
    }),
  ),
});
const KitResultsSchema = z.array(z.object({ id: z.string(), statements: z.array(z.string()), empty: z.boolean() }));
const SnapshotSchema = z.looseObject({ id: z.string() });
const locator = await createGuestPackageLocator(fileURLToPath(new URL("../../../../guests", import.meta.url)));
const assetsDirectory = new URL("../../../../packages/runtime/dist/quickjs/", import.meta.url);

/** Compile the same typed schema corpus against either native imports or the shipped guest module inventory. */
async function compileCorpus({
  image,
  dialect,
  runtime,
}: {
  image: GuestPackage;
  dialect: Dialect;
  runtime: "native" | "quickjs";
}) {
  const source = fileURLToPath(
    new URL(`../kit-corpus/${image.ormApi === "v0" ? "legacy" : "next"}.ts`, import.meta.url),
  );
  const guestRequire = createRequire(`${locator.locate("drizzle-orm", image.ormVersion)}/package.json`);
  const result = await build({
    stdin: {
      contents: `export { ${dialect === "postgresql" ? "postgresCases" : "sqliteCases"} as cases } from ${JSON.stringify(source)};`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "corpus",
    platform: "node",
    target: "es2022",
    plugins: [
      {
        name: "corpus-orm",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^drizzle-orm/ }, ({ path }) =>
            runtime === "native" ? { path: guestRequire.resolve(path) } : { path, namespace: "guest" },
          );
          pluginBuild.onLoad({ filter: /.*/, namespace: "guest" }, ({ path }) => ({
            contents: `module.exports = kitProbe.modules[${JSON.stringify(path)}];`,
          }));
        },
      },
    ],
  });

  return result.outputFiles[0].text;
}

async function evaluate(vm: Awaited<ReturnType<typeof createExecutionVm>>["vm"], source: string) {
  const handle = vm.evalCode(source, "kit-corpus.js", EvalFlags.TYPE_MODULE);

  try {
    const pending = vm.resolvePromise(handle);
    vm.executePendingJobs();
    const result = await pending;

    if ("error" in result) {
      const message = result.error.toString();
      result.error.dispose();

      throw new Error(message);
    }

    result.value.dispose();
  } finally {
    handle.dispose();
  }
}

async function runDialect(image: GuestPackage, dialect: Dialect) {
  const nativeSource = await compileCorpus({ image, dialect, runtime: "native" });
  const { cases } = CorpusSchema.parse(compileFunction(`${nativeSource}; return corpus;`)());
  const kitPackage = locator.locate("drizzle-kit", image.kitVersion);
  const kitRequire = createRequire(`${kitPackage}/package.json`);
  const kit = z
    .record(z.string(), z.unknown())
    .parse(
      kitRequire(
        image.kitApi === "v0"
          ? "drizzle-kit/api"
          : dialect === "postgresql"
            ? "drizzle-kit/api-postgres"
            : "drizzle-kit/payload/sqlite",
      ),
    );
  const generateJson = z
    .function({ input: z.tuple([z.unknown(), z.optional(z.string())]), output: z.unknown() })
    .parse(image.kitApi === "v0" && dialect === "sqlite" ? kit.generateSQLiteDrizzleJson : kit.generateDrizzleJson);
  const generateMigration = z
    .function({ input: z.tuple([z.unknown(), z.unknown()]), output: z.unknown() })
    .parse(image.kitApi === "v0" && dialect === "sqlite" ? kit.generateSQLiteMigration : kit.generateMigration);
  const native: z.infer<typeof KitResultsSchema> = [];

  for (const fixture of cases) {
    const previous = SnapshotSchema.parse(await generateJson({}));
    const current = await generateJson(fixture.schema(), previous.id);
    native.push({
      id: fixture.id,
      statements: z.array(z.string()).parse(await generateMigration(previous, current)),
      empty: fixture.empty === true,
    });
  }

  const assets = await loadNodeAssets({ directory: assetsDirectory, selection: { imageId: image.id, dialect } });
  const wasm = await WebAssembly.compile(assets.wasmBytes);
  const extensions = await Promise.all(
    assets.extensionBytes.map(async ({ name, bytes }) => ({ name, wasm: await WebAssembly.compile(bytes) })),
  );
  const { vm } = await createExecutionVm({ wasm, extensions, modules: new Map(), startedAtMs: performance.now() });

  try {
    vm.evalCode(assets.bundle, "dependencies.js").dispose();
    vm.evalCode(await compileCorpus({ image, dialect, runtime: "quickjs" }), "corpus.js").dispose();
    await evaluate(
      vm,
      `globalThis.results = []; for (const fixture of corpus.cases) {
      results.push({ id: fixture.id, statements: await kitProbe.generateSql(fixture.schema()), empty: fixture.empty === true });
    }`,
    );
    const handle = vm.evalCode("JSON.stringify(results)");
    let actual;

    try {
      actual = KitResultsSchema.parse(JSON.parse(handle.toString()));
    } finally {
      handle.dispose();
    }

    assert.deepEqual(
      actual.map(({ id }) => `${dialect}:${id}`).toSorted(),
      expectedIds.filter((id) => id.startsWith(`${dialect}:`)),
    );
    assert.deepEqual(actual, native, `${image.id} ${dialect} native/QuickJS Kit SQL parity`);

    for (const result of actual) {
      assert.equal(result.statements.length === 0, result.empty, `${result.id} generated statements`);
    }

    console.log(`PASS ${image.id} / ${dialect}: ${actual.length} native/QuickJS Kit scenarios`);
  } finally {
    vm.dispose();
  }
}

let checked = 0;

for (const image of locator.guests) {
  if (process.env.DRIZZLE_RUN_KIT_PARITY_PAIR && process.env.DRIZZLE_RUN_KIT_PARITY_PAIR !== image.id) {
    continue;
  }

  for (const dialect of ["postgresql", "sqlite"] as const) {
    await runDialect(image, dialect);
    checked += 1;
  }
}

assert.ok(checked > 0, "Kit parity filter must select a guest");
