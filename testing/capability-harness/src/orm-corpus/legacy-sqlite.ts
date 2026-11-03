import * as orm from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as sqlite from "drizzle-orm/sqlite-core";

import * as schema from "./legacy-sqlite.schema.ts";
import { describeError, runRolledBack } from "./run-cases.ts";
import type { OrmCase } from "./types.ts";

type Database = LibSQLDatabase<typeof schema>;
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

const toIds = (rows: { id: number }[]) => rows.map((row) => row.id);

const toSortedIds = (rows: { id: number }[]) => rows.map((row) => row.id).toSorted((left, right) => left - right);

/** The SQLite ORM scenarios for drizzle-orm 0.45.4, run in order against one database. */
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
            profile: { city: "London", languages: ["en"] },
          },
          {
            name: "Grace",
            email: "grace@example.test",
            role: "writer",
            age: 45,
            profile: { city: "Arlington", languages: ["en", "cobol"] },
          },
          { name: "Linus", email: "linus@example.test", age: 17 },
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
      const columns = await db.select(orm.getTableColumns(groups)).from(groups).orderBy(groups.id);

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
          literal: sql<number>`1 + 1`,
        })
        .from(users)
        .orderBy(users.id);
    },
  },
  {
    id: "select-distinct",
    run: async (db) => {
      return db.selectDistinct({ role: users.role }).from(users).orderBy(users.role);
    },
  },
  {
    id: "query-execution-modes",
    run: async (db) => {
      const query = db.select({ id: users.id, name: users.name }).from(users).orderBy(users.id);

      return {
        all: await query.all(),
        get: await query.get(),
        values: await query.values(),
        rawAll: await db.all(sql`select id, name from ${users} order by id`),
        rawGet: await db.get(sql`select count(*) as total from ${users}`),
        rawValues: await db.values(sql`select id from ${users} order by id`),
        rawRun: await rolledBack(db, async (tx) => {
          const result = await tx.run(sql`update ${users} set age = age where id <= 2`);
          return { rowsAffected: result.rowsAffected };
        }),
      };
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
        exists: await ids(orm.exists(authored)),
        notExists: await ids(orm.notExists(authored)),
      };
    },
  },
  {
    id: "postgres-only-operators-to-sql",
    run: async (db) => {
      const where = (condition: orm.SQL) => db.select({ id: users.id }).from(users).where(condition).toSQL();
      const embedding = sql`${users.profile}`;

      return {
        ilike: where(orm.ilike(users.name, "a%")),
        notIlike: where(orm.notIlike(users.name, "a%")),
        arrayContains: where(orm.arrayContains(sql`tags`, ["en"])),
        arrayContained: where(orm.arrayContained(sql`tags`, ["en"])),
        arrayOverlaps: where(orm.arrayOverlaps(sql`tags`, ["en"])),
        distances: db
          .select({
            l2: orm.l2Distance(embedding, [1, 2]),
            l1: orm.l1Distance(embedding, [1, 2]),
            inner: orm.innerProduct(embedding, [1, 2]),
            cosine: orm.cosineDistance(embedding, [1, 2]),
            hamming: orm.hammingDistance(embedding, "10"),
            jaccard: orm.jaccardDistance(embedding, "10"),
          })
          .from(users)
          .toSQL(),
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
    id: "aliases-and-self-joins",
    run: async (db) => {
      const parent = sqlite.alias(categories, "parent");
      const tree = await db
        .select({ child: categories.name, parent: parent.name })
        .from(categories)
        .leftJoin(parent, orm.eq(categories.parentId, parent.id))
        .orderBy(categories.id);
      const aliased = orm.aliasedTable(users, "aliased_users");
      const aliasedName = orm.aliasedTableColumn(users.name, "aliased_users");
      const fromAliased = await db.select({ name: aliasedName }).from(aliased).orderBy(aliasedName);

      return { tree, fromAliased };
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
        .as(sql`select 1 as value union all select 2 union all select 3`);
      const fromRawCte = await db.with(raw).select().from(raw);
      const withUpdate = await rolledBack(db, async (tx) => {
        const target = tx
          .$with("target")
          .as(tx.select({ id: posts.id }).from(posts).where(orm.eq(posts.published, false)));

        return tx
          .with(target)
          .update(posts)
          .set({ views: 1 })
          .where(orm.inArray(posts.id, tx.select({ id: target.id }).from(target)))
          .returning({ id: posts.id, views: posts.views });
      });
      const withDelete = await rolledBack(db, async (tx) => {
        const anonymous = tx
          .$with("anonymous")
          .as(tx.select({ id: comments.id }).from(comments).where(orm.isNull(comments.authorId)));

        return tx
          .with(anonymous)
          .delete(comments)
          .where(orm.inArray(comments.id, tx.select({ id: anonymous.id }).from(anonymous)))
          .returning({ id: comments.id });
      });

      return { fromCte, fromRawCte, withUpdate, withDelete };
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
        union: toSortedIds(await sqlite.union(authors(), commenters())),
        unionAll: toSortedIds(await sqlite.unionAll(authors(), commenters())),
        intersect: toSortedIds(await sqlite.intersect(authors(), commenters())),
        except: toSortedIds(await sqlite.except(authors(), commenters())),
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
      };
    },
  },
  {
    id: "dynamic-query-building",
    run: async (db) => {
      const withFilters = <TQuery extends sqlite.SQLiteSelect>(query: TQuery, role?: "writer" | "admin") =>
        role === undefined ? query : query.where(orm.eq(users.role, role));

      return {
        all: await withFilters(db.select({ id: users.id }).from(users).$dynamic()).orderBy(users.id),
        writers: await withFilters(db.select({ id: users.id }).from(users).$dynamic(), "writer").orderBy(users.id),
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
        .prepare();
      const byRole = db
        .select({ id: users.id })
        .from(users)
        .where(orm.eq(users.role, orm.placeholder("role")))
        .orderBy(users.id)
        .limit(sql.placeholder("limit"))
        .prepare();
      const inserted = await rolledBack(db, async (tx) =>
        tx
          .insert(groups)
          .values({ name: sql.placeholder("name") })
          .returning({ name: groups.name })
          .prepare()
          .all({ name: "Prepared" }),
      );

      return {
        first: await byId.all({ id: 1 }),
        firstGet: await byId.get({ id: 1 }),
        second: await byId.execute({ id: 2 }),
        values: await byId.values({ id: 2 }),
        writers: await byRole.all({ role: "writer", limit: 1 }),
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
      const dialect = new sqlite.SQLiteAsyncDialect();

      return {
        joined: await db.all(query),
        identifiers: await db.all(identifiers),
        raw: await db.all(sql.raw("select 3 as three")),
        fromList: await db.all(sql.fromList([sql`select `, sql.param(4), sql` as four`])),
        appended: await db.all(sql`select 5`.append(sql` as five`)),
        typed: await db.all<{ total: number }>(sql`select count(*) as total from ${users}`),
        inlined: dialect.sqlToQuery(sql`select ${"it's"}, ${10}`.inlineParams()),
        rendered: dialect.sqlToQuery(query),
        isWrapper: [orm.isSQLWrapper(query), orm.isSQLWrapper(users), orm.isSQLWrapper("text")],
        bound: dialect.sqlToQuery(sql`${orm.bindIfParam(5, users.age)}`),
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
        updateLimit: db.update(users).set({ age: 1 }).orderBy(users.id).limit(1).toSQL(),
        deleteLimit: db.delete(users).where(orm.eq(users.id, 1)).orderBy(users.id).limit(1).toSQL(),
        relational: db.query.users.findMany({ with: { posts: true }, limit: 1 }).toSQL(),
        embedded: await db.get<{ total: number }>(
          sql`select count(*) as total from (${db.select({ id: users.id }).from(users).getSQL()})`,
        ),
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

        return { single, many, rowsAffected: noReturning.rowsAffected, fromSelect, fromCallback, sqlValue };
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
          .returning({ id: posts.id, title: posts.title });
        const noMatch = await tx.update(users).set({ age: 1 }).where(orm.eq(users.id, -1)).returning();
        const unconditional = await tx.update(posts).set({ published: false });

        return { set, expression, fromJoin, noMatch, rowsAffected: unconditional.rowsAffected };
      });
    },
  },
  {
    id: "delete-variants",
    run: async (db) => {
      return rolledBack(db, async (tx) => {
        const returned = await tx.delete(comments).where(orm.eq(comments.postId, 3)).returning({ body: comments.body });
        const removed = await tx.delete(users).where(orm.eq(users.id, 3)).returning({ id: users.id });
        const everything = await tx.delete(usersToGroups);

        return { returned, removed, rowsAffected: everything.rowsAffected };
      });
    },
  },
  {
    id: "batch",
    run: async (db) => {
      const committed = await db.batch([
        db.insert(groups).values({ name: "Batched" }).returning({ id: groups.id }),
        db.select({ name: groups.name }).from(groups).orderBy(groups.id),
        db.update(groups).set({ name: "Batched twice" }).where(orm.eq(groups.name, "Batched")),
        db.query.groups.findFirst({ where: (table, { eq }) => eq(table.name, "Batched twice") }),
        db.delete(groups).where(orm.eq(groups.name, "Batched twice")).returning({ name: groups.name }),
      ]);
      const failed = await captureError(() =>
        db.batch([
          db.insert(groups).values({ name: "Atomic" }),
          db.run(sql.raw("insert into missing_table values (1)")),
        ]),
      );
      const atomic = await db.select().from(groups).where(orm.eq(groups.name, "Atomic"));

      return {
        returned: committed[0],
        selected: committed[1],
        updated: committed[2].rowsAffected,
        relational: committed[3],
        deleted: committed[4],
        failed,
        atomic,
      };
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
        { behavior: "immediate" },
      );
      const explicitRollback = await captureError(() =>
        db.transaction(
          async (tx) => {
            await tx.insert(groups).values({ name: "Never committed" });
            tx.rollback();
          },
          { behavior: "deferred" },
        ),
      );
      const thrown = await captureError(() =>
        db.transaction(
          async (tx) => {
            await tx.insert(groups).values({ name: "Thrown away" });
            throw new orm.DrizzleError({ message: "corpus failure" });
          },
          { behavior: "exclusive" },
        ),
      );
      const names = await db.select({ name: groups.name }).from(groups).orderBy(groups.id);
      await db.delete(groups).where(orm.inArray(groups.name, ["Committed", "Savepoint kept"]));

      return { committed, explicitRollback, thrown, names };
    },
  },
  {
    id: "database-errors",
    run: async (db) => {
      return {
        unique: await captureError(() => db.insert(users).values({ name: "Copy", email: "ada@example.test" })),
        check: await captureError(() =>
          db.insert(schema.constrained).values({ id: 1, code: "a", region: "eu", quantity: -1 }),
        ),
        notNull: await captureError(() => db.run(sql`insert into ${users} (name) values ('No email')`)),
        syntax: await captureError(() => db.run(sql.raw("select from where"))),
      };
    },
  },
  {
    id: "relational-find-many",
    run: async (db) => {
      return {
        all: await db.query.users.findMany({ orderBy: (table, { asc }) => [asc(table.id)] }),
        columns: await db.query.users.findMany({
          columns: { id: true, name: true },
          orderBy: (table, { desc }) => [desc(table.id)],
        }),
        excluded: await db.query.users.findMany({
          columns: { profile: false, joinedAt: false },
          limit: 2,
          offset: 1,
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
        nested: await db.query.users.findMany({
          columns: { name: true },
          with: {
            posts: {
              columns: { title: true },
              orderBy: (table, { asc }) => [asc(table.id)],
              with: { comments: { columns: { body: true }, orderBy: (table, { asc }) => [asc(table.id)] } },
            },
          },
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
        manyToMany: await db.query.users.findMany({
          columns: { name: true },
          with: {
            usersToGroups: {
              columns: {},
              with: { group: { columns: { name: true } } },
              orderBy: (table, { asc }) => [asc(table.groupId)],
            },
          },
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
        reverseManyToMany: await db.query.groups.findMany({
          with: {
            usersToGroups: {
              columns: {},
              with: { user: { columns: { name: true } } },
              orderBy: (table, { asc }) => [asc(table.userId)],
            },
          },
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
        selfReference: await db.query.categories.findMany({
          with: { parent: true, children: true },
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
        extras: await db.query.users.findMany({
          columns: { id: true },
          extras: (table, { sql: relationalSql }) => ({
            lowerName: relationalSql<string>`lower(${table.name})`.as("lower_name"),
          }),
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
        staticExtras: await db.query.users.findMany({
          columns: { id: true },
          extras: { upperName: sql<string>`upper(${users.name})`.as("upper_name") },
          orderBy: [orm.asc(users.id)],
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
      const byId = [orm.asc(users.id)];

      return {
        equals: toIds(
          await db.query.users.findMany({ where: (table, { eq }) => eq(table.role, "writer"), orderBy: byId }),
        ),
        operators: toIds(
          await db.query.users.findMany({
            where: (table, { and, gt, lte }) => and(gt(table.age, 17), lte(table.age, 45)),
            orderBy: byId,
          }),
        ),
        or: toIds(
          await db.query.users.findMany({
            where: (table, { or, eq, isNull }) => or(eq(table.role, "admin"), isNull(table.age)),
            orderBy: byId,
          }),
        ),
        not: toIds(
          await db.query.users.findMany({
            where: (table, { not, eq }) => not(eq(table.role, "writer")),
            orderBy: byId,
          }),
        ),
        inList: toIds(
          await db.query.users.findMany({ where: (table, { inArray }) => inArray(table.id, [2, 3]), orderBy: byId }),
        ),
        notInList: toIds(
          await db.query.users.findMany({
            where: (table, { notInArray }) => notInArray(table.id, [2, 3]),
            orderBy: byId,
          }),
        ),
        like: toIds(
          await db.query.users.findMany({ where: (table, { like }) => like(table.name, "%a%"), orderBy: byId }),
        ),
        relation: toIds(
          await db.query.users.findMany({
            where: (table, { exists, and, eq }) =>
              exists(
                db
                  .select({ id: posts.id })
                  .from(posts)
                  .where(and(eq(posts.authorId, table.id), eq(posts.published, false))),
              ),
            orderBy: byId,
          }),
        ),
        raw: toIds(await db.query.users.findMany({ where: sql`${users.id} % 2 = 0`, orderBy: byId })),
        nestedWhere: await db.query.users.findMany({
          columns: { id: true },
          with: { posts: { columns: { title: true }, where: (table, { gte }) => gte(table.views, 50) } },
          where: (table, { lte }) => lte(table.id, 2),
          orderBy: byId,
        }),
        operatorsHelper: Object.keys(orm.getOperators()).toSorted(),
      };
    },
  },
  {
    id: "relational-find-first-and-prepared",
    run: async (db) => {
      const prepared = db.query.users
        .findFirst({ where: (table, { eq }) => eq(table.id, sql.placeholder("id")), columns: { name: true } })
        .prepare();

      return {
        first: await db.query.users.findFirst({
          orderBy: (table, { desc }) => [desc(table.id)],
          with: { posts: true },
        }),
        missing: await db.query.users.findFirst({ where: (table, { eq }) => eq(table.id, -1) }),
        preparedFirst: await prepared.execute({ id: 2 }),
        preparedSecond: await prepared.execute({ id: 3 }),
        oneRequired: await db.query.posts.findFirst({
          where: (table, { eq }) => eq(table.id, 3),
          with: { author: { columns: { name: true } } },
        }),
        oneOptional: await db.query.comments.findMany({
          columns: { body: true },
          with: { author: { columns: { name: true } } },
          orderBy: (table, { asc }) => [asc(table.id)],
        }),
      };
    },
  },
  {
    id: "views",
    run: async (db) => {
      return {
        builderView: await db
          .select()
          .from(schema.publishedPosts)
          .where(orm.gt(schema.publishedPosts.id, 1))
          .orderBy(schema.publishedPosts.id),
        sqlView: await db.select().from(schema.adultUsers).orderBy(schema.adultUsers.id),
        name: orm.getViewName(schema.publishedPosts),
        selected: Object.keys(orm.getViewSelectedFields(schema.publishedPosts)),
        config: sqlite.getViewConfig(schema.publishedPosts).name,
        prefixed: await db.insert(schema.prefixed).values({ id: 1, name: "prefixed" }).returning(),
      };
    },
  },
  {
    id: "column-type-round-trip",
    run: async (db) => {
      const returned = await db
        .insert(schema.columnTypes)
        .values({
          id: 1,
          regular: 1_234,
          alias: -5,
          flag: true,
          seconds: new Date("2024-01-02T03:04:05.000Z"),
          milliseconds: new Date("2024-01-02T03:04:05.678Z"),
          realValue: Math.PI,
          numericString: "1234.50",
          numericNumber: 99.25,
          numericBigint: 9_007_199_254_740_993n,
          label: "two",
          shortText: "short",
          jsonText: { nested: { list: [1, "two", null] } },
          bytes: Buffer.from([0, 1, 127, 128, 255]),
          jsonBlob: { b: 2, a: 1 },
          bigBlob: 9_223_372_036_854_775_807n,
          custom: "MiXeD",
        })
        .returning();
      const selected = await db.select().from(schema.columnTypes);
      const raw = await db.all(
        sql`select id, regular, flag, seconds, milliseconds, numericString, jsonText, hex(bytes) as bytes from ${schema.columnTypes}`,
      );
      const nulls = await rolledBack(db, async (tx) => tx.insert(schema.columnTypes).values({ id: 2 }).returning());

      return { returned, selected, raw, nulls };
    },
  },
  {
    id: "generated-and-hooks",
    run: async (db) => {
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

      return { generatedRows, inserted, updated };
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
            createdAtIsPositive: sql<number>`${databaseDefaults.createdAt} > 0`,
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
      };
    },
  },
  {
    id: "replicas",
    run: async (db) => {
      const replicated = sqlite.withReplicas(db, [db], (replicas) => replicas[0]);

      return {
        fromReplica: await replicated.select({ id: users.id }).from(users).orderBy(users.id),
        fromPrimary: await replicated.$primary.select({ id: groups.id }).from(groups).orderBy(groups.id),
        relational: await replicated.query.groups.findMany({ orderBy: (table, { asc }) => [asc(table.id)] }),
      };
    },
  },
  {
    id: "table-metadata",
    run: async () => {
      const config = sqlite.getTableConfig(schema.constrained);

      return {
        tableName: orm.getTableName(users),
        uniqueName: orm.getTableUniqueName(users),
        constrained: {
          name: config.name,
          columns: config.columns.map((column) => [column.name, column.getSQLType(), column.notNull]),
          checks: config.checks.map((check) => check.name),
          indexes: config.indexes.map((index) => index.config.name),
          uniqueConstraints: config.uniqueConstraints.map((constraint) => constraint.getName()),
        },
        primaryKeys: sqlite
          .getTableConfig(users)
          .columns.filter((column) => column.primary)
          .map((column) => column.name),
        foreignKeys: sqlite.getTableConfig(posts).foreignKeys.map((foreignKey) => foreignKey.getName()),
        compositePrimaryKeys: sqlite
          .getTableConfig(usersToGroups)
          .primaryKeys.map((primaryKey) => primaryKey.getName()),
        tableForeignKeys: sqlite
          .getTableConfig(categories)
          .foreignKeys.map((foreignKey) => foreignKey.reference().columns.map((column) => column.name)),
        uniqueKeyName: sqlite.uniqueKeyName(users, ["email"]),
        usedTables: sqlite.extractUsedTable(users),
        sameKeys: [orm.haveSameKeys({ a: 1 }, { a: 2 }), orm.haveSameKeys({ a: 1 }, { b: 1 })],
        isConfig: [orm.isConfig({ logger: true }), orm.isConfig({ url: "file:corpus.db" })],
      };
    },
  },
  {
    id: "entity-checks",
    run: async () => {
      return {
        isTable: [orm.isTable(users), orm.isTable(schema.publishedPosts)],
        isView: [orm.isView(schema.publishedPosts), orm.isView(users)],
        is: [
          orm.is(users, sqlite.SQLiteTable),
          orm.is(users.id, orm.Column),
          orm.is(sql``, orm.SQL),
          orm.is(users, orm.SQL),
        ],
        orderByOperators: Object.keys(orm.getOrderByOperators()).toSorted(),
      };
    },
  },
  {
    id: "relations-definition",
    run: async () => {
      return {
        tables: [schema.usersRelations, schema.postsRelations, schema.categoriesRelations].map((relation) =>
          orm.getTableName(relation.table),
        ),
        userRelations: Object.keys(schema.usersRelations.config(orm.createTableRelationsHelpers(users))).toSorted(),
      };
    },
  },
];
