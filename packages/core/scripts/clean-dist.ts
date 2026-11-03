import { readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));

if (outputDirectory !== resolve(join(packageRoot, "dist"))) {
  throw new Error(`Refusing to clean an unexpected build directory: ${outputDirectory}`);
}

async function clearFiles(directory: string): Promise<void> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }

    throw cause;
  }

  await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);

      return entry.isDirectory() ? clearFiles(path) : unlink(path);
    }),
  );
}

await clearFiles(outputDirectory);
