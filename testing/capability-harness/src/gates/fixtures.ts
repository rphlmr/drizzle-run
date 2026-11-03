import { parseRunManifest, type RunManifest } from "../../../../packages/core/src/manifest/index.ts";
import { getGuestPackageVersion } from "../../../../packages/core/src/releases/catalog.ts";
import type { Dialect, HarnessPair } from "./contract.ts";

/** The version a guest image pins for a package, from the catalog; throws when the guest does not ship it. */
export function getGuestPin(pair: Pick<HarnessPair, "id">, packageName: string) {
  const version = getGuestPackageVersion({ imageId: pair.id, packageName });

  if (version === null) {
    throw new Error(`Guest ${pair.id} pins no ${packageName}; the acceptance project needs it`);
  }

  return version;
}

const ormApiProjects = {
  v0: {
    relations: (schemaExports: string) => `
import { relations } from "drizzle-orm";
export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
export const postsRelations = relations(posts, ({ one }) => ({ user: one(users, { fields: [posts.userId], references: [users.id] }) }));
export const schema = { users, posts, seedUsers, usersRelations, postsRelations, ${schemaExports} };
`,
    validators: `
import { createInsertSchema as createZodInsertSchema } from "drizzle-zod";
import { createInsertSchema as createValibotInsertSchema } from "drizzle-valibot";
import { createInsertSchema as createTypeboxInsertSchema } from "drizzle-typebox";
import { createInsertSchema as createArktypeInsertSchema } from "drizzle-arktype";
import { Value } from "@sinclair/typebox/value";
import { safeParse } from "valibot";
import { db, schema } from "@drizzle-run/runtime/context";

const sample = { name: "validator check" };
const zodSchema = createZodInsertSchema(schema.seedUsers);
const valibotSchema = createValibotInsertSchema(schema.seedUsers);
const typeboxSchema = createTypeboxInsertSchema(schema.seedUsers);
const arktypeSchema = createArktypeInsertSchema(schema.seedUsers);
const checks = [
  zodSchema.safeParse(sample).success,
  safeParse(valibotSchema, sample).success,
  Value.Check(typeboxSchema, sample),
  arktypeSchema.allows(sample),
];

if (!checks.every(Boolean)) {
  throw new Error("An admitted insert validator rejected a valid row");
}
await db.select().from(schema.seedUsers);
export const validatorChecks = checks.length;
`,
    validatorCount: 4,
    migrationFiles: (dialect: Dialect, migrationSql: string) => ({
      "migrations/0000_acceptance.sql": migrationSql,
      "migrations/meta/_journal.json": JSON.stringify({
        version: "7",
        dialect,
        entries: [{ idx: 0, version: "7", when: 17e11, tag: "0000_acceptance", breakpoints: true }],
      }),
    }),
  },
  v1: {
    relations: (schemaExports: string) => `
import { defineRelations } from "drizzle-orm";
export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { user: r.one.users({ from: r.posts.userId, to: r.users.id }) },
}));
export const schema = { users, posts, seedUsers, relations, ${schemaExports} };
`,
    validators: `
import { createInsertSchema as createZodInsertSchema } from "drizzle-orm/zod";
import { createInsertSchema as createValibotInsertSchema } from "drizzle-orm/valibot";
import { createInsertSchema as createLegacyTypeboxInsertSchema } from "drizzle-orm/typebox-legacy";
import { createInsertSchema as createTypeboxInsertSchema } from "drizzle-orm/typebox";
import { createInsertSchema as createArktypeInsertSchema } from "drizzle-orm/arktype";
import { Value as LegacyTypeboxValue } from "@sinclair/typebox/value";
import { Value as TypeboxValue } from "typebox/value";
import { safeParse } from "valibot";
import { db, schema } from "@drizzle-run/runtime/context";

const sample = { name: "validator check" };
const checks = [
  createZodInsertSchema(schema.seedUsers).safeParse(sample).success,
  safeParse(createValibotInsertSchema(schema.seedUsers), sample).success,
  LegacyTypeboxValue.Check(createLegacyTypeboxInsertSchema(schema.seedUsers), sample),
  TypeboxValue.Check(createTypeboxInsertSchema(schema.seedUsers), sample),
  createArktypeInsertSchema(schema.seedUsers).allows(sample),
];

if (!checks.every(Boolean)) {
  throw new Error("An admitted insert validator rejected a valid row");
}
await db.select().from(schema.seedUsers);
export const validatorChecks = checks.length;
`,
    validatorCount: 5,
    migrationFiles: (_dialect: Dialect, migrationSql: string) => ({
      "migrations/20261011150000_acceptance/migration.sql": migrationSql,
    }),
  },
};

