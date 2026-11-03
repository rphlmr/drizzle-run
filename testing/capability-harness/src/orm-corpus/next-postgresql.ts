import * as orm from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as pg from "drizzle-orm/pg-core";
import { usedTablesOf } from "drizzle-orm/used-tables";

import * as schema from "./next-postgresql.schema.ts";
import { describeError, runRolledBack } from "./run-cases.ts";
import type { OrmCase } from "./types.ts";

// Typing the row keeps `execute` on one result: rc5 types an untyped `execute` as one result or, for several
// statements, an array of them.
type CorpusRow = Record<string, unknown>;

type Database = NodePgDatabase<typeof schema.relations>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const sql = orm.sql;
const { users, posts, comments, groups, usersToGroups, categories } = schema;

function rolledBack<TValue>(db: Database, work: (tx: Transaction) => Promise<TValue>): Promise<TValue> {
  return runRolledBack<Transaction, TValue>((body) => db.transaction(body), work);
}

async function captureError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await work() };
  } catch (cause) {
    return { rejected: describeError(cause) };
  }
}

const columnTypesRow = {
  id: 1,
  small: 12,
  regular: 1_234,
  bigNumber: 9_007_199_254_740_991,
  bigExact: 9_223_372_036_854_775_807n,
  flag: true,
  label: "two",
  shortText: "short",
  fixed: "abc",
  exactString: "1234.50",
  exactNumber: 99.25,
  exactBigint: 123_456_789_012_345_678_901_234_567_890n,
  decimalValue: "1.250",
  realValue: 1.5,
  doubleValue: Math.PI,
  jsonValue: { nested: { list: [1, "two", null] } },
  jsonbValue: { b: 2, a: 1 },
  uuidValue: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  dateString: "2024-02-29",
  dateObject: new Date("2024-03-01T00:00:00.000Z"),
  timeValue: "12:34:56.789",
  timestampDate: new Date("2024-01-02T03:04:05.678Z"),
  timestampString: "2024-01-02 03:04:05",
  timestampZone: new Date("2024-06-30T23:59:59.000Z"),
  intervalValue: "1 day 02:03:04",
  pointTuple: [1.5, -2] as [number, number],
  pointObject: { x: 3, y: 4 },
  lineTuple: [1, -1, 0] as [number, number, number],
  lineObject: { a: 2, b: 3, c: 4 },
  inetValue: "192.168.10.1/24",
  cidrValue: "10.0.0.0/8",
  macValue: "08:00:2b:01:02:03",
  mac8Value: "08:00:2b:01:02:03:04:05",
  bytes: Buffer.from([0, 1, 127, 128, 255]),
  bits: "1010",
  integerList: [3, 1, 2],
  textMatrix: [
    ["a", "b"],
    ["c", "d"],
  ],
  custom: "MiXeD",
} satisfies typeof schema.columnTypes.$inferInsert;

const toIds = (rows: { id: number }[]) => rows.map((row) => row.id);

const toSortedIds = (rows: { id: number }[]) => rows.map((row) => row.id).toSorted((left, right) => left - right);

