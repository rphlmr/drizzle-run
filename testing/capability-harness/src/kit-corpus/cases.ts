import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import * as sqlite from "drizzle-orm/sqlite-core";

import { timestampColumns } from "./helpers.ts";
import type { PgReleaseApi, SchemaCase } from "./types.ts";

/**
 * Create the PostgreSQL scenarios, with the same ids in every release corpus
 *
 * `pgRelease` supplies the few PostgreSQL APIs whose spelling differs between ORM releases.
 */
export function createPostgresCases(pgRelease: PgReleaseApi) {
  return [
    {
      id: "one-to-one-and-one-to-many",
      docs: ["relations.mdx#one-to-one", "relations.mdx#one-to-many"],
      schema: () => {
        const users = pg.pgTable("users", { id: pg.integer().primaryKey() });
        const profiles = pg.pgTable("profiles", {
          id: pg.integer().primaryKey(),
          userId: pg
            .integer()
            .notNull()
            .unique()
            .references(() => users.id, { onDelete: "cascade" }),
        });
        const posts = pg.pgTable("posts", {
          id: pg.integer().primaryKey(),
          authorId: pg.integer().references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
        });
        return { users, profiles, posts };
      },
    },
    {
      id: "public-enum-and-serial-key",
      docs: ["column-types/pg.mdx#enum", "column-types/pg.mdx#serial"],
      schema: () => {
        const state = pg.pgEnum("state", ["draft", "published"]);
        const articles = pg.pgTable("articles", {
          id: pg.serial().primaryKey(),
          state: state().notNull().default("draft"),
        });
        return { state, articles };
      },
    },
    {
      id: "cross-schema-references",
      docs: ["schemas.mdx", "indexes-constraints.mdx#foreign-key"],
      schema: () => {
        const accounts = pg.pgSchema("accounts");
        const audit = pg.pgSchema("audit");
        const users = accounts.table("users", { id: pg.integer().primaryKey() });
        const events = audit.table("events", {
          id: pg.integer().primaryKey(),
          userId: pg.integer().references(() => users.id),
        });
        return { accounts, audit, users, events };
      },
    },
    {
      id: "view-options",
      docs: ["views.mdx#extended-example", "rls.mdx#rls-on-views"],
      schema: () => {
        const items = pg.pgTable("items", { id: pg.integer().primaryKey() });
        const view = pg
          .pgView("secure_items")
          .with({ securityBarrier: true, securityInvoker: true, checkOption: "local" })
          .as((qb) => qb.select().from(items));
        return { items, view };
      },
    },
    {
      id: "empty",
      docs: ["sql-schema-declaration.mdx"],
      empty: true,
      schema: () => ({}),
    },
    {
      id: "integer-and-serial-types",
      docs: ["column-types/pg.mdx#integer"],
      schema: () => ({
        numbers: pg.pgTable("numbers", {
          small: pg.smallint(),
          integer: pg.integer(),
          bigintNumber: pg.bigint({ mode: "number" }),
          bigintNative: pg.bigint({ mode: "bigint" }),
          serial: pg.serial(),
          smallSerial: pg.smallserial(),
          bigSerialNumber: pg.bigserial({ mode: "number" }),
          bigSerialNative: pg.bigserial({ mode: "bigint" }),
        }),
      }),
    },
    {
      id: "text-numeric-and-boolean-types",
      docs: ["column-types/pg.mdx#text", "column-types/pg.mdx#numeric"],
      schema: () => ({
        scalars: pg.pgTable("scalars", {
          text: pg.text(),
          limited: pg.varchar({ length: 80 }),
          fixed: pg.char({ length: 4 }),
          money: pg.numeric({ precision: 12, scale: 2 }),
          decimal: pg.decimal(),
          real: pg.real(),
          double: pg.doublePrecision(),
          active: pg.boolean(),
        }),
      }),
    },
    {
      id: "temporal-types",
      docs: ["column-types/pg.mdx#time"],
      schema: () => ({
        moments: pg.pgTable("moments", {
          timestampDate: pg.timestamp({ mode: "date", precision: 3 }),
          timestampString: pg.timestamp({ mode: "string", withTimezone: true, precision: 6 }),
          dateObject: pg.date({ mode: "date" }),
          dateString: pg.date({ mode: "string" }),
          time: pg.time({ withTimezone: true, precision: 3 }),
          duration: pg.interval({ fields: "day", precision: 3 }),
        }),
      }),
    },
    {
      id: "json-uuid-and-arrays",
      docs: ["column-types/pg.mdx#json", "column-types/pg.mdx#uuid"],
      schema: () => ({
        documents: pg.pgTable("documents", {
          id: pg.uuid().defaultRandom().primaryKey(),
          json: pg.json().$type<{ tag: string }>().default({ tag: "a  b" }),
          jsonb: pg.jsonb().$type<string[]>().default(["one", "two"]),
          tags: pg.text().array(),
          matrix: pg.integer().array().array(),
        }),
      }),
    },
    {
      id: "geometric-and-binary-types",
      docs: ["column-types/pg.mdx#point", "column-types/pg.mdx#bytea"],
      schema: () => {
        return {
          shapes: pg.pgTable("shapes", {
            point: pg.point(),
            pointObject: pg.point({ mode: "xy" }),
            line: pg.line(),
            lineObject: pg.line({ mode: "abc" }),
            bytes: pgRelease.bytea(),
          }),
        };
      },
    },
    {
      id: "literal-defaults-and-quoted-names",
      docs: ["column-types/pg.mdx#default-value", "sql-schema-declaration.mdx"],
      schema: () => ({
        records: pg.pgTable("odd table", {
          id: pg.integer().primaryKey(),
          inferredName: pg.text().notNull(),
          renamed: pg.text("select").default("first  second\nO'Reilly --> statement-breakpoint"),
          active: pg.boolean().default(true),
          amount: pg.integer().default(-7),
          created: pg.timestamp().defaultNow(),
          expression: pg.integer().default(sql`(abs(-3))`),
        }),
      }),
    },
    {
      id: "runtime-hooks-do-not-affect-ddl",
      docs: ["column-types/pg.mdx#default-value"],
      schema: () => ({
        hooks: pg.pgTable("hooks", {
          id: pg.text().$defaultFn(() => {
            throw new Error("Kit must not execute runtime defaults");
          }),
          updated: pg.text().$onUpdateFn(() => {
            throw new Error("Kit must not execute runtime update hooks");
          }),
        }),
      }),
    },
    {
      id: "identity-options",
      docs: ["column-types/pg.mdx#identity-columns"],
      schema: () => ({
        identities: pg.pgTable("identities", {
          id: pg
            .integer()
            .primaryKey()
            .generatedAlwaysAsIdentity({ name: "identity_seq", startWith: 100, increment: 2 }),
          external: pg.integer().generatedByDefaultAsIdentity(),
        }),
      }),
    },
    {
      id: "composite-keys-and-checks",
      docs: ["indexes-constraints.mdx#composite-primary-key", "indexes-constraints.mdx#check"],
      schema: () => ({
        memberships: pg.pgTable(
          "memberships",
          {
            tenantId: pg.integer().notNull(),
            memberId: pg.integer().notNull(),
            email: pg.text().unique("email_unique"),
            score: pg.integer(),
          },
          (t) => [
            pg.primaryKey({ name: "membership_pk", columns: [t.tenantId, t.memberId] }),
            pg.unique("tenant_email_unique").on(t.tenantId, t.email).nullsNotDistinct(),
            pg.check("nonnegative_score", sql`${t.score} >= 0`),
          ],
        ),
      }),
    },
    {
      id: "foreign-keys-and-actions",
      docs: ["indexes-constraints.mdx#foreign-key", "relations.mdx#foreign-key-actions"],
      schema: () => {
        const parents = pg.pgTable("parents", { tenantId: pg.integer(), id: pg.integer() }, (t) => [
          pg.primaryKey({ columns: [t.tenantId, t.id] }),
        ]);
        const children = pg.pgTable(
          "children",
          {
            id: pg.integer().primaryKey(),
            tenantId: pg.integer(),
            parentId: pg.integer(),
          },
          (t) => [
            pg
              .foreignKey({
                name: "child_parent_fk",
                columns: [t.tenantId, t.parentId],
                foreignColumns: [parents.tenantId, parents.id],
              })
              .onDelete("cascade")
              .onUpdate("restrict"),
          ],
        );
        return { parents, children };
      },
    },
    {
      id: "self-reference",
      docs: ["indexes-constraints.mdx#foreign-key"],
      schema: () => {
        const nodes = pg.pgTable("nodes", {
          id: pg.integer().primaryKey(),
          parentId: pg.integer().references((): pg.AnyPgColumn => nodes.id, { onDelete: "set null" }),
        });
        return { nodes };
      },
    },
    {
      id: "indexes-and-expressions",
      docs: ["indexes-constraints.mdx#indexes"],
      schema: () => ({
        contacts: pg.pgTable(
          "contacts",
          {
            id: pg.integer().primaryKey(),
            email: pg.text(),
            rank: pg.integer(),
            active: pg.boolean(),
          },
          (t) => [
            pg.uniqueIndex("email_idx").on(t.email),
            pg.index("rank_email_idx").on(t.rank.desc().nullsLast(), t.email.asc()),
            pg
              .index("lower_email_idx")
              .using("btree", sql`lower(${t.email})`)
              .where(sql`${t.active} = true`)
              .with({ fillfactor: "70" }),
          ],
        ),
      }),
    },
    {
      id: "generated-column",
      docs: ["generated-columns.mdx"],
      schema: () => ({
        generated: pg.pgTable("generated", {
          id: pg.integer().primaryKey(),
          source: pg.integer(),
          doubled: pg.integer().generatedAlwaysAs(sql`"source" * 2`),
        }),
      }),
    },
    {
      id: "schemas-and-enums",
      docs: ["schemas.mdx", "column-types/pg.mdx#enum"],
      schema: () => {
        const audit = pg.pgSchema("audit");
        const mood = audit.enum("mood", ["calm", "busy", "two  words"]);
        const events = audit.table("events", { id: pg.integer().primaryKey(), mood: mood().default("calm") });
        return { audit, mood, events };
      },
    },
    {
      id: "sequences",
      docs: ["sequences.mdx"],
      schema: () => {
        const audit = pg.pgSchema("audit");
        return {
          audit,
          plain: pg.pgSequence("plain_sequence"),
          numbered: audit.sequence("numbered_sequence", {
            startWith: 10,
            minValue: 10,
            maxValue: 1000,
            increment: 2,
            cache: 5,
            cycle: true,
          }),
        };
      },
    },
    {
      id: "views-query-builder-and-sql",
      docs: ["views.mdx#declaring-views", "views.mdx#declaring-views-with-raw-sql"],
      schema: () => {
        const items = pg.pgTable("items", { id: pg.integer().primaryKey(), label: pg.text() });
        const selected = pg.pgView("selected_items").as((qb) => qb.select().from(items));
        const raw = pg.pgView("raw_items", { id: pg.integer() }).as(sql`select id from ${items}`);
        return { items, selected, raw };
      },
    },
    {
      id: "existing-view-is-ignored",
      docs: ["views.mdx#declaring-existing-views"],
      empty: true,
      schema: () => ({ external: pg.pgView("external_view", { id: pg.integer() }).existing() }),
    },
    {
      id: "materialized-view",
      docs: ["views.mdx#materialized-views"],
      schema: () => {
        const items = pg.pgTable("items", { id: pg.integer().primaryKey() });
        const cached = pg
          .pgMaterializedView("cached_items")
          .with({ fillfactor: 90 })
          .withNoData()
          .as((qb) => qb.select().from(items));
        return { items, cached };
      },
    },
    {
      id: "rls-without-policies",
      docs: ["rls.mdx#enable-rls"],
      schema: () => ({ restricted: pgRelease.rlsTable("restricted", { id: pg.integer().primaryKey() }) }),
    },
    {
      id: "roles-and-policies",
      docs: ["rls.mdx#roles", "rls.mdx#policies"],
      schema: () => {
        const editor = pg.pgRole("editor", { inherit: true, createDb: false, createRole: false });
        const reader = pg.pgRole("reader").existing();
        const records = pg.pgTable("private_records", { id: pg.integer().primaryKey() }, (t) => [
          pg.pgPolicy("read_records", { for: "select", to: reader, using: sql`${t.id} > 0` }),
          pg.pgPolicy("write_records", { as: "restrictive", for: "insert", to: editor, withCheck: sql`${t.id} > 0` }),
        ]);
        return { editor, reader, records };
      },
    },
    {
      id: "vector-index",
      docs: ["extensions/pg.mdx"],
      schema: () => ({
        embeddings: pg.pgTable(
          "embeddings",
          {
            id: pg.integer().primaryKey(),
            vector: pg.vector({ dimensions: 3 }),
            half: pg.halfvec({ dimensions: 3 }),
          },
          (t) => [pg.index("vector_idx").using("hnsw", t.vector.op("vector_l2_ops"))],
        ),
      }),
    },
    {
      id: "custom-type",
      docs: ["custom-types.mdx"],
      schema: () => {
        const tsvector = pg.customType<{ data: string }>({ dataType: () => "tsvector" });
        return { search: pg.pgTable("search", { id: pg.integer().primaryKey(), document: tsvector() }) };
      },
    },
    {
      id: "composed-project",
      docs: ["sql-schema-declaration.mdx#schema-in-multiple-files", "relations.mdx#many-to-many"],
      schema: () => {
        const table = pg.pgTableCreator((name) => `app_${name}`);
        const users = table("users", {
          id: pg.integer().primaryKey(),
          email: pg.text().notNull().unique(),
          ...timestampColumns(),
        });
        const teams = table("teams", {
          id: pg.integer().primaryKey(),
          name: pg.text().notNull(),
          ...timestampColumns(),
        });
        const members = table(
          "members",
          {
            userId: pg
              .integer()
              .notNull()
              .references(() => users.id, { onDelete: "cascade" }),
            teamId: pg
              .integer()
              .notNull()
              .references(() => teams.id, { onDelete: "cascade" }),
          },
          (t) => [pg.primaryKey({ columns: [t.userId, t.teamId] })],
        );
        return { users, teams, members };
      },
    },
  ] satisfies readonly SchemaCase[];
}

