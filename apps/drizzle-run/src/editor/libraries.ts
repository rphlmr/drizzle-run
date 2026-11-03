import type { ProjectCompilerOptions } from "@drizzle-run/runtime/type-environment";

type GuestLibrary = ProjectCompilerOptions["lib"][number];

// Monaco's bundled TypeScript has no `es2025.*` files: it ships the same Set, Float16Array, Iterator and
// Promise.try declarations as `esnext.*`, and keeps the DOM and worker iterables in files of their own. It has no
// declaration of `RegExp.escape` at all, so that one ships as an extra lib.
const MONACO_LIBRARY_FILES = {
  ES2022: ["lib.es2022.d.ts"],
  "ES2023.Array": ["lib.es2023.array.d.ts"],
  "ES2023.Collection": ["lib.es2023.collection.d.ts"],
  "ES2024.ArrayBuffer": ["lib.es2024.arraybuffer.d.ts"],
  "ES2024.Collection": ["lib.es2024.collection.d.ts"],
  "ES2024.Object": ["lib.es2024.object.d.ts"],
  "ES2024.Promise": ["lib.es2024.promise.d.ts"],
  "ES2024.Regexp": ["lib.es2024.regexp.d.ts"],
  "ES2024.String": ["lib.es2024.string.d.ts"],
  "ES2025.Collection": ["lib.esnext.collection.d.ts"],
  "ES2025.Float16": ["lib.esnext.float16.d.ts"],
  "ES2025.Iterator": ["lib.esnext.iterator.d.ts"],
  "ES2025.Promise": ["lib.esnext.promise.d.ts"],
  "ES2025.Regexp": [],
  DOM: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.dom.asynciterable.d.ts"],
  WebWorker: ["lib.webworker.d.ts", "lib.webworker.iterable.d.ts", "lib.webworker.asynciterable.d.ts"],
} as const satisfies Record<GuestLibrary, readonly string[]>;

const MONACO_EXTRA_LIBRARIES: Partial<Record<GuestLibrary, { fileName: string; content: string }>> = {
  "ES2025.Regexp": {
    fileName: "lib.es2025.regexp.d.ts",
    content: "interface RegExpConstructor {\n  escape(string: string): string;\n}\n",
  },
};

/** The libraries Monaco's TypeScript loads for a type environment, as its own lib files and extra declarations. */
export interface MonacoLibraries {
  /** Lib file names for Monaco's `lib` compiler option. */
  files: string[];
  /** Declarations Monaco has no lib file for, added with `addExtraLib`. */
  extraLibs: { fileName: string; content: string }[];
}

/**
 * Resolve Monaco libraries
 *
 * Maps the guest's `lib` names to what Monaco's bundled TypeScript knows, so the editor accepts exactly the globals the
 * QuickJS guest implements. Monaco reads `lib` as file names, not the `tsconfig` names the runtime uses.
 */
export function resolveMonacoLibraries(lib: ProjectCompilerOptions["lib"]): MonacoLibraries {
  const files = lib.flatMap((library) => MONACO_LIBRARY_FILES[library]);
  const extraLibs = lib.flatMap((library) => {
    const extraLib = MONACO_EXTRA_LIBRARIES[library];

    return extraLib === undefined ? [] : [extraLib];
  });

  return { files, extraLibs };
}
