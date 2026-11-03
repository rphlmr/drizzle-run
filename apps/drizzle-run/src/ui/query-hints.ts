import type { RunManifest } from "@drizzle-run/core/manifest";

type Dialect = RunManifest["target"]["dialect"];

/**
 * A database error hint with a link to the relevant entry file
 *
 * `file` names the entry file the hint points at, which the card writes in code and opens; the text reads
 * `lead`, the file, then `tail`.
 */
export interface QueryHint {
  lead: string;
  file?: "schema" | "seed";
  tail?: string;
}

const missingTable: QueryHint = {
  lead: "The table wasn't created for this run. Check that",
  file: "schema",
  tail: "exports it.",
};

const missingColumn: QueryHint = {
  lead: "The table this run created has no such column. Check its name in",
  file: "schema",
  tail: ".",
};

const uniqueValue: QueryHint = { lead: "Another row already holds this value, and the column takes each value once." };

const requiredValue: QueryHint = {
  lead: "A required column got no value. Give it one, or a default in",
  file: "schema",
  tail: ".",
};

const missingReference: QueryHint = {
  lead: "The row points at a row that isn't there. Insert the row it references first.",
};

/** What each engine says for the problems a hint knows: PGlite speaks Postgres, libSQL speaks SQLite. */
const hintsByDialect: Record<Dialect, readonly [RegExp, QueryHint][]> = {
  postgresql: [
    [/\brelation "[^"]+" does not exist\b/, missingTable],
    [/\bcolumn "[^"]+"(?: of relation "[^"]+")? does not exist\b/, missingColumn],
    [/\bduplicate key value violates unique constraint\b/, uniqueValue],
    [/\bnull value in column "[^"]+".* violates not-null constraint\b/, requiredValue],
    [/\bviolates foreign key constraint\b/, missingReference],
  ],
  sqlite: [
    [/\bno such table: /, missingTable],
    [/\bno such column: |\bhas no column named /, missingColumn],
    [/\bUNIQUE constraint failed\b/, uniqueValue],
    [/\bNOT NULL constraint failed\b/, requiredValue],
    [/\bFOREIGN KEY constraint failed\b/, missingReference],
  ],
};

/** The hint for a database error, or undefined for one no hint knows, which keeps the plain error card. */
export function getQueryHint(message: string, dialect: Dialect | undefined): QueryHint | undefined {
  return dialect === undefined ? undefined : hintsByDialect[dialect].find(([pattern]) => pattern.test(message))?.[1];
}
