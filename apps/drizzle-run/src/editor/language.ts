/** A language the editor highlights. */
export type EditorLanguage = "javascript" | "json" | "sql" | "typescript";

/** The editor language for a file, by its extension; TypeScript for unknown ones. */
export function getEditorLanguage(path: string): EditorLanguage {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  if (extension === "json") {
    return "json";
  }

  if (extension === "sql") {
    return "sql";
  }

  if (extension === "js" || extension === "jsx" || extension === "mjs") {
    return "javascript";
  }

  return "typescript";
}