/** The acceptance project sources for a guest's ORM API; throws for an API with none registered. */
function getOrmApiProject(pair: HarnessPair) {
  const project = ormApiProjects[pair.ormApi];

  if (project === undefined) {
    throw new Error(
      `No acceptance project is registered for ORM API ${pair.ormApi} (guest ${pair.id}); expected one of ${Object.keys(ormApiProjects).join(", ")}`,
    );
  }

  return project;
}

function createUserSchema(pair: HarnessPair, dialect: Dialect) {
  const schemaExports = dialect === "postgresql" ? "embeddings, publishedUsers, acceptanceSequence" : "publishedUsers";
  const nextRelations = getOrmApiProject(pair).relations(schemaExports);

  if (dialect === "postgresql") {
    return `
import { count, eq, sql } from "drizzle-orm";
import { bigint, customType, index, integer, jsonb, pgEnum, pgPolicy, pgSequence, pgTable, pgView, serial, text, timestamp, uniqueIndex, vector } from "drizzle-orm/pg-core";
import { acceptanceHelper } from "./schema-helper";

globalThis.__schemaEvaluations = (globalThis.__schemaEvaluations ?? 0) + 1;
await Promise.resolve();
console.log("acceptance schema log", { dialect: ${JSON.stringify(dialect)}, marker: "schema" }, undefined);

export const state = pgEnum("acceptance_state", ["draft", "published"]);
export const acceptanceSequence = pgSequence("acceptance_sequence", { startWith: 101 });
const upperText = customType({ dataType: () => "text", toDriver: (value) => value.toLowerCase(), fromDriver: (value) => value.toUpperCase() });
export const users = pgTable("acceptance_users", {
  id: serial("id").primaryKey(),
  name: upperText("name").notNull(),
  email: text("email").notNull(),
  state: state("state").notNull().default("draft"),
  payload: jsonb("payload"),
  displayName: text().notNull().default("implicit"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  exactInteger: bigint("exact_integer", { mode: "bigint" }),
  binary: customType({ dataType: () => "bytea" })("binary"),
  tags: text("tags").array().notNull().default(sql\`ARRAY[]::text[]\`),
  nameLength: integer("name_length").generatedAlwaysAs(sql\`length(name)\`),
}, (table) => [
  index("acceptance_users_name_idx").on(table.name),
  uniqueIndex("acceptance_users_email_idx").on(table.email),
  pgPolicy("acceptance_users_read", { for: "select", to: "public", using: sql\`true\` }),
]).enableRLS();
export const posts = pgTable("acceptance_posts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});
export const seedUsers = pgTable("acceptance_seed_users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
export const embeddings = pgTable("acceptance_embeddings", {
  id: serial("id").primaryKey(),
  value: vector("value", { dimensions: 3 }).notNull(),
});
export const publishedUsers = pgView("acceptance_published_users").as((query) =>
  query.select({ id: users.id, name: users.name }).from(users).where(eq(users.state, "published"))
);
${nextRelations}
`;
  }
  return `
import { eq, sql } from "drizzle-orm";
import { blob, customType, index, integer, sqliteTable, sqliteView, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { acceptanceHelper } from "./schema-helper";

globalThis.__schemaEvaluations = (globalThis.__schemaEvaluations ?? 0) + 1;
await Promise.resolve();
console.log("acceptance schema log", { dialect: ${JSON.stringify(dialect)}, marker: "schema" }, undefined);

const upperText = customType({ dataType: () => "text", toDriver: (value) => value.toLowerCase(), fromDriver: (value) => value.toUpperCase() });
export const users = sqliteTable("acceptance_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: upperText("name").notNull(),
  email: text("email").notNull(),
  state: text("state").notNull().default("draft"),
  payload: text("payload", { mode: "json" }),
  displayName: text().notNull().default("implicit"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql\`(unixepoch() * 1000)\`),
  exactInteger: blob("exact_integer", { mode: "bigint" }),
  binary: blob("binary", { mode: "buffer" }),
  nameLength: integer("name_length").generatedAlwaysAs(sql\`length(name)\`, { mode: "stored" }),
}, (table) => [
  index("acceptance_users_name_idx").on(table.name),
  uniqueIndex("acceptance_users_email_idx").on(table.email),
]);
export const posts = sqliteTable("acceptance_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
});
export const seedUsers = sqliteTable("acceptance_seed_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
export const publishedUsers = sqliteView("acceptance_published_users").as((query) =>
  query.select({ id: users.id, name: users.name }).from(users).where(eq(users.state, "published"))
);
${nextRelations}
`;
}

