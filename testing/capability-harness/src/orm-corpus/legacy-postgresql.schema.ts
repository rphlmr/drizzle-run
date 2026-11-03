import * as orm from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";

const sql = orm.sql;

export const role = pg.pgEnum("corpus_role", ["reader", "writer", "admin"]);

export const users = pg.pgTable(
  "corpus_users",
  {
    id: pg.serial().primaryKey(),
    name: pg.text().notNull(),
    email: pg.varchar({ length: 255 }).notNull().unique(),
    role: role().notNull().default("reader"),
    age: pg.integer(),
    tags: pg
      .text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    profile: pg.jsonb().$type<{ city: string; languages: string[] }>(),
    joinedAt: pg
      .timestamp({ mode: "string" })
      .notNull()
      .default(sql`'2024-01-01 00:00:00'`),
  },
  (table) => [pg.index("corpus_users_name_idx").on(table.name)],
);

export const posts = pg.pgTable("corpus_posts", {
  id: pg.serial().primaryKey(),
  authorId: pg
    .integer()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: pg.text().notNull(),
  published: pg.boolean().notNull().default(false),
  views: pg.integer().notNull().default(0),
});

export const comments = pg.pgTable("corpus_comments", {
  id: pg.serial().primaryKey(),
  postId: pg
    .integer()
    .notNull()
    .references(() => posts.id, { onDelete: "cascade" }),
  authorId: pg.integer().references(() => users.id, { onDelete: "set null" }),
  body: pg.text().notNull(),
});

export const groups = pg.pgTable("corpus_groups", {
  id: pg.serial().primaryKey(),
  name: pg.text().notNull(),
});

export const usersToGroups = pg.pgTable(
  "corpus_users_to_groups",
  {
    userId: pg
      .integer()
      .notNull()
      .references(() => users.id),
    groupId: pg
      .integer()
      .notNull()
      .references(() => groups.id),
  },
  (table) => [pg.primaryKey({ columns: [table.userId, table.groupId] })],
);

export const categories = pg.pgTable(
  "corpus_categories",
  {
    id: pg.integer().primaryKey(),
    parentId: pg.integer(),
    name: pg.text().notNull(),
  },
  (table) => [pg.foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }).onDelete("cascade")],
);

const lowerText = pg.customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.toLowerCase(),
  fromDriver: (value) => `<${value}>`,
});

const bytea = pg.customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const columnTypes = pg.pgTable("corpus_column_types", {
  id: pg.integer().primaryKey(),
  small: pg.smallint(),
  regular: pg.integer(),
  bigNumber: pg.bigint({ mode: "number" }),
  bigExact: pg.bigint({ mode: "bigint" }),
  smallSerial: pg.smallserial(),
  bigSerial: pg.bigserial({ mode: "number" }),
  flag: pg.boolean(),
  label: pg.text({ enum: ["one", "two"] }),
  shortText: pg.varchar({ length: 8 }),
  fixed: pg.char({ length: 3 }),
  exactString: pg.numeric({ precision: 10, scale: 2 }),
  exactNumber: pg.numeric({ precision: 10, scale: 2, mode: "number" }),
  exactBigint: pg.numeric({ mode: "bigint" }),
  decimalValue: pg.decimal({ precision: 6, scale: 3 }),
  realValue: pg.real(),
  doubleValue: pg.doublePrecision(),
  jsonValue: pg.json(),
  jsonbValue: pg.jsonb(),
  uuidValue: pg.uuid(),
  dateString: pg.date(),
  dateObject: pg.date({ mode: "date" }),
  timeValue: pg.time({ precision: 3 }),
  timestampDate: pg.timestamp({ precision: 3 }),
  timestampString: pg.timestamp({ mode: "string" }),
  timestampZone: pg.timestamp({ withTimezone: true, mode: "date" }),
  intervalValue: pg.interval({ fields: "day to second" }),
  pointTuple: pg.point(),
  pointObject: pg.point({ mode: "xy" }),
  lineTuple: pg.line(),
  lineObject: pg.line({ mode: "abc" }),
  inetValue: pg.inet(),
  cidrValue: pg.cidr(),
  macValue: pg.macaddr(),
  mac8Value: pg.macaddr8(),
  bytes: bytea(),
  bits: pg.bit({ dimensions: 4 }),
  integerList: pg.integer().array(),
  textMatrix: pg.text().array().array(),
  custom: lowerText(),
});

export const vectors = pg.pgTable("corpus_vectors", {
  id: pg.integer().primaryKey(),
  embedding: pg.vector({ dimensions: 3 }).notNull(),
  half: pg.halfvec({ dimensions: 3 }).notNull(),
  sparse: pg.sparsevec({ dimensions: 5 }).notNull(),
  bits: pg.bit({ dimensions: 4 }).notNull(),
});

