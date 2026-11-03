import type { Message } from "esbuild-wasm";
import esbuild from "esbuild-wasm";
import * as z from "zod/mini";

import type { Diagnostic, QuickjsManifest } from "./contract.ts";
import type { Catalog, ExecutionAssets } from "./worker-contract.ts";

const BuildFailureSchema = z.object({
  errors: z.array(
    z.object({
      text: z.string(),
      location: z.nullable(z.object({ file: z.string(), line: z.number(), column: z.number() })),
    }),
  ),
});

export class CompilationError extends Error {
  readonly code = "compile_error";

  constructor(
    message: string,
    readonly diagnostics: Diagnostic[],
    options: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompilationError";
  }
}

export const bundlePath = "drizzle-run-bundle.js";
const contextId = "@drizzle-run/runtime/context";
let ready: Promise<void> | undefined;

function resolveProjectFile({
  importer,
  specifier,
  files,
}: {
  importer: string;
  specifier: string;
  files: Record<string, string>;
}) {
  const directory = importer.slice(0, Math.max(0, importer.lastIndexOf("/")));
  const parts: string[] = [];

  for (const part of `${directory}/${specifier}`.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      if (parts.pop() === undefined) {
        throw new Error("Project import escapes its root");
      }
    } else {
      parts.push(part);
    }
  }

  const candidate = parts.join("/");
  const path = [
    candidate,
    ...["ts", "tsx", "mts", "js", "jsx", "mjs", "json"].map((extension) => `${candidate}.${extension}`),
    ...["ts", "mts", "js", "mjs"].map((extension) => `${candidate}/index.${extension}`),
  ].find((name) => Object.hasOwn(files, name));

  if (path === undefined) {
    throw new Error(`Cannot resolve ${specifier} from ${importer}`);
  }

  return path;
}

function toDiagnostic(
  message: { text: string; location: Pick<NonNullable<Message["location"]>, "file" | "line" | "column"> | null },
  severity: Diagnostic["severity"],
): Diagnostic {
  return {
    severity,
    message: message.text,
    ...(message.location
      ? {
          source: message.location.file.replace(/^drizzle-run-project:/, ""),
          line: message.location.line,
          column: message.location.column + 1,
        }
      : {}),
  };
}

/** Bundle manifest files without evaluating them. Approved packages bind to the guest's existing instances. */
export async function compileManifest({
  manifest,
  compilerBytes,
  compilerModule,
  catalog,
}: {
  manifest: QuickjsManifest;
  compilerBytes?: ExecutionAssets["compilerBytes"];
  compilerModule?: WebAssembly.Module;
  catalog: Catalog;
}) {
  if (!compilerModule && !compilerBytes) {
    throw new Error("Missing esbuild compiler bytes or module");
  }

  ready ??= (
    compilerModule ? Promise.resolve(compilerModule) : WebAssembly.compile(new Uint8Array(compilerBytes ?? []))
  ).then((wasmModule) => esbuild.initialize({ wasmModule, worker: false }));
  await ready;
  const approved = new Set(catalog.approved[manifest.target.dialect]);
  const controller = `
    export { __initialize as initializeContext } from ${JSON.stringify(contextId)};
    export const evaluateSchema = () => import(${JSON.stringify(`./${manifest.entrypoints.schema}`)});
    export const evaluateSeed = ${manifest.entrypoints.seed ? `() => import(${JSON.stringify(`./${manifest.entrypoints.seed}`)})` : "async () => undefined"};
    export const evaluateRun = ${manifest.entrypoints.run ? `() => import(${JSON.stringify(`./${manifest.entrypoints.run}`)})` : "async () => undefined"};
  `;
  const context = `
    export let db, schema, client, postgresConnection;
    export const env = Object.freeze(__runManifest.env ?? {}), target = Object.freeze(__runManifest.target);
    export function __initialize(value) { db = value.db; schema = value.schema; client = value.client; postgresConnection = value.postgresConnection; }
  `;

  try {
    const result = await esbuild.build({
      absWorkingDir: "/",
      entryPoints: ["drizzle-run:controller"],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2025",
      outfile: `/${bundlePath}`,
      sourcemap: "external",
      sourcesContent: false,
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "drizzle-run-manifest",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === "entry-point") {
                return { path: args.path, namespace: "drizzle-run-controller" };
              }

              if (args.kind === "require-call" || args.kind === "require-resolve") {
                throw new Error("Playground files use ESM imports; CommonJS require is unavailable.");
              }

              if (args.path === contextId) {
                return { path: args.path, namespace: "drizzle-run-context" };
              }

              if (args.path.startsWith(".")) {
                const importer = args.namespace === "drizzle-run-controller" ? "" : args.importer;

                return {
                  path: resolveProjectFile({ importer, specifier: args.path, files: manifest.files }),
                  namespace: "drizzle-run-project",
                };
              }

              if (!approved.has(args.path)) {
                throw new Error(`Unapproved project import: ${args.path}`);
              }

              return { path: args.path, namespace: "drizzle-run-package" };
            });
            builder.onLoad({ filter: /.*/, namespace: "drizzle-run-controller" }, () => ({
              contents: controller,
              loader: "js",
            }));
            builder.onLoad({ filter: /.*/, namespace: "drizzle-run-context" }, () => ({
              contents: context,
              loader: "js",
            }));
            builder.onLoad({ filter: /.*/, namespace: "drizzle-run-project" }, ({ path }) => ({
              contents: /\.(?:json|sql)$/.test(path) ? manifest.files[path] : `${manifest.files[path]}\nexport {};`,
              loader: path.endsWith(".json")
                ? "json"
                : path.endsWith(".sql")
                  ? "text"
                  : path.endsWith(".tsx")
                    ? "tsx"
                    : path.endsWith(".jsx")
                      ? "jsx"
                      : /\.(m?js)$/.test(path)
                        ? "js"
                        : "ts",
            }));
            builder.onLoad({ filter: /.*/, namespace: "drizzle-run-package" }, ({ path }) => ({
              contents: catalog.exports[path]
                .map((name, index) => {
                  const value =
                    path === "drizzle-seed" && name === "seed" && manifest.seedGeneratorVersion
                      ? `(db, schema, options) => kitProbe.modules["drizzle-seed"].seed(db, schema, { ...options, version: options?.version ?? ${JSON.stringify(manifest.seedGeneratorVersion)} })`
                      : `kitProbe.modules[${JSON.stringify(path)}][${JSON.stringify(name)}]`;

                  return `const v${index} = ${value}; export { v${index} as ${JSON.stringify(name)} };`;
                })
                .join("\n"),
              loader: "js",
            }));
          },
        },
      ],
    });

    const bundle = result.outputFiles.find((file) => file.path === `/${bundlePath}`);
    const sourceMap = result.outputFiles.find((file) => file.path === `/${bundlePath}.map`);

    if (!bundle || !sourceMap) {
      throw new Error("esbuild returned no project bundle or source map");
    }

    return {
      code: bundle.text,
      sourceMap: sourceMap.text,
      warnings: result.warnings.map((message) => toDiagnostic(message, "warning")),
    };
  } catch (cause) {
    const failure = BuildFailureSchema.safeParse(cause);

    if (!failure.success) {
      throw cause;
    }

    const diagnostics = failure.data.errors.map((message) => toDiagnostic(message, "error"));

    throw new CompilationError(diagnostics[0]?.message ?? String(cause), diagnostics, { cause });
  }
}

/** Release the compiler service; the execution container owns the final memory reclamation. */
export async function stopCompiler() {
  await esbuild.stop();
  ready = undefined;
}