function createSeedSource(pair: HarnessPair) {
  const version = getGuestPin(pair, "drizzle-seed");

  return `
import { seed } from "drizzle-seed";
import { db, schema } from "@drizzle-run/runtime/context";

await seed(db, { users: schema.seedUsers }, { seed: 4271, count: 2 });
console.log("seeded acceptance rows", ${JSON.stringify(version)});
`;
}

function createQuerySource(pair: HarnessPair, dialect: Dialect) {
  const core = dialect === "postgresql" ? "pg-core" : "sqlite-core";
  const upsert =
    dialect === "postgresql"
      ? `const upsert = await db.insert(users).values({ name: "Ada", email: "ada@example.test", state: "published", payload: { labels: ["one", "two"] }, createdAt, exactInteger, binary: Uint8Array.from([0, 127, 255]), tags: ["orm", "runtime"] }).onConflictDoUpdate({ target: users.email, set: { name: "Grace" } }).returning({ id: users.id, name: users.name });`
      : `const upsert = await db.insert(users).values({ name: "Ada", email: "ada@example.test", state: "published", payload: { labels: ["one", "two"] }, createdAt, exactInteger, binary: Uint8Array.from([0, 127, 255]) }).onConflictDoUpdate({ target: users.email, set: { name: "Grace" } }).returning({ id: users.id, name: users.name });`;
  const insert =
    dialect === "postgresql"
      ? `await db.insert(users).values({ name: "Ada", email: "ada@example.test", state: "published", payload: { labels: ["one", "two"] }, createdAt, exactInteger, binary: Uint8Array.from([0, 127, 255]), tags: ["orm", "runtime"] });`
      : `await db.insert(users).values({ name: "Ada", email: "ada@example.test", state: "published", payload: { labels: ["one", "two"] }, createdAt, exactInteger, binary: Uint8Array.from([0, 127, 255]) });`;
  const vectorCheck =
    dialect === "postgresql"
      ? `
await db.insert(schema.embeddings).values({ value: [1, 2, 3] });
const vectorCount = Number((await db.select({ count: count() }).from(schema.embeddings))[0].count);
assert("pgvector-insert-query", vectorCount === 1);
`
      : "";
  const arrayCheck =
    dialect === "postgresql"
      ? `assert("postgres-arrays", JSON.stringify(stored.tags) === JSON.stringify(["orm", "runtime"]));`
      : "";
  const readOnlyTransaction =
    dialect === "postgresql"
      ? `
const readOnlyRows = await db.transaction((tx) => tx.select({ id: users.id }).from(users), { accessMode: "read only" });
let readOnlyWriteRejected = false;
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: "Read only", email: "readonly@example.test" });
  }, { accessMode: "read only" });
} catch {
  readOnlyWriteRejected = true;
}
const readOnlyWriteRows = await db.select().from(users).where(eq(users.email, "readonly@example.test"));
assert("read-only-transaction", readOnlyRows.length === 1 && readOnlyWriteRejected && readOnlyWriteRows.length === 0);
`
      : "";
  const migrationQuery =
    dialect === "postgresql"
      ? `const migrationRows = (await db.execute(sql\`SELECT value FROM acceptance_migration\`)).rows;`
      : `const migrationRows = await db.all(sql\`SELECT value FROM acceptance_migration\`);`;
  const rawQuery =
    dialect === "postgresql"
      ? `const rawResult = await db.execute(sql\`SELECT 1 AS raw_value\`);`
      : `const rawResult = await db.all(sql\`SELECT 1 AS raw_value\`);`;
  const sequenceAssertion =
    dialect === "postgresql"
      ? `assert("sequence", Number((await db.execute(sql\`SELECT nextval('acceptance_sequence') AS value\`)).rows[0].value) === 101);`
      : `assert("auto-increment", Number(stored.id) === 1);`;
  const rollbackBatch =
    dialect === "sqlite"
      ? `
let batchRejected = false;
try {
  await db.batch([
    db.insert(schema.seedUsers).values({ name: "atomic transient" }),
    db.run(sql.raw("INSERT INTO missing_acceptance_table (value) VALUES ('fail')")),
  ]);
} catch {
  batchRejected = true;
}
const transientRows = await db.select().from(schema.seedUsers).where(eq(schema.seedUsers.name, "atomic transient"));
assert("sqlite-batch-is-atomic", batchRejected && transientRows.length === 0);

const clientBatch = await db.$client.batch([
  ["SELECT ? AS tuple_value", [41]],
  ["SELECT 42 AS tuple_without_args"],
  "SELECT 43 AS string_value",
  { sql: "SELECT :value AS named_value", args: { value: 44 } },
  { sql: "SELECT 45 AS object_value" },
]);
assert("sqlite-client-batch-forms", clientBatch.map((result) => Number(result.rows[0][0])).join(",") === "41,42,43,44,45");

let tupleBatchRejected = false;
try {
  await db.$client.batch([
    ["INSERT INTO acceptance_seed_users (name) VALUES (?)", ["tuple transient"]],
    ["INSERT INTO missing_acceptance_table (value) VALUES (?)", ["tuple failure"]],
  ]);
} catch {
  tupleBatchRejected = true;
}
const tupleTransientRows = await db.select().from(schema.seedUsers).where(eq(schema.seedUsers.name, "tuple transient"));
assert("sqlite-client-batch-rejection", tupleBatchRejected && tupleTransientRows.length === 0);

const transactionClosedStates = [];
for (const ending of ["COMMIT", "ROLLBACK"]) {
  const transaction = await db.$client.transaction("deferred");
  transactionClosedStates.push(transaction.closed);
  await transaction.execute("SELECT 1");
  transactionClosedStates.push(transaction.closed);
  await transaction.execute("SELECT 2");
  transactionClosedStates.push(transaction.closed);
  await transaction.execute(ending);
  transactionClosedStates.push(transaction.closed);
  await transaction.close();
}
assert("sqlite-transaction-closed-state", JSON.stringify(transactionClosedStates) === "[false,false,false,true,false,false,false,true]");
`
      : "";
  const migrations =
    dialect === "postgresql"
      ? `import { migrate } from "drizzle-orm/node-postgres/migrator";`
      : `import { migrate } from "drizzle-orm/libsql/migrator";`;
  return `
import { alias } from "drizzle-orm/${core}";
import { asc, count, eq, inArray, placeholder, sql } from "drizzle-orm";
import { db, env, schema } from "@drizzle-run/runtime/context";
import { cycleA } from "./cycle-a";
import { cycleCheck } from "./cycle-b";
import { acceptanceHelper } from "./schema-helper";
${migrations}
import { validatorChecks } from "./validators";

globalThis.__runEvaluations = (globalThis.__runEvaluations ?? 0) + 1;
await Promise.resolve();
const { users, posts } = schema;
const features = [];
const assert = (name, condition) => {
  if (!condition) {
    throw new Error("acceptance failure: " + name);
  }

  features.push(name);
};
assert("top-level-await", env.ACCEPTANCE === "runtime-gate");
assert("multi-file-import-cycle", acceptanceHelper === "ready" && cycleA === "a" && cycleCheck() === "a");
assert("module-evaluates-once", globalThis.__schemaEvaluations === 1 && globalThis.__helperEvaluations === 1 && globalThis.__runEvaluations === 1);
const seededRows = await db.select().from(schema.seedUsers);
assert("seed-integration", seededRows.length === 2);

const createdAt = new Date("2024-01-02T03:04:05.000Z");
const exactInteger = 9007199254740993n;
${insert}
${upsert}
assert("upsert-and-returning", upsert.length === 1 && upsert[0].name === "GRACE");

const userAlias = alias(users, "user_alias");
const aliasRows = await db.select({ name: userAlias.name }).from(userAlias);
assert("aliases", aliasRows.length === 1);
const aggregates = await db.select({ state: users.state, total: count() }).from(users).groupBy(users.state);
assert("aggregation-and-grouping", aggregates.length === 1 && Number(aggregates[0].total) === 1);
const withRows = await db.$with("selected_users").as(db.select({ id: users.id, name: users.name }).from(users));
const cteRows = await db.with(withRows).select().from(withRows);
assert("cte", cteRows.length === 1);
const subquery = db.select({ id: users.id }).from(users).as("selected_subquery");
const subqueryRows = await db.select().from(users).where(inArray(users.id, db.select({ id: subquery.id }).from(subquery)));
assert("subquery", subqueryRows.length === 1);
const setRows = await db.select({ name: users.name }).from(users).unionAll(db.select({ name: users.name }).from(users));
assert("set-operations", setRows.length === 2);
const dynamicRows = await db.select().from(users).$dynamic().where(eq(users.state, "published"));
assert("dynamic-query", dynamicRows.length === 1);
const prepared = db.select({ name: users.name }).from(users).where(eq(users.id, placeholder("id"))).prepare();
const preparedRows = await prepared.execute({ id: upsert[0].id });
assert("prepared-query", preparedRows.length === 1 && preparedRows[0].name === "GRACE");
const relational = await db.query.users.findMany({ with: { posts: true } });
assert("relational-query-api", relational.every((user) => Array.isArray(user.posts)));

await db.insert(posts).values({ userId: upsert[0].id, title: "relations" });
const related = await db.query.users.findMany({ with: { posts: true } });
assert("relational-results", related[0].posts.length === 1);
const viewRows = await db.select().from(schema.publishedUsers);
assert("views", viewRows.length === 1);
const stored = (await db.select().from(users))[0];
const implicitColumnRows = await db.select({ displayName: users.displayName }).from(users);
assert(
  "implicit-column-name",
  implicitColumnRows.length === 1 && implicitColumnRows[0].displayName === "implicit",
);
assert("defaults-and-generated-columns", stored.nameLength === 5 && stored.createdAt instanceof Date);
assert("custom-type-and-json", stored.name === "GRACE" && stored.payload.labels.join(",") === "one,two");
assert("bigint-and-binary", stored.exactInteger === exactInteger && Array.from(new Uint8Array(stored.binary)).join(",") === "0,127,255");
${arrayCheck}
${vectorCheck}
${readOnlyTransaction}

let committedId;
await db.transaction(async (tx) => {
  const [committed] = await tx.insert(users).values({ name: "Committed", email: "commit@example.test" }).returning({ id: users.id });
  committedId = committed.id;
  try {
    await tx.transaction(async (nested) => {
      await nested.insert(users).values({ name: "Nested", email: "nested@example.test" });
      throw new Error("savepoint rollback");
    });
  } catch (error) {
    if (error.message !== "savepoint rollback") {
      throw error;
    }
  }
});
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: "Rolled back", email: "rollback@example.test" });
    throw new Error("transaction rollback");
  });
} catch (error) {
  if (error.message !== "transaction rollback") {
    throw error;
  }
}
const afterTransactions = await db.select({ name: users.name }).from(users).orderBy(asc(users.id));
assert("commit-explicit-rollback-nested-savepoint", afterTransactions.length === 2 && afterTransactions.some((row) => row.name === "COMMITTED") && !afterTransactions.some((row) => row.name === "NESTED" || row.name === "ROLLED BACK"));

await migrate(db, { migrationsFolder: "migrations" });
${migrationQuery}
assert("project-owned-migrations", migrationRows.length === 1);
${rollbackBatch}
${rawQuery}
assert("raw-sql", rawResult !== undefined);
${sequenceAssertion}
assert("validators", validatorChecks === ${getOrmApiProject(pair).validatorCount});
assert("deterministic-tools", $.random.sequence(3).join(",") === "1,2,3");
console.log("runtime acceptance", { dialect: ${JSON.stringify(dialect)}, features: features.length, marker: "run" }, undefined);
export default { features, validatorChecks, seeded: seededRows.length, migrated: migrationRows.length, committedId };
`;
}

