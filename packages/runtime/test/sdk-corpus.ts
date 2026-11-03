import { listSupportedTuples, type Dialect, type RuntimeReleaseLine } from "@drizzle-run/core/catalog";
import type { RunResult } from "@drizzle-run/core/contracts";
import { parseRunManifest } from "@drizzle-run/core/manifest";

/** One corpus consumed by installed Node and browser SDK tests. */
export function makeSdkManifest({
  dialect,
  releaseLine = "next",
  query,
}: {
  dialect: Dialect;
  releaseLine?: RuntimeReleaseLine;
  query?: string;
}) {
  const tuple = listSupportedTuples({ dialect }).find((item) => item.releaseLine === releaseLine);
  if (!tuple) {
    throw new Error(`Missing ${releaseLine} ${dialect} tuple`);
  }
  const table = dialect === "postgresql" ? "pgTable" : "sqliteTable";
  const core = dialect === "postgresql" ? "pg-core" : "sqlite-core";
  return parseRunManifest({
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect },
    dependencies: { "drizzle-orm": tuple.ormVersion, "drizzle-kit": tuple.kitVersion },
    randomSeed: 42,
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    files: {
      "schema.ts": `import { ${table}, integer, text } from "drizzle-orm/${core}";
export const users = ${table}("users", { id: integer("id").primaryKey(), name: text("name").notNull() });`,
      "seed.ts":
        'import { db, schema } from "@drizzle-run/runtime/context"; await db.insert(schema.users).values({ id: 1, name: "Ada" });',
      "query.ts":
        query ??
        'import { db, schema } from "@drizzle-run/runtime/context"; export default await db.select().from(schema.users);',
    },
  });
}

/** Exclude host timing and stack locations while retaining observable execution evidence. */
export function toSemanticResult(result: RunResult) {
  return {
    outcome: result.outcome,
    value: result.value,
    sql: result.sql.map(({ sql, parameters, kind, outcome }) => ({ sql, parameters, kind, outcome })),
    phases: result.phases.map(({ phase, status }) => ({ phase, status })),
    database: result.database,
    diagnostics: result.diagnostics.map(({ message, severity, source, line, column }) => ({
      message,
      severity,
      source,
      line,
      column,
    })),
    error: result.error && { message: result.error.message, phase: result.error.phase, code: result.error.code },
  };
}
