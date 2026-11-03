import { readFileSync } from "node:fs";

/**
 * Reads the starting files of an official example version, by its folder under `examples/`,
 * so a guide and its example share one copy. Guides run in Node at build time; only the
 * compiled `guide.json` ships.
 */
export function readExampleFiles<const Name extends string>(
  folder: string,
  names: readonly Name[],
): Record<Name, string> {
  const files: Partial<Record<Name, string>> = {};

  for (const name of names) {
    files[name] = readFileSync(new URL(`../examples/${folder}/files/${name}`, import.meta.url), "utf8");
  }

  if (!hasEveryFile(files, names)) {
    throw new Error(`Example ${folder} is missing one of its files: ${names.join(", ")}`);
  }

  return files;
}

function hasEveryFile<const Name extends string>(
  files: Partial<Record<Name, string>>,
  names: readonly Name[],
): files is Record<Name, string> {
  return names.every((name) => files[name] !== undefined);
}