export const identities = pg.pgTable("corpus_identities", {
  always: pg.integer().generatedAlwaysAsIdentity({ startWith: 10, increment: 5 }),
  byDefault: pg.integer().generatedByDefaultAsIdentity(),
  note: pg.text().notNull(),
});

export const generated = pg.pgTable("corpus_generated", {
  id: pg.integer().primaryKey(),
  firstName: pg.text().notNull(),
  lastName: pg.text().notNull(),
  fullName: pg.text().generatedAlwaysAs((): orm.SQL => sql`${generated.firstName} || ' ' || ${generated.lastName}`),
  nameLength: pg.integer().generatedAlwaysAs(sql`length("firstName")`),
});

export const hooks = pg.pgTable("corpus_hooks", {
  id: pg.integer().primaryKey(),
  slug: pg
    .text()
    .notNull()
    .$default(() => "default-slug"),
  counter: pg
    .integer()
    .notNull()
    .$defaultFn(() => 7),
  revision: pg
    .integer()
    .notNull()
    .$default(() => 0)
    .$onUpdate((): orm.SQL => sql`${hooks.revision} + 1`),
  touchedBy: pg.text().$onUpdateFn(() => "updater"),
});

export const databaseDefaults = pg.pgTable("corpus_database_defaults", {
  id: pg.integer().primaryKey(),
  createdAt: pg.timestamp({ withTimezone: true }).notNull().defaultNow(),
  token: pg.uuid().notNull().defaultRandom(),
});

export const constrained = pg.pgTable(
  "corpus_constrained",
  {
    id: pg.integer().primaryKey(),
    code: pg.text().notNull(),
    region: pg.text().notNull(),
    quantity: pg.integer().notNull(),
  },
  (table) => [
    pg.unique("corpus_constrained_code_region").on(table.code, table.region),
    pg.check("corpus_constrained_quantity", sql`${table.quantity} >= 0`),
    pg.uniqueIndex("corpus_constrained_code_idx").on(sql`lower(${table.code})`),
    pg
      .index("corpus_constrained_positive_idx")
      .using("btree", table.quantity.desc())
      .where(sql`${table.quantity} > 0`),
  ],
);

export const corpusSchema = pg.pgSchema("corpus_scope");
export const scopeStatus = corpusSchema.enum("corpus_scope_status", ["open", "closed"]);
export const scopedItems = corpusSchema.table("items", {
  id: pg.integer().primaryKey(),
  status: scopeStatus().notNull(),
});
export const scopedSequence = corpusSchema.sequence("corpus_scope_sequence", { startWith: 50 });

export const counter = pg.pgSequence("corpus_counter", { startWith: 1000, increment: 10 });

const prefixedTable = pg.pgTableCreator((name) => `corpus_prefixed_${name}`);
export const prefixed = prefixedTable("things", {
  id: pg.integer().primaryKey(),
  name: pg.text().notNull(),
});

export const reader = pg.pgRole("pg_read_all_data").existing();
export const secured = pg
  .pgTable(
    "corpus_secured",
    {
      id: pg.integer().primaryKey(),
      owner: pg.text().notNull(),
    },
    () => [pg.pgPolicy("corpus_secured_read", { for: "select", to: reader, using: sql`true` })],
  )
  .enableRLS();

export const publishedPosts = pg
  .pgView("corpus_published_posts")
  .as((qb) =>
    qb
      .select({ id: posts.id, title: posts.title, authorId: posts.authorId })
      .from(posts)
      .where(orm.eq(posts.published, true)),
  );

export const adultUsers = pg
  .pgView("corpus_adult_users", {
    id: pg.integer().notNull(),
    name: pg.text().notNull(),
  })
  .as(sql`select id, name from corpus_users where age >= 18`);

export const postStats = pg
  .pgMaterializedView("corpus_post_stats", {
    authorId: pg.integer("author_id").notNull(),
    total: pg.integer().notNull(),
  })
  .existing();

export const usersRelations = orm.relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
  usersToGroups: many(usersToGroups),
}));
export const postsRelations = orm.relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
}));
export const commentsRelations = orm.relations(comments, ({ one }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
}));
export const groupsRelations = orm.relations(groups, ({ many }) => ({
  usersToGroups: many(usersToGroups),
}));
export const usersToGroupsRelations = orm.relations(usersToGroups, ({ one }) => ({
  user: one(users, { fields: [usersToGroups.userId], references: [users.id] }),
  group: one(groups, { fields: [usersToGroups.groupId], references: [groups.id] }),
}));
export const categoriesRelations = orm.relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id], relationName: "tree" }),
  children: many(categories, { relationName: "tree" }),
}));
