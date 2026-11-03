import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";

// Fails when worker/schema.ts and the SQL the migrations in drizzle/ run disagree.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsFolder = join(appDir, "drizzle");

// drizzle-kit's package exports hide package.json, so the bin link is the stable path.
const kit = join(appDir, "node_modules/.bin/drizzle-kit");

const workDir = mkdtempSync(join(tmpdir(), "drizzle-run-d1-check-"));
const databaseFile = join(workDir, "d1.sqlite");

try {
  const database = new DatabaseSync(databaseFile);

  for (const migration of readMigrationFiles({ migrationsFolder })) {
    for (const statement of migration.sql) {
      database.exec(statement);
    }
  }

  database.close();

  const push = spawnSync(
    kit,
    ["push", "--dialect", "sqlite", "--schema", "./worker/schema.ts", "--url", `file:${databaseFile}`, "--explain"],
    { cwd: appDir, encoding: "utf8" },
  );
  const output = `${push.stdout}${push.stderr}`;

  if (push.status !== 0) {
    throw new Error(`drizzle-kit push --explain exited with ${push.status}:\n${output}`);
  }

  if (!output.includes("No changes detected")) {
    console.error(output);
    console.error(
      "worker/schema.ts and drizzle/ disagree. Run `drizzle-kit generate`, or fix the edited migration.sql.",
    );
    process.exitCode = 1;
  } else {
    console.log("worker/schema.ts matches the migrations in drizzle/.");
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
