import * as orm from "drizzle-orm";
import * as sqlite from "drizzle-orm/sqlite-core";

const sql = orm.sql;

export const users = sqlite.sqliteTable(
  "corpus_users",
  {
    id: sqlite.integer().primaryKey({ autoIncrement: true }),
    name: sqlite.text().notNull(),
    email: sqlite.text({ length: 255 }).notNull().unique(),
    role: sqlite
      .text({ enum: ["reader", "writer", "admin"] })
      .notNull()
      .default("reader"),
    age: sqlite.integer(),
    profile: sqlite.text({ mode: "json" }).$type<{ city: string; languages: string[] }>(),
    joinedAt: sqlite
      .integer({ mode: "timestamp" })
      .notNull()
      .default(sql`1704067200`),
  },
  (table) => [sqlite.index("corpus_users_name_idx").on(table.name)],
);

export const posts = sqlite.sqliteTable("corpus_posts", {
  id: sqlite.integer().primaryKey({ autoIncrement: true }),
  authorId: sqlite
    .integer()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: sqlite.text().notNull(),
  published: sqlite.integer({ mode: "boolean" }).notNull().default(false),
  views: sqlite.integer().notNull().default(0),
});

export const comments = sqlite.sqliteTable("corpus_comments", {
  id: sqlite.integer().primaryKey({ autoIncrement: true }),
  postId: sqlite
    .integer()
    .notNull()
    .references(() => posts.id, { onDelete: "cascade" }),
  authorId: sqlite.integer().references(() => users.id, { onDelete: "set null" }),
  body: sqlite.text().notNull(),
});

export const groups = sqlite.sqliteTable("corpus_groups", {
  id: sqlite.integer().primaryKey({ autoIncrement: true }),
  name: sqlite.text().notNull(),
});

export const usersToGroups = sqlite.sqliteTable(
  "corpus_users_to_groups",
  {
    userId: sqlite
      .integer()
      .notNull()
      .references(() => users.id),
    groupId: sqlite
      .integer()
      .notNull()
      .references(() => groups.id),
  },
  (table) => [sqlite.primaryKey({ columns: [table.userId, table.groupId] })],
);

export const categories = sqlite.sqliteTable(
  "corpus_categories",
  {
    id: sqlite.integer().primaryKey(),
    parentId: sqlite.integer(),
    name: sqlite.text().notNull(),
  },
  (table) => [sqlite.foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }).onDelete("cascade")],
);

const lowerText = sqlite.customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.toLowerCase(),
  fromDriver: (value) => `<${value}>`,
});

export const columnTypes = sqlite.sqliteTable("corpus_column_types", {
  id: sqlite.integer().primaryKey(),
  regular: sqlite.integer(),
  alias: sqlite.int(),
  flag: sqlite.integer({ mode: "boolean" }),
  seconds: sqlite.integer({ mode: "timestamp" }),
  milliseconds: sqlite.integer({ mode: "timestamp_ms" }),
  realValue: sqlite.real(),
  numericString: sqlite.numeric(),
  numericNumber: sqlite.numeric({ mode: "number" }),
  numericBigint: sqlite.numeric({ mode: "bigint" }),
  label: sqlite.text({ enum: ["one", "two"] }),
  shortText: sqlite.text({ length: 8 }),
  jsonText: sqlite.text({ mode: "json" }),
  bytes: sqlite.blob({ mode: "buffer" }),
  jsonBlob: sqlite.blob({ mode: "json" }),
  bigBlob: sqlite.blob({ mode: "bigint" }),
  custom: lowerText(),
});

export const generated = sqlite.sqliteTable("corpus_generated", {
  id: sqlite.integer().primaryKey(),
  firstName: sqlite.text().notNull(),
  lastName: sqlite.text().notNull(),
  fullName: sqlite
    .text()
    .generatedAlwaysAs((): orm.SQL => sql`${generated.firstName} || ' ' || ${generated.lastName}`, { mode: "virtual" }),
  nameLength: sqlite.integer().generatedAlwaysAs(sql`length("firstName")`, { mode: "stored" }),
});

export const hooks = sqlite.sqliteTable("corpus_hooks", {
  id: sqlite.integer().primaryKey(),
  slug: sqlite
    .text()
    .notNull()
    .$default(() => "default-slug"),
  counter: sqlite
    .integer()
    .notNull()
    .$defaultFn(() => 7),
  revision: sqlite
    .integer()
    .notNull()
    .$default(() => 0)
    .$onUpdate((): orm.SQL => sql`${hooks.revision} + 1`),
  touchedBy: sqlite.text().$onUpdateFn(() => "updater"),
});

export const databaseDefaults = sqlite.sqliteTable("corpus_database_defaults", {
  id: sqlite.integer().primaryKey(),
  createdAt: sqlite.integer({ mode: "timestamp" }).notNull().defaultNow(),
});

export const constrained = sqlite.sqliteTable(
  "corpus_constrained",
  {
    id: sqlite.integer().primaryKey(),
    code: sqlite.text().notNull(),
    region: sqlite.text().notNull(),
    quantity: sqlite.integer().notNull(),
  },
  (table) => [
    sqlite.unique("corpus_constrained_code_region").on(table.code, table.region),
    sqlite.check("corpus_constrained_quantity", sql`${table.quantity} >= 0`),
    sqlite.uniqueIndex("corpus_constrained_code_idx").on(sql`lower(${table.code})`),
    sqlite
      .index("corpus_constrained_positive_idx")
      .on(table.quantity)
      .where(sql`${table.quantity} > 0`),
  ],
);

const prefixedTable = sqlite.sqliteTableCreator((name) => `corpus_prefixed_${name}`);
export const prefixed = prefixedTable("things", {
  id: sqlite.integer().primaryKey(),
  name: sqlite.text().notNull(),
});

export const publishedPosts = sqlite
  .sqliteView("corpus_published_posts")
  .as((qb) =>
    qb
      .select({ id: posts.id, title: posts.title, authorId: posts.authorId })
      .from(posts)
      .where(orm.eq(posts.published, true)),
  );

export const adultUsers = sqlite
  .view("corpus_adult_users", {
    id: sqlite.integer().notNull(),
    name: sqlite.text().notNull(),
  })
  .as(sql`select id, name from corpus_users where age >= 18`);

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
