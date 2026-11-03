/** The project file a diagnostic's source names, or undefined when it names none of `files`. */
export function resolveDiagnosticFile(source: string | undefined, files: readonly string[]): string | undefined {
  if (!source) {
    return undefined;
  }

  const path = source.replace(/^drizzle-run-project:/, "");

  if (files.includes(path)) {
    return path;
  }

  return files.toSorted((left, right) => right.length - left.length).find((file) => path.endsWith(`/${file}`));
}
