import type { ProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";

const virtualRoots = [
  "file:///__drizzle_run_project__/",
  "file:///__drizzle_run_generated__/",
  "file:///__drizzle_run_types__/",
] as const;

function namespaceUri(uri: string, slotId: string): string {
  const root = virtualRoots.find((candidate) => uri.startsWith(candidate));

  if (root === undefined) {
    return uri;
  }

  return `${root}${slotId}/${uri.slice(root.length)}`;
}

function namespaceReferences(content: string, slotId: string): string {
  return virtualRoots.reduce((scopedContent, root) => scopedContent.replaceAll(root, `${root}${slotId}/`), content);
}

const absoluteModuleReference =
  /(\bimport\(\s*|\bfrom\s+)"(file:\/\/\/__drizzle_run_(?:project|generated|types)__\/[^"]+)"/g;

/**
 * TypeScript skips a module specifier that looks like an absolute URI, so `typeof import("file:///…")` in the
 * generated context would type the schema, and every `db` query, as `any`. Writes each one relative to `fromUri`.
 */
function relativizeModuleReferences(content: string, fromUri: string): string {
  return content.replace(
    absoluteModuleReference,
    (_reference, prefix: string, targetUri: string) =>
      `${prefix}${JSON.stringify(toRelativeSpecifier(fromUri, targetUri))}`,
  );
}

/**
 * Moves a type environment's virtual files under the editor slot's own roots, such as `slot-0`, so two editors open
 * on one page never share models. Throws a `TypeError` for a slot id that is not 1 to 32 lowercase letters, digits or
 * hyphens.
 */
export function namespaceProjectTypeEnvironment(
  environment: ProjectTypeEnvironment,
  slotId: string,
): ProjectTypeEnvironment {
  if (!/^[a-z0-9-]{1,32}$/.test(slotId)) {
    throw new TypeError(
      `Expected an editor slot ID of 1 to 32 lowercase letters, digits or hyphens, but got "${slotId}".`,
    );
  }

  const scopedUri = (uri: string): string => namespaceUri(uri, slotId);
  const files = environment.files.map((file) => {
    const uri = scopedUri(file.uri);

    return {
      ...file,
      uri,
      content:
        file.kind === "project"
          ? file.content
          : relativizeModuleReferences(namespaceReferences(file.content, slotId), uri),
    };
  });
  const paths = Object.fromEntries(
    Object.entries(environment.compilerOptions.paths).map(([specifier, targets]) => [
      specifier,
      targets.map(scopedUri),
    ]),
  );

  return {
    ...environment,
    compilerOptions: {
      ...environment.compilerOptions,
      paths,
      ...(environment.compilerOptions.typeRoots === undefined
        ? {}
        : { typeRoots: environment.compilerOptions.typeRoots.map(scopedUri) }),
    },
    files,
  };
}

const declarationSuffix = ".d.ts";
const fileRoot = "file:///";
const typeScriptExtension = /(?:\.d)?\.[cm]?tsx?$/;

/** `target` as a module specifier relative to the directory of `from`, without its TypeScript extension. */
function toRelativeSpecifier(from: string, target: string): string {
  const fromParts = from.slice(fileRoot.length).split("/").slice(0, -1);
  const targetParts = target.slice(fileRoot.length).replace(typeScriptExtension, "").split("/");
  let shared = 0;

  while (shared < fromParts.length && shared < targetParts.length - 1 && fromParts[shared] === targetParts[shared]) {
    shared += 1;
  }

  const up = fromParts.slice(shared).map(() => "..");
  const relative = [...up, ...targetParts.slice(shared)].join("/");

  return up.length === 0 ? `./${relative}` : relative;
}

function reexport(stubUri: string, target: { uri: string; content: string }): string {
  const specifier = JSON.stringify(toRelativeSpecifier(stubUri, target.uri));

  if (/^\s*export\s*=/m.test(target.content)) {
    return `import target = require(${specifier});\nexport = target;\n`;
  }

  const hasDefault = /\bexport\s+default\b|\bas\s+default\b/.test(target.content);

  return `export * from ${specifier};\n${hasDefault ? `export { default } from ${specifier};\n` : ""}`;
}

/**
 * Two editors on one page share Monaco's single TypeScript program, whose `paths` would send both
 * to one side's packages. This resolves each slot's packages through `node_modules` stubs under
 * its own roots instead, so every file finds the packages of its slot and `paths` stays empty.
 * Expects an environment already scoped by `namespaceProjectTypeEnvironment` with `slotId`, and
 * created with `contextDeclaration: "module"`. Only one environment of a program keeps `globals`
 * (the `$` helpers), which every slot declares alike.
 */
export function isolateProjectTypeEnvironment(
  environment: ProjectTypeEnvironment,
  slotId: string,
  { globals }: { globals: boolean },
): ProjectTypeEnvironment {
  const byUri = new Map(environment.files.map((file) => [file.uri, file]));
  const targets = new Map<string, string>();

  for (const [specifier, [target]] of Object.entries(environment.compilerOptions.paths)) {
    if (target === undefined) {
      continue;
    }

    if (!specifier.endsWith("/*")) {
      targets.set(specifier, target);
      continue;
    }

    const base = target.slice(0, -1);

    for (const file of environment.files) {
      if (file.uri.startsWith(base) && file.uri.endsWith(declarationSuffix)) {
        const subpath = decodeURIComponent(file.uri.slice(base.length, -declarationSuffix.length));

        if (!targets.has(`${specifier.slice(0, -1)}${subpath}`)) {
          targets.set(`${specifier.slice(0, -1)}${subpath}`, file.uri);
        }
      }
    }
  }

  const stubs = virtualRoots.flatMap((root) =>
    [...targets].flatMap(([specifier, target]) => {
      const file = byUri.get(target);

      if (file === undefined) {
        return [];
      }

      // Module resolution looks up the specifier as written, so the stub path is not URI-encoded.
      const uri = `${root}${slotId}/node_modules/${specifier}${declarationSuffix}`;

      return [{ uri, content: reexport(uri, file), kind: "library" as const }];
    }),
  );

  return {
    ...environment,
    compilerOptions: { ...environment.compilerOptions, paths: {} },
    files: [
      ...environment.files.filter(
        (file) => globals || !(file.kind === "generated" && file.uri.endsWith("/playground-tools.d.ts")),
      ),
      ...stubs,
    ],
  };
}