/** The PostgreSQL ORM scenarios for drizzle-orm 1.0.0-rc.5, run in order against one database. */
export const cases: OrmCase<Database>[] = [
  {
    id: "baseline-seed",
    run: async (db) => {
      const insertedUsers = await db
        .insert(users)
        .values([
          {
            name: "Ada",
            email: "ada@example.test",
            role: "admin",
            age: 36,
            tags: ["math", "engines"],
            profile: { city: "London", languages: ["en"] },
          },
          {
            name: "Grace",
            email: "grace@example.test",
            role: "writer",
            age: 45,
            tags: ["navy", "cobol"],
            profile: { city: "Arlington", languages: ["en", "cobol"] },
          },
          { name: "Linus", email: "linus@example.test", age: 17, tags: ["kernel"] },
          { name: "Margaret", email: "margaret@example.test", role: "writer" },
        ])
        .returning();
      await db.insert(posts).values([
        { authorId: 1, title: "Notes", published: true, views: 100 },
        { authorId: 1, title: "Engines", views: 5 },
        { authorId: 2, title: "Compilers", published: true, views: 50 },
        { authorId: 3, title: "Kernels", published: true },
      ]);
      await db.insert(comments).values([
        { postId: 1, authorId: 2, body: "Brilliant" },
        { postId: 1, authorId: 3, body: "Agreed" },
        { postId: 3, authorId: 1, body: "Great" },
        { postId: 3, body: "Anonymous" },
      ]);
      await db.insert(groups).values([{ name: "Pioneers" }, { name: "Writers" }]);
      await db.insert(usersToGroups).values([
        { userId: 1, groupId: 1 },
        { userId: 2, groupId: 1 },
        { userId: 2, groupId: 2 },
        { userId: 4, groupId: 2 },
      ]);
      await db.insert(categories).values([
        { id: 1, name: "Root" },
        { id: 2, parentId: 1, name: "Child" },
        { id: 3, parentId: 2, name: "Grandchild" },
      ]);

      return insertedUsers;
    },
  },
  {
    id: "select-all-and-partial",
    run: async (db) => {
      const all = await db.select().from(users).orderBy(users.id);
      const partial = await db
        .select({ id: users.id, name: users.name, nested: { email: users.email, role: users.role } })
        .from(users)
        .orderBy(orm.desc(users.id));
      const spread = await db
        .select({ ...orm.getTableColumns(posts), authorName: users.name })
        .from(posts)
        .innerJoin(users, orm.eq(posts.authorId, users.id))
        .orderBy(posts.id);
      const columns = await db.select(orm.getColumns(groups)).from(groups).orderBy(groups.id);

      return { all, partial, spread, columns };
    },
  },
  {
    id: "select-sql-fields",
    run: async (db) => {
      return db
        .select({
          id: users.id,
          upper: sql<string>`upper(${users.name})`.as("upper_name"),
          length: sql`length(${users.name})`.mapWith(Number),
          literal: sql<number>`1 + 1`.mapWith(users.age),
          tagCount: sql<number>`cardinality(${users.tags})`,
        })
        .from(users)
        .orderBy(users.id);
    },
  },
  {
    id: "select-distinct",
    run: async (db) => {
      const distinct = await db.selectDistinct({ role: users.role }).from(users).orderBy(users.role);
      const distinctOn = await db
        .selectDistinctOn([posts.authorId], { authorId: posts.authorId, title: posts.title })
        .from(posts)
        .orderBy(posts.authorId, orm.desc(posts.views));

      return { distinct, distinctOn };
    },
  },
  {
    id: "where-comparison-operators",
    run: async (db) => {
      const ids = async (where: orm.SQL | undefined) =>
        (await db.select({ id: users.id }).from(users).where(where).orderBy(users.id)).map((row) => row.id);

      return {
        eq: await ids(orm.eq(users.role, "writer")),
        ne: await ids(orm.ne(users.role, "writer")),
        gt: await ids(orm.gt(users.age, 36)),
        gte: await ids(orm.gte(users.age, 36)),
        lt: await ids(orm.lt(users.age, 36)),
        lte: await ids(orm.lte(users.age, 36)),
        columnToColumn: await ids(orm.eq(users.id, users.id)),
      };
    },
  },
  {
    id: "where-logical-null-and-sets",
    run: async (db) => {
      const ids = async (where: orm.SQL | undefined) =>
        (await db.select({ id: users.id }).from(users).where(where).orderBy(users.id)).map((row) => row.id);

      return {
        and: await ids(orm.and(orm.eq(users.role, "writer"), orm.isNotNull(users.age))),
        or: await ids(orm.or(orm.eq(users.role, "admin"), orm.isNull(users.age))),
        not: await ids(orm.not(orm.eq(users.role, "writer"))),
        andWithUndefined: await ids(orm.and(undefined, orm.eq(users.id, 1))),
        isNull: await ids(orm.isNull(users.age)),
        isNotNull: await ids(orm.isNotNull(users.age)),
        inArray: await ids(orm.inArray(users.id, [1, 3])),
        notInArray: await ids(orm.notInArray(users.id, [1, 3])),
        emptyInArray: await ids(orm.inArray(users.id, [])),
        emptyNotInArray: await ids(orm.notInArray(users.id, [])),
        inSubquery: await ids(orm.inArray(users.id, db.select({ id: posts.authorId }).from(posts))),
        between: await ids(orm.between(users.age, 17, 40)),
        notBetween: await ids(orm.notBetween(users.age, 17, 40)),
      };
    },
  },
  {
    id: "where-pattern-and-exists",
    run: async (db) => {
      const ids = async (where: orm.SQL | undefined) =>
        (await db.select({ id: users.id }).from(users).where(where).orderBy(users.id)).map((row) => row.id);
      const authored = db
        .select({ one: sql`1` })
        .from(posts)
        .where(orm.eq(posts.authorId, users.id));

      return {
        like: await ids(orm.like(users.name, "%a%")),
        notLike: await ids(orm.notLike(users.name, "%a%")),
        ilike: await ids(orm.ilike(users.name, "a%")),
        notIlike: await ids(orm.notIlike(users.name, "a%")),
        exists: await ids(orm.exists(authored)),
        notExists: await ids(orm.notExists(authored)),
      };
    },
  },
  {
    id: "where-array-operators",
    run: async (db) => {
      const ids = async (where: orm.SQL | undefined) =>
        (await db.select({ id: users.id }).from(users).where(where).orderBy(users.id)).map((row) => row.id);

      return {
        arrayContains: await ids(orm.arrayContains(users.tags, ["math"])),
        arrayContained: await ids(orm.arrayContained(users.tags, ["kernel", "navy", "cobol"])),
        arrayOverlaps: await ids(orm.arrayOverlaps(users.tags, ["cobol", "kernel"])),
      };
    },
  },
  {
    id: "order-limit-offset",
    run: async (db) => {
      const ordered = await db
        .select({ id: users.id, age: users.age })
        .from(users)
        .orderBy(orm.desc(users.age), orm.asc(users.id));
      const nullsLast = await db
        .select({ id: users.id })
        .from(users)
        .orderBy(sql`${users.age} asc nulls last`);
      const page = await db.select({ id: posts.id }).from(posts).orderBy(posts.id).limit(2).offset(1);
      const callbackOrder = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .orderBy((fields) => orm.desc(fields.name));

      return { ordered, nullsLast, page, callbackOrder };
    },
  },
  {
    id: "aggregates-group-by-having",
    run: async (db) => {
      const totals = await db
        .select({
          authorId: posts.authorId,
          posts: orm.count(),
          withTitle: orm.count(posts.title),
          distinctPublished: orm.countDistinct(posts.published),
          averageViews: orm.avg(posts.views),
          averageDistinct: orm.avgDistinct(posts.views),
          totalViews: orm.sum(posts.views),
          distinctViews: orm.sumDistinct(posts.views),
          maxViews: orm.max(posts.views),
          minViews: orm.min(posts.views),
        })
        .from(posts)
        .groupBy(posts.authorId)
        .having(({ posts: total }) => orm.gt(total, 0))
        .orderBy(posts.authorId);
      const busyAuthors = await db
        .select({ authorId: posts.authorId })
        .from(posts)
        .groupBy(posts.authorId)
        .having(orm.gt(orm.sum(posts.views), 10))
        .orderBy(posts.authorId);

      return { totals, busyAuthors };
    },
  },
  {
    id: "joins",
    run: async (db) => {
      const left = await db
        .select({ user: users.name, post: posts.title })
        .from(users)
        .leftJoin(posts, orm.eq(posts.authorId, users.id))
        .orderBy(users.id, posts.id);
      const right = await db
        .select({ user: users.name, comment: comments.body })
        .from(users)
        .rightJoin(comments, orm.eq(comments.authorId, users.id))
        .orderBy(comments.id);
      const inner = await db.select().from(posts).innerJoin(users, orm.eq(posts.authorId, users.id)).orderBy(posts.id);
      const full = await db
        .select({ user: users.name, comment: comments.body })
        .from(users)
        .fullJoin(comments, orm.eq(comments.authorId, users.id))
        .orderBy(users.id, comments.id);
      const cross = await db
        .select({ user: users.id, group: groups.id })
        .from(users)
        .crossJoin(groups)
        .orderBy(users.id, groups.id);

      return { left, right, inner, full, cross };
    },
  },
  {
    id: "lateral-joins",
    run: async (db) => {
      const latest = db
        .select({ title: posts.title })
        .from(posts)
        .where(orm.eq(posts.authorId, users.id))
        .orderBy(orm.desc(posts.id))
        .limit(1)
        .as("latest");
      const leftLateral = await db
        .select({ user: users.name, latest: latest.title })
        .from(users)
        .leftJoinLateral(latest, sql`true`)
        .orderBy(users.id);
      const innerLateral = await db
        .select({ user: users.name, latest: latest.title })
        .from(users)
        .innerJoinLateral(latest, sql`true`)
        .orderBy(users.id);
      const crossLateral = await db
        .select({ user: users.name, latest: latest.title })
        .from(users)
        .crossJoinLateral(latest)
        .orderBy(users.id);

      return { leftLateral, innerLateral, crossLateral };
    },
  },
  {
    id: "aliases-and-self-joins",
    run: async (db) => {
      const parent = pg.alias(categories, "parent");
      const tree = await db
        .select({ child: categories.name, parent: parent.name })
        .from(categories)
        .leftJoin(parent, orm.eq(categories.parentId, parent.id))
        .orderBy(categories.id);
      const aliased = orm.aliasedTable(users, "aliased_users");
      const aliasedName = orm.aliasedTableColumn(users.name, "aliased_users");
      const fromAliased = await db.select({ name: aliasedName }).from(aliased).orderBy(aliasedName);
      const renamed = orm.aliasedColumn(users.email, "contact");
      const original = orm.getOriginalColumnFromAlias(renamed) === users.email;

      return { tree, fromAliased, original };
    },
  },
  {
    id: "subqueries",
    run: async (db) => {
      const popular = db
        .select({ authorId: posts.authorId, views: posts.views })
        .from(posts)
        .where(orm.gt(posts.views, 10))
        .as("popular");
      const fromSubquery = await db
        .select({ authorId: popular.authorId, views: popular.views })
        .from(popular)
        .orderBy(popular.authorId);
      const scalar = await db
        .select({
          name: users.name,
          latestTitle: sql<string>`(${db.select({ title: posts.title }).from(posts).where(orm.eq(posts.authorId, users.id)).orderBy(orm.desc(posts.id)).limit(1)})`,
        })
        .from(users)
        .orderBy(users.id);
      const sqlSubquery = db
        .select({ total: sql<number>`count(*)`.as("total") })
        .from(posts)
        .as("totals");
      const withSqlAlias = await db.select().from(sqlSubquery);

      return { fromSubquery, scalar, withSqlAlias };
    },
  },
  {
    id: "common-table-expressions",
    run: async (db) => {
      const writers = db
        .$with("writers")
        .as(db.select({ id: users.id, name: users.name }).from(users).where(orm.eq(users.role, "writer")));
      const fromCte = await db.with(writers).select().from(writers).orderBy(writers.id);
      const raw = db
        .$with("numbers", { value: sql<number>`value`.mapWith(Number).as("value") })
        .as(sql`select generate_series(1, 3) as value`);
      const fromRawCte = await db.with(raw).select().from(raw);
      const modifying = await rolledBack(db, async (tx) => {
        const inserted = tx
          .$with("inserted")
          .as(tx.insert(groups).values({ name: "From CTE" }).returning({ name: groups.name }));
        const updated = tx
          .$with("updated")
          .as(tx.update(posts).set({ views: 1 }).where(orm.eq(posts.id, 4)).returning({ id: posts.id }));
        const deleted = tx
          .$with("deleted")
          .as(tx.delete(comments).where(orm.eq(comments.id, 4)).returning({ id: comments.id }));

        return {
          inserted: await tx.with(inserted).select().from(inserted),
          updated: await tx.with(updated).select().from(updated),
          deleted: await tx.with(deleted).select().from(deleted),
        };
      });

      return { fromCte, fromRawCte, modifying };
    },
  },
  {
    id: "set-operations",
    run: async (db) => {
      const authors = () => db.select({ id: posts.authorId }).from(posts);
      const commenters = () =>
        db
          .select({ id: sql<number>`${comments.authorId}`.as("id") })
          .from(comments)
          .where(orm.isNotNull(comments.authorId));

      return {
        union: toSortedIds(await pg.union(authors(), commenters())),
        unionAll: toSortedIds(await pg.unionAll(authors(), commenters())),
        intersect: toSortedIds(await pg.intersect(authors(), commenters())),
        intersectAll: toSortedIds(await pg.intersectAll(authors(), commenters())),
        except: toSortedIds(await pg.except(authors(), commenters())),
        exceptAll: toSortedIds(await pg.exceptAll(authors(), commenters())),
        chained: await db
          .select({ id: users.id })
          .from(users)
          .where(orm.eq(users.id, 1))
          .union(db.select({ id: users.id }).from(users).where(orm.eq(users.id, 2)))
          .unionAll(db.select({ id: users.id }).from(users).where(orm.eq(users.id, 2)))
          .intersect(db.select({ id: users.id }).from(users))
          .except(db.select({ id: users.id }).from(users).where(orm.eq(users.id, 3)))
          .orderBy(orm.asc(users.id))
          .limit(5),
        chainedAll: await db
          .select({ id: users.id })
          .from(users)
          .intersectAll(db.select({ id: posts.authorId }).from(posts))
          .exceptAll(db.select({ id: users.id }).from(users).where(orm.eq(users.id, 2)))
          .orderBy(orm.asc(users.id)),
      };
    },
  },
  {
    id: "dynamic-query-building",
    run: async (db) => {
      const withFilters = <TQuery extends pg.PgSelect>(query: TQuery, role?: "writer" | "admin") =>
        role === undefined ? query : query.where(orm.eq(users.role, role));
      const base = db.select({ id: users.id }).from(users).$dynamic();

      return {
        all: await withFilters(db.select({ id: users.id }).from(users).$dynamic()).orderBy(users.id),
        writers: await withFilters(base, "writer").orderBy(users.id),
        joined: await db
          .select({ id: users.id })
          .from(users)
          .$dynamic()
          .leftJoin(posts, orm.eq(posts.authorId, users.id))
          .where(orm.isNull(posts.id)),
      };
    },
  },
  {
    id: "count-helper",
    run: async (db) => {
      return {
        total: await db.$count(users),
        writers: await db.$count(users, orm.eq(users.role, "writer")),
        nested: await db
          .select({ id: users.id, posts: db.$count(posts, orm.eq(posts.authorId, users.id)) })
          .from(users)
          .orderBy(users.id),
      };
    },
  },
  {
    id: "row-locking",
    run: async (db) => {
      return rolledBack(db, async (tx) => ({
        forUpdate: await tx.select({ id: users.id }).from(users).where(orm.eq(users.id, 1)).for("update"),
        forShareSkipLocked: await tx
          .select({ id: users.id })
          .from(users)
          .orderBy(users.id)
          .for("share", { skipLocked: true }),
        forNoKeyUpdateNoWait: await tx
          .select({ id: users.id })
          .from(users)
          .where(orm.eq(users.id, 2))
          .for("no key update", { noWait: true }),
        forKeyShareOf: await tx
          .select({ id: posts.id })
          .from(posts)
          .innerJoin(users, orm.eq(posts.authorId, users.id))
          .where(orm.eq(posts.id, 1))
          .for("key share", { of: posts }),
      }));
    },
  },
  {
    id: "query-cache-opt-in",
    run: async (db) => {
      return {
        defaults: await db.select({ id: users.id }).from(users).orderBy(users.id).$withCache(),
        configured: await db
          .select({ name: users.name })
          .from(users)
          .where(orm.eq(users.id, 1))
          .$withCache({ tag: "corpus-user", config: { ex: 60 }, autoInvalidate: false }),
        disabled: await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1).$withCache(false),
      };
    },
  },
  {
    id: "prepared-statements-and-placeholders",
    run: async (db) => {
      const byId = db
        .select({ name: users.name })
        .from(users)
        .where(orm.eq(users.id, sql.placeholder("id")))
        .prepare("corpus_user_by_id");
      const byRole = db
        .select({ id: users.id })
        .from(users)
        .where(orm.eq(users.role, orm.placeholder("role")))
        .orderBy(users.id)
        .limit(sql.placeholder("limit"))
        .prepare("corpus_users_by_role");
      const insertGroup = db
        .insert(groups)
        .values({ name: sql.placeholder("name") })
        .returning({ name: groups.name })
        .prepare("corpus_insert_group");
      const inserted = await rolledBack(db, async () => insertGroup.execute({ name: "Prepared" }));

      return {
        first: await byId.execute({ id: 1 }),
        second: await byId.execute({ id: 2 }),
        writers: await byRole.execute({ role: "writer", limit: 1 }),
        inserted,
        filled: orm.fillPlaceholders([sql.placeholder("a"), 2], { a: 1 }),
      };
    },
  },
  {
    id: "sql-template-helpers",
    run: async (db) => {
      const columns = [users.id, users.name];
      const query = sql`select ${sql.join(columns, sql`, `)} from ${users} where ${users.id} = ${1}${sql.empty()}`;
      const identifiers = sql`select ${sql.identifier("name")} from ${sql.identifier("corpus_users")} where ${orm.name("id")} = ${orm.param(2)}`;
      const raw = sql.raw("select 3 as three");
      const fromList = sql.fromList([sql`select `, sql.param(4), sql` as four`]);
      const appended = sql`select 5`.append(sql` as five`);
      const dialect = new pg.PgDialect();
      const commented = db
        .select({ id: users.id })
        .from(users)
        .where(orm.eq(users.id, 1))
        .comment({ route: "corpus", attempt: 1 });

      return {
        joined: (await db.execute<CorpusRow>(query)).rows,
        identifiers: (await db.execute<CorpusRow>(identifiers)).rows,
        raw: (await db.execute<CorpusRow>(raw)).rows,
        fromList: (await db.execute<CorpusRow>(fromList)).rows,
        appended: (await db.execute<CorpusRow>(appended)).rows,
        typed: (await db.execute<{ total: string }>(sql`select count(*) as total from ${users}`)).rows,
        inlined: dialect.sqlToQuery(sql`select ${"it's"}, ${10}`.inlineParams()),
        rendered: dialect.sqlToQuery(query),
        isWrapper: [orm.isSQLWrapper(query), orm.isSQLWrapper(users), orm.isSQLWrapper("text")],
        bound: dialect.sqlToQuery(sql`${orm.bindIfParam(5, users.age)}`),
        commented: { sql: commented.toSQL(), rows: await commented },
        commenter: [orm.sqlCommenter({ route: "corpus", flag: true }), orm.sqlCommenter.merge("a='1'", { b: 2 })],
      };
    },
  },
  {
    id: "to-sql",
    run: async (db) => {
      return {
        select: db.select().from(users).where(orm.eq(users.id, 1)).toSQL(),
        insert: db
          .insert(users)
          .values({ name: "To SQL", email: "to-sql@example.test" })
          .returning({ id: users.id })
          .toSQL(),
        update: db.update(users).set({ age: 1 }).where(orm.eq(users.id, 1)).toSQL(),
        delete: db.delete(users).where(orm.eq(users.id, 1)).toSQL(),
        relational: db.query.users.findMany({ with: { posts: true }, limit: 1 }).toSQL(),
        embedded: (
          await db.execute<{ total: number }>(
            sql`select count(*)::int as total from (${db.select({ id: users.id }).from(users).getSQL()}) as listed`,
          )
        ).rows,
        count: db.$count(users).getSQL().queryChunks.length > 0,
      };
    },
  },
  {
    id: "insert-variants",
    run: async (db) => {
      return rolledBack(db, async (tx) => {
        const single = await tx.insert(groups).values({ name: "Single" }).returning();
        const many = await tx
          .insert(groups)
          .values([{ name: "Many A" }, { name: "Many B" }])
          .returning({ name: groups.name });
        const noReturning = await tx.insert(groups).values({ name: "Quiet" });
        const fromSelect = await tx
          .insert(groups)
          .select(
            tx
              .select({ id: sql<number>`${users.id} + 100`.as("id"), name: users.name })
              .from(users)
              .where(orm.lte(users.id, 2)),
          )
          .returning({ id: groups.id, name: groups.name });
        const fromCallback = await tx
          .insert(groups)
          .select((qb) =>
            qb
              .select({ id: sql<number>`200`.as("id"), name: users.name })
              .from(users)
              .where(orm.eq(users.id, 3)),
          )
          .returning({ id: groups.id });
        const sqlValue = await tx
          .insert(groups)
          .values({ name: sql`upper('sql value')` })
          .returning({ name: groups.name });

        return { single, many, rowCount: noReturning.rowCount, fromSelect, fromCallback, sqlValue };
      });
    },
  },
  {
    id: "insert-on-conflict",
    run: async (db) => {
      return rolledBack(db, async (tx) => {
        const nothing = await tx
          .insert(users)
          .values({ name: "Duplicate", email: "ada@example.test" })
          .onConflictDoNothing()
          .returning({ id: users.id });
        const nothingTarget = await tx
          .insert(users)
          .values({ name: "Duplicate", email: "ada@example.test" })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        const update = await tx
          .insert(users)
          .values({ name: "Ada Lovelace", email: "ada@example.test" })
          .onConflictDoUpdate({ target: users.email, set: { name: sql`excluded.name` } })
          .returning({ id: users.id, name: users.name });
        const updateWhere = await tx
          .insert(users)
          .values({ name: "Not applied", email: "grace@example.test" })
          .onConflictDoUpdate({
            target: users.email,
            set: { name: "Not applied" },
            setWhere: orm.eq(users.role, "admin"),
          })
          .returning({ id: users.id });
        const composite = await tx
          .insert(usersToGroups)
          .values({ userId: 1, groupId: 1 })
          .onConflictDoUpdate({ target: [usersToGroups.userId, usersToGroups.groupId], set: { groupId: 1 } })
          .returning();

        return { nothing, nothingTarget, update, updateWhere, composite };
      });
    },
  },
  {
    id: "update-variants",
    run: async (db) => {
      return rolledBack(db, async (tx) => {
        const set = await tx
          .update(users)
          .set({ age: 37, profile: null })
          .where(orm.eq(users.id, 1))
          .returning({ id: users.id, age: users.age, profile: users.profile });
        const expression = await tx
          .update(posts)
          .set({ views: sql`${posts.views} * 2` })
          .where(orm.eq(posts.published, true))
          .returning({ id: posts.id, views: posts.views });
        const fromJoin = await tx
          .update(posts)
          .set({ title: sql`${users.name} || ': ' || ${posts.title}` })
          .from(users)
          .where(orm.and(orm.eq(posts.authorId, users.id), orm.eq(users.role, "writer")))
          .returning({ id: posts.id, title: posts.title, author: users.name });
        const noMatch = await tx.update(users).set({ age: 1 }).where(orm.eq(users.id, -1)).returning();
        const unconditional = await tx.update(posts).set({ published: false });

        return { set, expression, fromJoin, noMatch, rowCount: unconditional.rowCount };
      });
    },
  },
  {
    id: "delete-variants",
    run: async (db) => {
      return rolledBack(db, async (tx) => {
        const returned = await tx.delete(comments).where(orm.eq(comments.postId, 3)).returning({ body: comments.body });
        const cascaded = await tx.delete(users).where(orm.eq(users.id, 3)).returning({ id: users.id });
        const nulledComments = await tx
          .select({ id: comments.id, authorId: comments.authorId })
          .from(comments)
          .orderBy(comments.id);
        const remainingPosts = await tx.select({ id: posts.id }).from(posts).orderBy(posts.id);
        const everything = await tx.delete(usersToGroups);

        return { returned, cascaded, nulledComments, remainingPosts, rowCount: everything.rowCount };
      });
    },
  },
  {
    id: "transactions",
    run: async (db) => {
      const committed = await db.transaction(
        async (tx) => {
          const [group] = await tx.insert(groups).values({ name: "Committed" }).returning({ id: groups.id });
          await tx.transaction(async (nested) => {
            await nested.insert(groups).values({ name: "Savepoint kept" });
          });
          await captureError(() =>
            tx.transaction(async (nested) => {
              await nested.insert(groups).values({ name: "Savepoint rolled back" });
              nested.rollback();
            }),
          );

          return group.id;
        },
        { isolationLevel: "serializable", accessMode: "read write", deferrable: false },
      );
      const explicitRollback = await captureError(() =>
        db.transaction(async (tx) => {
          await tx.insert(groups).values({ name: "Never committed" });
          tx.rollback();
        }),
      );
      const thrown = await captureError(() =>
        db.transaction(async (tx) => {
          await tx.insert(groups).values({ name: "Thrown away" });
          throw new orm.DrizzleError({ message: "corpus failure" });
        }),
      );
      const readOnly = await captureError(() =>
        db.transaction(
          async (tx) => {
            await tx.insert(groups).values({ name: "Read only" });
          },
          { accessMode: "read only", isolationLevel: "repeatable read" },
        ),
      );
      const setTransaction = await rolledBack(db, async (tx) => {
        await tx.setTransaction({ isolationLevel: "repeatable read", accessMode: "read only" });
        const settings = await tx.execute<CorpusRow>(
          sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`,
        );

        return settings.rows;
      });
      const names = await db.select({ name: groups.name }).from(groups).orderBy(groups.id);
      await db.delete(groups).where(orm.inArray(groups.name, ["Committed", "Savepoint kept"]));

      return { committed, explicitRollback, thrown, readOnly, setTransaction, names };
    },
  },
  {
    id: "database-errors",
    run: async (db) => {
      return {
        unique: await captureError(() => db.insert(users).values({ name: "Copy", email: "ada@example.test" })),
        foreignKey: await captureError(() => db.insert(posts).values({ authorId: 999, title: "Orphan" })),
        check: await captureError(() =>
          db.insert(schema.constrained).values({ id: 1, code: "a", region: "eu", quantity: -1 }),
        ),
        notNull: await captureError(() => db.execute(sql`insert into ${users} (name) values ('No email')`)),
        syntax: await captureError(() => db.execute(sql.raw("select from where"))),
      };
    },
  },
  {
    id: "relational-find-many",
    run: async (db) => {
      return {
        all: await db.query.users.findMany({ orderBy: { id: "asc" } }),
        columns: await db.query.users.findMany({ columns: { id: true, name: true }, orderBy: { id: "desc" } }),
        excluded: await db.query.users.findMany({
          columns: { profile: false, tags: false },
          limit: 2,
          offset: 1,
          orderBy: { id: "asc" },
        }),
        nested: await db.query.users.findMany({
          columns: { name: true },
          with: {
            posts: {
              columns: { title: true },
              orderBy: { id: "asc" },
              with: { comments: { columns: { body: true }, orderBy: { id: "asc" } } },
            },
          },
          orderBy: { id: "asc" },
        }),
        manyToMany: await db.query.users.findMany({
          columns: { name: true },
          with: { groups: { columns: { name: true }, orderBy: { id: "asc" } } },
          orderBy: { id: "asc" },
        }),
        reverseManyToMany: await db.query.groups.findMany({
          with: { members: { columns: { name: true }, orderBy: { id: "asc" } } },
          orderBy: { id: "asc" },
        }),
        aliased: await db.query.users.findMany({
          columns: { name: true },
          with: { publishedPosts: { columns: { title: true }, orderBy: { id: "asc" } } },
          orderBy: { id: "asc" },
        }),
        selfReference: await db.query.categories.findMany({
          with: { parent: true, children: true },
          orderBy: { id: "asc" },
        }),
        extras: await db.query.users.findMany({
          columns: { id: true },
          extras: { lowerName: (table, { sql: relationalSql }) => relationalSql<string>`lower(${table.name})` },
          orderBy: { id: "asc" },
        }),
        orderCallback: await db.query.posts.findMany({
          columns: { id: true },
          orderBy: (table, { desc }) => [desc(table.views), desc(table.id)],
        }),
      };
    },
  },
  {
    id: "relational-filters",
    run: async (db) => {
      return {
        equals: toIds(await db.query.users.findMany({ where: { role: "writer" }, orderBy: { id: "asc" } })),
        operators: toIds(
          await db.query.users.findMany({ where: { age: { gt: 17, lte: 45 } }, orderBy: { id: "asc" } }),
        ),
        or: toIds(
          await db.query.users.findMany({
            where: { OR: [{ role: "admin" }, { age: { isNull: true } }] },
            orderBy: { id: "asc" },
          }),
        ),
        not: toIds(await db.query.users.findMany({ where: { NOT: { role: "writer" } }, orderBy: { id: "asc" } })),
        and: toIds(
          await db.query.users.findMany({
            where: { AND: [{ role: "writer" }, { age: { isNotNull: true } }] },
            orderBy: { id: "asc" },
          }),
        ),
        inList: toIds(await db.query.users.findMany({ where: { id: { in: [2, 3] } }, orderBy: { id: "asc" } })),
        notInList: toIds(await db.query.users.findMany({ where: { id: { notIn: [2, 3] } }, orderBy: { id: "asc" } })),
        like: toIds(await db.query.users.findMany({ where: { name: { like: "%a%" } }, orderBy: { id: "asc" } })),
        ilike: toIds(await db.query.users.findMany({ where: { name: { ilike: "g%" } }, orderBy: { id: "asc" } })),
        arrays: toIds(
          await db.query.users.findMany({
            where: { tags: { arrayOverlaps: ["math", "kernel"] } },
            orderBy: { id: "asc" },
          }),
        ),
        relation: toIds(
          await db.query.users.findMany({ where: { posts: { published: false } }, orderBy: { id: "asc" } }),
        ),
        relationExists: toIds(await db.query.users.findMany({ where: { comments: true }, orderBy: { id: "asc" } })),
        raw: toIds(
          await db.query.users.findMany({
            where: { RAW: (table) => sql`${table.id} % 2 = 0` },
            orderBy: { id: "asc" },
          }),
        ),
        nestedWhere: await db.query.users.findMany({
          columns: { id: true },
          with: { posts: { columns: { title: true }, where: { views: { gte: 50 } } } },
          where: { id: { lte: 2 } },
          orderBy: { id: "asc" },
        }),
      };
    },
  },
  {
    id: "relational-find-first-and-prepared",
    run: async (db) => {
      const prepared = db.query.users
        .findFirst({ where: { id: { eq: sql.placeholder("id") } }, columns: { name: true } })
        .prepare("corpus_relational_user");

      return {
        first: await db.query.users.findFirst({ orderBy: { id: "desc" }, with: { posts: true } }),
        missing: await db.query.users.findFirst({ where: { id: -1 } }),
        preparedFirst: await prepared.execute({ id: 2 }),
        preparedSecond: await prepared.execute({ id: 3 }),
        oneRequired: await db.query.posts.findFirst({
          where: { id: 3 },
          with: { author: { columns: { name: true } } },
        }),
        oneOptional: await db.query.comments.findMany({
          columns: { body: true },
          with: { author: { columns: { name: true } } },
          orderBy: { id: "asc" },
        }),
      };
    },
  },
  {
    id: "views",
    run: async (db) => {
      await db.execute(
        sql`create materialized view ${schema.postStats} as select ${posts.authorId} as author_id, count(*)::int as total from ${posts} group by ${posts.authorId}`,
      );

      return {
        builderView: await db
          .select()
          .from(schema.publishedPosts)
          .where(orm.gt(schema.publishedPosts.id, 1))
          .orderBy(schema.publishedPosts.id),
        sqlView: await db.select().from(schema.adultUsers).orderBy(schema.adultUsers.id),
        materialized: await db.select().from(schema.postStats).orderBy(schema.postStats.authorId),
        refreshWithNoData: await db.refreshMaterializedView(schema.postStats).withNoData(),
        unpopulated: await captureError(() => db.select().from(schema.postStats)),
        refreshed: await db.refreshMaterializedView(schema.postStats),
        refreshedConcurrently: await rolledBack(db, async (tx) => {
          // A concurrent refresh needs a unique index on the materialized view.
          await tx.execute(sql`create unique index corpus_post_stats_author on ${schema.postStats} (author_id)`);

          return tx.refreshMaterializedView(schema.postStats).concurrently();
        }),
        afterRefresh: await db.select().from(schema.postStats).orderBy(schema.postStats.authorId),
        name: orm.getViewName(schema.publishedPosts),
        selected: Object.keys(orm.getViewSelectedFields(schema.publishedPosts)),
        config: pg.getViewConfig(schema.publishedPosts).name,
        materializedConfig: pg.getMaterializedViewConfig(schema.postStats).name,
      };
    },
  },
  {
    id: "enums-schemas-and-sequences",
    run: async (db) => {
      await db.insert(schema.scopedItems).values([
        { id: 1, status: "open" },
        { id: 2, status: "closed" },
      ]);

      return {
        enumValues: schema.role.enumValues,
        enumWithSchema: schema.scopeStatus.schema,
        scoped: await db.select().from(schema.scopedItems).where(orm.eq(schema.scopedItems.status, "closed")),
        scopedSql: db.select().from(schema.scopedItems).toSQL(),
        counter: (
          await db.execute<CorpusRow>(sql`select nextval('corpus_counter') as value, nextval('corpus_counter') as next`)
        ).rows,
        scopedSequence: (
          await db.execute<CorpusRow>(sql`select nextval('corpus_scope.corpus_scope_sequence') as value`)
        ).rows,
        prefixed: db.select().from(schema.prefixed).toSQL(),
        prefixedRows: await db.insert(schema.prefixed).values({ id: 1, name: "prefixed" }).returning(),
        secured: await db.insert(schema.secured).values({ id: 1, owner: "corpus" }).returning(),
        enumRejected: await captureError(() =>
          db.execute(sql`insert into ${users} (name, email, role) values ('Bad', 'bad@example.test', 'owner')`),
        ),
      };
    },
  },
  {
    id: "column-type-round-trip",
    run: async (db) => {
      const returned = await db.insert(schema.columnTypes).values(columnTypesRow).returning();
      const selected = await db.select().from(schema.columnTypes);
      const raw = (await db.execute<CorpusRow>(sql`select * from ${schema.columnTypes}`)).rows;
      const nulls = await rolledBack(db, async (tx) => tx.insert(schema.columnTypes).values({ id: 2 }).returning());

      return { returned, selected, raw, nulls };
    },
  },
  {
    id: "vectors-and-distances",
    run: async (db) => {
      await db.insert(schema.vectors).values([
        { id: 1, embedding: [1, 2, 3], half: [1, 2, 3], sparse: "{1:1,3:2}/5", bits: "1010" },
        { id: 2, embedding: [3, 2, 1], half: [0.5, 0.5, 0.5], sparse: "{2:4}/5", bits: "0110" },
      ]);
      const target = [1, 1, 1];

      return {
        rows: await db.select().from(schema.vectors).orderBy(schema.vectors.id),
        distances: await db
          .select({
            id: schema.vectors.id,
            l2: orm.l2Distance(schema.vectors.embedding, target),
            l1: orm.l1Distance(schema.vectors.embedding, target),
            inner: orm.innerProduct(schema.vectors.embedding, target),
            cosine: orm.cosineDistance(schema.vectors.embedding, target),
            hamming: orm.hammingDistance(schema.vectors.bits, "1001"),
            jaccard: orm.jaccardDistance(schema.vectors.bits, "1001"),
          })
          .from(schema.vectors)
          .orderBy(schema.vectors.id),
        nearest: await db
          .select({ id: schema.vectors.id })
          .from(schema.vectors)
          .orderBy(orm.l2Distance(schema.vectors.embedding, [3, 2, 1]))
          .limit(1),
      };
    },
  },
  {
    id: "identity-generated-and-hooks",
    run: async (db) => {
      const identities = await db
        .insert(schema.identities)
        .values([{ note: "first" }, { note: "second", byDefault: 99 }])
        .returning();
      const overriding = await db
        .insert(schema.identities)
        .overridingSystemValue()
        .values({ always: 1, note: "override" })
        .returning();
      const generatedRows = await db
        .insert(schema.generated)
        .values({ id: 1, firstName: "Ada", lastName: "Lovelace" })
        .returning();
      const inserted = await db
        .insert(schema.hooks)
        .values([{ id: 1 }, { id: 2, slug: "explicit", counter: 1 }])
        .returning();
      const updated = await db
        .update(schema.hooks)
        .set({ slug: "changed" })
        .where(orm.eq(schema.hooks.id, 1))
        .returning();
      const identityRejected = await captureError(() =>
        db.execute(sql`insert into ${schema.identities} (always, note) values (2, 'rejected')`),
      );

      return { identities, overriding, generatedRows, inserted, updated, identityRejected };
    },
  },
  {
    id: "database-defaults",
    run: async (db) => {
      const { databaseDefaults } = schema;

      return rolledBack(db, (tx) =>
        tx
          .insert(databaseDefaults)
          .values({ id: 1 })
          .returning({
            id: databaseDefaults.id,
            createdAtIsTransactionTime: sql<boolean>`${databaseDefaults.createdAt} = now()`,
            tokenVersion: sql<string>`substring(${databaseDefaults.token}::text, 15, 1)`,
          }),
      );
    },
  },
  {
    id: "constraints",
    run: async (db) => {
      await db.insert(schema.constrained).values({ id: 1, code: "Alpha", region: "eu", quantity: 1 });

      return {
        compositeUnique: await captureError(() =>
          db.insert(schema.constrained).values({ id: 2, code: "Alpha", region: "eu", quantity: 2 }),
        ),
        expressionUnique: await captureError(() =>
          db.insert(schema.constrained).values({ id: 3, code: "ALPHA", region: "us", quantity: 2 }),
        ),
        allowed: await db
          .insert(schema.constrained)
          .values({ id: 4, code: "Beta", region: "eu", quantity: 0 })
          .returning({ id: schema.constrained.id }),
        selfReferenceCascade: await rolledBack(db, async (tx) => {
          await tx.delete(categories).where(orm.eq(categories.id, 1));
          return tx.select().from(categories);
        }),
      };
    },
  },
  {
    id: "replicas",
    run: async (db) => {
      const replicated = pg.withReplicas(db, [db], (replicas) => replicas[0]);

      return {
        fromReplica: await replicated.select({ id: users.id }).from(users).orderBy(users.id),
        fromPrimary: await replicated.$primary.select({ id: groups.id }).from(groups).orderBy(groups.id),
        relational: await replicated.query.groups.findMany({ orderBy: { id: "asc" } }),
        writeGoesToPrimary: await rolledBack(db, async (tx) =>
          tx.insert(groups).values({ name: "Replica write" }).returning({ name: groups.name }),
        ),
      };
    },
  },
  {
    id: "table-metadata",
    run: async () => {
      const config = pg.getTableConfig(schema.constrained);
      const usersConfig = pg.getTableConfig(users);
      const securedConfig = pg.getTableConfig(schema.secured);

      return {
        tableName: orm.getTableName(users),
        tableSchema: [orm.getTableSchema(schema.scopedItems) ?? null, orm.getTableSchema(users) ?? null],
        uniqueName: orm.getTableUniqueName(schema.scopedItems),
        constrained: {
          name: config.name,
          columns: config.columns.map((column) => [column.name, column.getSQLType(), column.notNull]),
          checks: config.checks.map((check) => check.name),
          indexes: config.indexes.map((index) => index.config.name),
          uniqueConstraints: config.uniqueConstraints.map((constraint) => constraint.getName()),
        },
        users: {
          primaryKeys: usersConfig.columns.filter((column) => column.primary).map((column) => column.name),
          foreignKeys: pg.getTableConfig(posts).foreignKeys.map((foreignKey) => foreignKey.getName()),
          compositePrimaryKeys: pg.getTableConfig(usersToGroups).primaryKeys.map((primaryKey) => primaryKey.getName()),
          tableForeignKeys: pg
            .getTableConfig(categories)
            .foreignKeys.map((foreignKey) => foreignKey.reference().columns.map((column) => column.name)),
        },
        secured: { enableRLS: securedConfig.enableRLS, policies: securedConfig.policies.map((policy) => policy.name) },
        scope: pg.getTableConfig(schema.scopedItems).schema,
        uniqueKeyName: pg.uniqueKeyName(users, ["email"]),
        usedTables: usedTablesOf(users),
        columnTable: orm.getTableName(orm.getColumnTable(posts.title)),
        extended: orm.extractExtendedColumnType(users.tags),
        withEnum: [orm.isWithEnum(users.role), orm.isWithEnum(users.name)],
        decoderColumn: orm.getColumnFromDecoder(sql`${users.name}`.mapWith(users.name))?.name ?? null,
        sameKeys: [orm.haveSameKeys({ a: 1 }, { a: 2 }), orm.haveSameKeys({ a: 1 }, { b: 1 })],
        isConfig: [orm.isConfig({ logger: true }), orm.isConfig({ connectionString: "postgres://" })],
        base64: Array.from(orm.base64ToUint8Array("AQL/")),
      };
    },
  },
  {
    id: "entity-checks",
    run: async () => {
      return {
        isTable: [orm.isTable(users), orm.isTable(schema.publishedPosts)],
        isTableAlias: [orm.isTableAlias(pg.alias(users, "author")), orm.isTableAlias(users)],
        isView: [orm.isView(schema.publishedPosts), orm.isView(users)],
        is: [orm.is(users, pg.PgTable), orm.is(users.id, orm.Column), orm.is(sql``, orm.SQL), orm.is(users, orm.SQL)],
        isPgEnum: [pg.isPgEnum(schema.role), pg.isPgEnum(users)],
        isPgSchema: [pg.isPgSchema(schema.corpusSchema), pg.isPgSchema(users)],
        isPgSequence: [pg.isPgSequence(schema.counter), pg.isPgSequence(users)],
        isPgView: [pg.isPgView(schema.publishedPosts), pg.isPgView(schema.postStats)],
        isPgMaterializedView: [
          pg.isPgMaterializedView(schema.postStats),
          pg.isPgMaterializedView(schema.publishedPosts),
        ],
        isNoop: [orm.isNoop(orm.noopDecoder.mapFromDriverValue) ?? false, orm.isNoop(Number) ?? false],
        unreachable: await captureError(async () => orm.assertUnreachable(undefined)),
        operators: Object.keys(orm.operators).toSorted(),
        orderByOperators: Object.keys(orm.getOrderByOperators()).toSorted(),
      };
    },
  },
  {
    id: "postgres-array-helpers",
    run: async () => {
      return {
        make: pg.makePgArray(["a", "b,c", null, 'd"e']),
        makeNested: pg.makePgArray([
          [1, 2],
          [3, 4],
        ]),
        parse: pg.parsePgArray('{a,"b,c",NULL}'),
        parseNested: pg.parsePgNestedArray("{{1,2},{3,4}}", 0),
      };
    },
  },
  {
    id: "unsupported-engine-types-to-sql",
    run: async (db) => {
      const places = pg.pgTable("corpus_places", {
        id: pg.integer().primaryKey(),
        location: pg.geometry({ type: "point", mode: "xy", srid: 4326 }),
        tupleLocation: pg.geometry({ type: "point" }),
      });

      return {
        insert: db
          .insert(places)
          .values({ id: 1, location: { x: 1, y: 2 }, tupleLocation: [3, 4] })
          .toSQL(),
        select: db.select().from(places).toSQL(),
      };
    },
  },
  {
    id: "relations-definition-parts",
    run: async () => {
      const part = orm.defineRelationsPart({ users, posts }, (r) => ({
        posts: { writer: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
      }));

      return {
        partTables: Object.keys(part).toSorted(),
        relationTables: Object.keys(schema.relations).toSorted(),
        userRelations: Object.keys(schema.relations.users.relations).toSorted(),
      };
    },
  },
];
