import { Buffer } from "node:buffer";

import filesystem from "unenv/node/fs";

export * from "unenv/node/fs";

let projectFiles = new Map<string, string>();

function normalizePath(path: string): string {
  if (path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Project filesystem requires a relative path: ${path}`);
  }

  const parts: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      if (parts.pop() === undefined) {
        throw new Error(`Project filesystem path escapes its root: ${path}`);
      }
    } else {
      parts.push(part);
    }
  }

  return parts.join("/");
}

/** Replace the read-only guest filesystem with this run's validated manifest files. */
export function configureProjectFiles(files: Readonly<Record<string, string>>): void {
  projectFiles = new Map(Object.entries(files).map(([path, content]) => [normalizePath(path), content]));
}

/** Check only project files and their parent directories, without accessing the host. */
export function existsSync(path: string): boolean {
  const normalized = normalizePath(path);

  return (
    normalized === "" ||
    projectFiles.has(normalized) ||
    [...projectFiles.keys()].some((file) => file.startsWith(`${normalized}/`))
  );
}

/** Read a manifest file as UTF-8 bytes, or decode it with the requested Buffer encoding. */
export function readFileSync(path: string, encoding?: BufferEncoding | null): Buffer | string {
  const content = projectFiles.get(normalizePath(path));

  if (content === undefined) {
    throw Object.assign(new Error(`Project file does not exist: ${path}`), { code: "ENOENT", path });
  }

  const bytes = Buffer.from(content, "utf8");

  return encoding ? bytes.toString(encoding) : bytes;
}

/** List immediate project directory entries, including directories inferred from file paths. */
export function readdirSync(path: string): string[] {
  const normalized = normalizePath(path);
  const prefix = normalized === "" ? "" : `${normalized}/`;
  const entries = new Set<string>();

  for (const file of projectFiles.keys()) {
    if (file.startsWith(prefix)) {
      entries.add(file.slice(prefix.length).split("/")[0]);
    }
  }

  if (entries.size === 0 && normalized !== "") {
    throw Object.assign(new Error(`Project directory does not exist: ${path}`), { code: "ENOENT", path });
  }

  return [...entries].toSorted();
}

export default { ...filesystem, existsSync, readFileSync, readdirSync };
