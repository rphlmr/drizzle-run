/** An index is kept only when it makes the query at least this many times cheaper or faster. */
export const INDEX_IMPROVEMENT_FACTOR = 10;

/**
 * Below this floor, timer and worker-hop noise make a tenfold timing drop unreliable.
 */
export const SQLITE_TIMING_FLOOR_MS = 1;

/** The tenfold rule: the database used the index and the measure dropped at least tenfold. */
export function confirmsIndex(input: { used: boolean; unit: "cost" | "ms"; before: number; after: number }): boolean {
  if (!input.used || !Number.isFinite(input.before) || !Number.isFinite(input.after) || input.before <= 0) {
    return false;
  }

  if (input.unit === "ms" && input.before < SQLITE_TIMING_FLOOR_MS) {
    return false;
  }

  return input.after * INDEX_IMPROVEMENT_FACTOR <= input.before;
}

/** `posts_author_idx` for posts.author_id, `posts_created_at_idx` for posts.created_at. */
export function indexName(table: string, columns: readonly string[], taken: ReadonlySet<string>): string {
  const stem = `${table}_${columns.map((column) => column.replace(/_id$/i, "")).join("_")}`;
  let name = `${stem}_idx`;

  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `${stem}_${suffix}_idx`;
  }

  return name;
}

/** The Drizzle line for a table's extra config: `index("posts_author_idx").on(t.authorId)`. */
export function drizzleIndexLine(
  name: string,
  columns: readonly string[],
  keys: Readonly<Record<string, string>> | undefined,
): string {
  const references = columns.map((column) => {
    const key = keys?.[column] ?? toCamelCase(column);

    return /^[A-Za-z_$][\w$]*$/.test(key) ? `t.${key}` : `t[${JSON.stringify(key)}]`;
  });

  return `index(${JSON.stringify(name)}).on(${references.join(", ")})`;
}

function toCamelCase(column: string): string {
  return column.replace(/_+([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}
