/** A short set of examples to take in order, curated across sections. */
export interface ExampleCollection {
  id: string;
  /** What the set is for, shown above its title. */
  kind: string;
  title: string;
  /** Family keys, in the order to take them. */
  families: readonly string[];
}

/**
 * The gallery's collections, in the order it shows them
 *
 * A family can sit in several collections, or in none. Each key must name a family that the gallery shows.
 */
export const EXAMPLE_COLLECTIONS: readonly ExampleCollection[] = [
  {
    id: "first-hour",
    kind: "Start here",
    title: "Your first hour",
    families: ["quick-start", "drizzle-in-five-minutes", "joins-explained"],
  },
  {
    id: "relational-queries-v1",
    kind: "Migration",
    title: "Moving to relational queries v1",
    families: ["relational-queries", "select-vs-relational-queries", "helper-apis", "pagination-apis"],
  },
  {
    id: "safe-writes",
    kind: "Production",
    title: "Safe writes",
    families: ["transactions", "check-constraints", "insert-validators"],
  },
];

/** The collection with this id, if there is one. */
export function findExampleCollection(id: string): ExampleCollection | undefined {
  return EXAMPLE_COLLECTIONS.find((collection) => collection.id === id);
}