type AcceptanceKind =
  | "full"
  | "failure"
  | "failed_query"
  | "package_outside_schema"
  | "query_plans"
  | "effect"
  | "recovery";

interface AcceptanceOptions {
  pair: HarnessPair;
  dialect: Dialect;
  kind: AcceptanceKind;
}

function createAcceptanceProject({ pair, dialect, kind }: AcceptanceOptions) {
  const ormApiProject = getOrmApiProject(pair);
  const baseDependencies = {
    "drizzle-orm": pair.ormVersion,
    "drizzle-kit": pair.kitVersion,
  };
  const commonFiles = {
    "schema.ts": createUserSchema(pair, dialect),
    "schema-helper.ts": `import { cycleCheck } from "./cycle-b";
globalThis.__helperEvaluations = (globalThis.__helperEvaluations ?? 0) + 1;
export const acceptanceHelper = cycleCheck() === "a" ? "ready" : "invalid";
`,
    "cycle-a.ts": `import { cycleB } from "./cycle-b";
export const cycleA = "a";
export const cycleValue = () => cycleA + cycleB;
`,
    "cycle-b.ts": `import { cycleA } from "./cycle-a";
export const cycleB = "b";
export const cycleCheck = () => cycleA;
`,
    "validators.ts": ormApiProject.validators,
    ...ormApiProject.migrationFiles(
      dialect,
      dialect === "postgresql"
        ? "CREATE TABLE acceptance_migration (value text NOT NULL);\n--> statement-breakpoint\nINSERT INTO acceptance_migration (value) VALUES ('migration applied');\n"
        : "CREATE TABLE acceptance_migration (value TEXT NOT NULL);\n--> statement-breakpoint\nINSERT INTO acceptance_migration (value) VALUES ('migration applied');\n",
    ),
  };

  if (kind === "failure" || kind === "failed_query") {
    return {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: baseDependencies,
      files: {
        "schema.ts":
          dialect === "postgresql"
            ? `import { pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("failure_users", { id: serial().primaryKey(), name: text().notNull() });
`
            : `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const users = sqliteTable("failure_users", { id: integer().primaryKey(), name: text().notNull() });
`,
        "run.ts":
          kind === "failure"
            ? `throw new Error("intentional acceptance failure");
`
            : `import { db, schema } from "@drizzle-run/runtime/context";
await db.insert(schema.users).values({ id: 1, name: "Ada" });
await db.insert(schema.users).values({ id: 1, name: "Grace" });
`,
      },
      entrypoints: { schema: "schema.ts", run: "run.ts" },
    };
  }

  if (kind === "package_outside_schema") {
    return {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: baseDependencies,
      files: {
        "schema.ts": `export const marker = { packageFree: true };
`,
        "run.ts": `import { sql } from "drizzle-orm";
export default typeof sql === "function" ? "loaded outside schema" : "missing";
`,
      },
      entrypoints: { schema: "schema.ts", run: "run.ts" },
    };
  }

  if (kind === "query_plans") {
    return {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: baseDependencies,
      files: {
        "schema.ts":
          dialect === "postgresql"
            ? `import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", { id: serial().primaryKey(), name: text().notNull(), email: text().notNull().unique() });
export const posts = pgTable("posts", { id: serial().primaryKey(), authorId: integer("author_id").notNull().references(() => users.id), title: text().notNull() });
`
            : `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const users = sqliteTable("users", { id: integer().primaryKey(), name: text().notNull(), email: text().notNull().unique() });
export const posts = sqliteTable("posts", { id: integer().primaryKey(), authorId: integer("author_id").notNull().references(() => users.id), title: text().notNull() });
`,
        "seed.ts": `import { db, schema } from "@drizzle-run/runtime/context";
await db.insert(schema.users).values([{ name: "Ada", email: "ada@example.com" }, { name: "Grace", email: "grace@example.com" }]);
await db.insert(schema.posts).values([{ authorId: 1, title: "Hello" }, { authorId: 2, title: "Plans" }]);
`,
        "run.ts": `import { eq } from "drizzle-orm";
import { db, schema } from "@drizzle-run/runtime/context";
const byAuthor = await db.select().from(schema.posts).where(eq(schema.posts.authorId, 1));
const byEmail = await db.select().from(schema.users).where(eq(schema.users.email, "ada@example.com"));
export default { byAuthor, byEmail };
`,
      },
      entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "run.ts" },
    };
  }

  if (kind === "effect") {
    return {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: baseDependencies,
      guestFlavor: "effect",
      files: {
        "schema.ts":
          dialect === "postgresql"
            ? `import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("effect_users", { id: serial().primaryKey(), name: text().notNull(), age: integer() });
`
            : `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const users = sqliteTable("effect_users", { id: integer().primaryKey(), name: text().notNull(), age: integer() });
`,
        "run.ts":
          dialect === "postgresql"
            ? `import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { eq } from "drizzle-orm";
import { postgresConnection } from "@drizzle-run/runtime/context";
import { users } from "./schema";

const UserInsert = createInsertSchema(users);
const UserSelect = createSelectSchema(users);
const ada = Schema.decodeUnknownSync(UserInsert)({ name: "Ada", age: 36 });
const rejected = Schema.decodeUnknownExit(UserInsert)({ age: "old" });
const program = Effect.gen(function* () {
  const effectDb = yield* PgDrizzle.makeWithDefaults();
  yield* effectDb.insert(users).values([ada, { name: "Linus", age: 54 }]);
  const rows = yield* effectDb.select().from(users).where(eq(users.name, "Ada"));
  return rows.map((row) => Schema.decodeUnknownSync(UserSelect)(row));
});
const rows = await Effect.runPromise(program.pipe(Effect.provide(PgClient.layerFrom(PgClient.makeClient(postgresConnection)))));
export default { names: rows.map((row) => row.name), rejected: rejected._tag };
`
            : `import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as LibsqlDrizzle from "drizzle-orm/effect-libsql";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/effect-schema";
import { eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { users } from "./schema";

const UserInsert = createInsertSchema(users);
const UserSelect = createSelectSchema(users);
const ada = Schema.decodeUnknownSync(UserInsert)({ name: "Ada", age: 36 });
const rejected = Schema.decodeUnknownExit(UserInsert)({ age: "old" });
const program = Effect.gen(function* () {
  const effectDb = yield* LibsqlDrizzle.makeWithDefaults();
  yield* effectDb.insert(users).values([ada, { name: "Linus", age: 54 }]);
  const rows = yield* effectDb.select().from(users).where(eq(users.name, "Ada"));
  return rows.map((row) => Schema.decodeUnknownSync(UserSelect)(row));
});
const rows = await Effect.runPromise(program.pipe(Effect.provide(LibsqlClient.layer({ liveClient: db.$client }))));
export default { names: rows.map((row) => row.name), rejected: rejected._tag };
`,
      },
      entrypoints: { schema: "schema.ts", run: "run.ts" },
    };
  }

  if (kind === "recovery") {
    return {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: baseDependencies,
      files: {
        "schema.ts":
          dialect === "postgresql"
            ? `import { pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("recovery_users", { id: serial().primaryKey(), name: text().notNull() });
`
            : `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const users = sqliteTable("recovery_users", { id: integer().primaryKey(), name: text().notNull() });
`,
        "run.ts": `export default "recovered";
`,
      },
      entrypoints: { schema: "schema.ts", run: "run.ts" },
    };
  }

  return {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect },
    dependencies: baseDependencies,
    files: {
      ...commonFiles,
      "seed.ts": createSeedSource(pair),
      "run.ts": createQuerySource(pair, dialect),
    },
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "run.ts" },
    env: { ACCEPTANCE: "runtime-gate" },
    randomSeed: 42,
  };
}

/** Build and validate the fixture submitted through the public SDK. */
export function createAcceptanceManifest({ pair, dialect, kind }: AcceptanceOptions): RunManifest {
  return parseRunManifest({
    ...createAcceptanceProject({ pair, dialect, kind }),
    guestFlavor: kind === "effect" ? "effect" : pair.guestFlavor,
  });
}
