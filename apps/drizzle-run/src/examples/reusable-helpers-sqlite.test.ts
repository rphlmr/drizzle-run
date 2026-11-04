import { DatabaseSync } from "node:sqlite";

import { type SQL, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { SQLiteDialect, blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { jsonObject } from "../../examples/reusable-helpers-sqlite/files/helpers";
import { posts, users } from "../../examples/reusable-helpers-sqlite/files/schema";

describe("reusable SQLite JSON helper", () => {
  let client: DatabaseSync;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    client = new DatabaseSync(":memory:");
    db = drizzle({ client });
    client.exec(`
      create table users (id integer primary key, name text not null, bio text, active integer not null);
      create table posts (id integer primary key, author_id integer not null references users(id), title text not null);
    `);
    await db.insert(users).values([
      { id: 1, name: "Ada", bio: "Writes about SQL", active: true },
      { id: 2, name: "Grace", bio: null, active: false },
    ]);
    await db.insert(posts).values([{ id: 1, authorId: 2, title: "SQL" }]);
  });

  afterEach(() => client.close());

  it("should infer and decode nested objects, computed fields, nulls and booleans", async () => {
    const author = jsonObject({ displayName: users.name, bio: users.bio, active: users.active });
    const query = db
      .select({
        card: jsonObject({ id: posts.id, titleLength: sql<number>`length(${posts.title})`, author }),
      })
      .from(posts)
      .innerJoin(users, eq(posts.authorId, users.id));

    expectTypeOf<Awaited<typeof query>>().toEqualTypeOf<
      {
        card: { id: number; titleLength: number; author: { displayName: string; bio: string | null; active: boolean } };
      }[]
    >();
    expect(await query).toEqual([
      { card: { id: 1, titleLength: 3, author: { displayName: "Grace", bio: null, active: false } } },
    ]);
    expect(await db.select({ profile: author }).from(users).orderBy(users.id)).toEqual([
      { profile: { displayName: "Ada", bio: "Writes about SQL", active: true } },
      { profile: { displayName: "Grace", bio: null, active: false } },
    ]);
  });

  it("should preserve boolean nullability inside JSON", async () => {
    const flags = sqliteTable("flags", { enabled: integer("enabled", { mode: "boolean" }) });
    client.exec("create table flags (enabled integer); insert into flags values (null), (0), (1);");
    const query = db.select({ flag: jsonObject({ enabled: flags.enabled }) }).from(flags);

    expectTypeOf<Awaited<typeof query>>().toEqualTypeOf<{ flag: { enabled: boolean | null } }[]>();
    expect(await query).toEqual([
      { flag: { enabled: null } },
      { flag: { enabled: false } },
      { flag: { enabled: true } },
    ]);
  });

  it("should retain the decoder and inferred type through a subquery alias", async () => {
    const profiles = db
      .select({ profile: jsonObject({ name: users.name }).as("profile") })
      .from(users)
      .as("profiles");
    const query = db.select({ profile: profiles.profile }).from(profiles);

    expectTypeOf<Awaited<typeof query>>().toEqualTypeOf<{ profile: { name: string } }[]>();
    expect(await query).toEqual([{ profile: { name: "Ada" } }, { profile: { name: "Grace" } }]);
  });

  it("should bind quoted JSON keys and decode an empty object", async () => {
    const expression = jsonObject({ "author's name'); select 1; --": users.name });

    expect(new SQLiteDialect().sqlToQuery(expression)).toMatchObject({
      sql: 'json_object(?, "users"."name")',
      params: ["author's name'); select 1; --"],
    });
    expect(await db.select({ profile: expression }).from(users).where(eq(users.id, 1))).toEqual([
      { profile: { "author's name'); select 1; --": "Ada" } },
    ]);
    expectTypeOf(jsonObject({})).toEqualTypeOf<SQL<{}>>();
    expect(
      await db
        .select({ empty: jsonObject({}) })
        .from(users)
        .where(eq(users.id, 1)),
    ).toEqual([{ empty: {} }]);
  });

  it("should exclude date, JSON text and blob columns that need another representation", () => {
    const conversions = sqliteTable("conversions", {
      createdAt: integer("created_at", { mode: "timestamp_ms" }),
      payload: text("payload", { mode: "json" }).$type<{ title: string }>(),
      binary: blob("binary", { mode: "buffer" }),
    });
    type JsonField = Parameters<typeof jsonObject>[0][string];

    expectTypeOf<typeof conversions.createdAt>().not.toExtend<JsonField>();
    expectTypeOf<typeof conversions.payload>().not.toExtend<JsonField>();
    expectTypeOf<typeof conversions.binary>().not.toExtend<JsonField>();
  });
});