/** The SQLite scenarios, with the same ids in every release corpus. */
export const sqliteCases = [
  {
    id: "one-to-one-and-one-to-many",
    docs: ["relations.mdx#one-to-one", "relations.mdx#one-to-many"],
    schema: () => {
      const users = sqlite.sqliteTable("users", { id: sqlite.integer().primaryKey() });
      const profiles = sqlite.sqliteTable("profiles", {
        id: sqlite.integer().primaryKey(),
        userId: sqlite
          .integer()
          .notNull()
          .unique()
          .references(() => users.id, { onDelete: "cascade" }),
      });
      const posts = sqlite.sqliteTable("posts", {
        id: sqlite.integer().primaryKey(),
        authorId: sqlite.integer().references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
      });
      return { users, profiles, posts };
    },
  },
  { id: "empty", docs: ["sql-schema-declaration.mdx"], empty: true, schema: () => ({}) },
  {
    id: "storage-types-and-modes",
    docs: ["column-types/sqlite.mdx"],
    schema: () => ({
      storage: sqlite.sqliteTable("storage", {
        integer: sqlite.integer(),
        boolean: sqlite.integer({ mode: "boolean" }),
        timestamp: sqlite.integer({ mode: "timestamp" }),
        millis: sqlite.integer({ mode: "timestamp_ms" }),
        real: sqlite.real(),
        text: sqlite.text(),
        enum: sqlite.text({ enum: ["draft", "published"] }),
        jsonText: sqlite.text({ mode: "json" }),
        buffer: sqlite.blob({ mode: "buffer" }),
        bigint: sqlite.blob({ mode: "bigint" }),
        jsonBlob: sqlite.blob({ mode: "json" }),
        numeric: sqlite.numeric(),
        numericNumber: sqlite.numeric({ mode: "number" }),
        numericBigint: sqlite.numeric({ mode: "bigint" }),
      }),
    }),
  },
  {
    id: "literal-defaults-and-quoted-names",
    docs: ["column-types/sqlite.mdx#default-value", "sql-schema-declaration.mdx"],
    schema: () => ({
      records: sqlite.sqliteTable("odd table", {
        id: sqlite.integer().primaryKey({ autoIncrement: true }),
        inferredName: sqlite.text().notNull(),
        renamed: sqlite.text("select").default("first  second\nO'Reilly --> statement-breakpoint"),
        active: sqlite.integer({ mode: "boolean" }).default(true),
        score: sqlite.integer().default(-7),
        moment: sqlite.text().default(sql`CURRENT_TIMESTAMP`),
        expression: sqlite.integer().default(sql`(abs(-3))`),
      }),
    }),
  },
  {
    id: "runtime-hooks-do-not-affect-ddl",
    docs: ["column-types/sqlite.mdx#default-value"],
    schema: () => ({
      hooks: sqlite.sqliteTable("hooks", {
        id: sqlite.text().$defaultFn(() => {
          throw new Error("Kit must not execute runtime defaults");
        }),
        updated: sqlite.text().$onUpdateFn(() => {
          throw new Error("Kit must not execute runtime update hooks");
        }),
      }),
    }),
  },
  {
    id: "composite-keys-and-checks",
    docs: ["indexes-constraints.mdx"],
    schema: () => ({
      memberships: sqlite.sqliteTable(
        "memberships",
        {
          tenantId: sqlite.integer().notNull(),
          memberId: sqlite.integer().notNull(),
          email: sqlite.text().unique("email_unique"),
          score: sqlite.integer(),
        },
        (t) => [
          sqlite.primaryKey({ name: "membership_pk", columns: [t.tenantId, t.memberId] }),
          sqlite.unique("tenant_email_unique").on(t.tenantId, t.email),
          sqlite.check("nonnegative_score", sql`${t.score} >= 0`),
        ],
      ),
    }),
  },
  {
    id: "foreign-keys-and-actions",
    docs: ["indexes-constraints.mdx#foreign-key", "relations.mdx#foreign-key-actions"],
    schema: () => {
      const parents = sqlite.sqliteTable("parents", { tenantId: sqlite.integer(), id: sqlite.integer() }, (t) => [
        sqlite.primaryKey({ columns: [t.tenantId, t.id] }),
      ]);
      const children = sqlite.sqliteTable(
        "children",
        {
          id: sqlite.integer().primaryKey(),
          tenantId: sqlite.integer(),
          parentId: sqlite.integer(),
        },
        (t) => [
          sqlite
            .foreignKey({
              name: "child_parent_fk",
              columns: [t.tenantId, t.parentId],
              foreignColumns: [parents.tenantId, parents.id],
            })
            .onDelete("cascade")
            .onUpdate("restrict"),
        ],
      );
      return { parents, children };
    },
  },
  {
    id: "self-reference",
    docs: ["indexes-constraints.mdx#foreign-key"],
    schema: () => {
      const nodes = sqlite.sqliteTable("nodes", {
        id: sqlite.integer().primaryKey(),
        parentId: sqlite.integer().references((): sqlite.AnySQLiteColumn => nodes.id, { onDelete: "set null" }),
      });
      return { nodes };
    },
  },
  {
    id: "indexes-and-expressions",
    docs: ["indexes-constraints.mdx#indexes"],
    schema: () => ({
      contacts: sqlite.sqliteTable(
        "contacts",
        {
          id: sqlite.integer().primaryKey(),
          email: sqlite.text(),
          rank: sqlite.integer(),
          active: sqlite.integer(),
        },
        (t) => [
          sqlite.uniqueIndex("email_idx").on(t.email),
          sqlite.index("rank_email_idx").on(t.rank, t.email),
          sqlite
            .index("lower_email_idx")
            .on(sql`lower(${t.email})`)
            .where(sql`${t.active} = 1`),
        ],
      ),
    }),
  },
  {
    id: "generated-columns",
    docs: ["generated-columns.mdx"],
    schema: () => ({
      generated: sqlite.sqliteTable("generated", {
        id: sqlite.integer().primaryKey(),
        source: sqlite.integer(),
        stored: sqlite.integer().generatedAlwaysAs(sql`"source" * 2`, { mode: "stored" }),
        virtual: sqlite.integer().generatedAlwaysAs(sql`"source" * 3`, { mode: "virtual" }),
      }),
    }),
  },
  {
    id: "views-query-builder-and-sql",
    docs: ["views.mdx"],
    schema: () => {
      const items = sqlite.sqliteTable("items", { id: sqlite.integer().primaryKey(), label: sqlite.text() });
      const selected = sqlite.sqliteView("selected_items").as((qb) => qb.select().from(items));
      const raw = sqlite.sqliteView("raw_items", { id: sqlite.integer() }).as(sql`select id from ${items}`);
      return { items, selected, raw };
    },
  },
  {
    id: "existing-view-is-ignored",
    docs: ["views.mdx#declaring-existing-views"],
    empty: true,
    schema: () => ({ external: sqlite.sqliteView("external_view", { id: sqlite.integer() }).existing() }),
  },
  {
    id: "custom-type",
    docs: ["custom-types.mdx"],
    schema: () => {
      const customText = sqlite.customType<{ data: string }>({ dataType: () => "text" });
      return { custom: sqlite.sqliteTable("custom", { id: sqlite.integer().primaryKey(), label: customText() }) };
    },
  },
  {
    id: "composed-project",
    docs: ["sql-schema-declaration.mdx", "relations.mdx#many-to-many"],
    schema: () => {
      const table = sqlite.sqliteTableCreator((name) => `app_${name}`);
      const users = table("users", { id: sqlite.integer().primaryKey(), email: sqlite.text().notNull().unique() });
      const teams = table("teams", { id: sqlite.integer().primaryKey(), name: sqlite.text().notNull() });
      const members = table(
        "members",
        {
          userId: sqlite
            .integer()
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
          teamId: sqlite
            .integer()
            .notNull()
            .references(() => teams.id, { onDelete: "cascade" }),
        },
        (t) => [sqlite.primaryKey({ columns: [t.userId, t.teamId] })],
      );
      return { users, teams, members };
    },
  },
] satisfies readonly SchemaCase[];
