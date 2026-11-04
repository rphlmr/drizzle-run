import { type SQL, eq, sql } from "drizzle-orm";
import { PgDialect, bigint, numeric, pgTable, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, expectTypeOf, it } from "vitest";

import { jsonbBuildObject } from "../../examples/reusable-helpers/files/helpers";
import { posts, users } from "../../examples/reusable-helpers/files/schema";

describe("reusable JSONB helper", () => {
  it("should preserve nested keys, computed fields and nullable columns in selections and aliases", () => {
    const author = jsonbBuildObject({ displayName: users.name, bio: users.bio, active: users.active });
    const card = jsonbBuildObject({ id: posts.id, titleLength: sql<number>`length(${posts.title})`, author });
    const db = drizzle(async () => ({ rows: [] }));
    const cards = db
      .select({ card: card.as("card") })
      .from(posts)
      .innerJoin(users, eq(posts.authorId, users.id))
      .as("cards");
    const query = db.select({ card: cards.card }).from(cards);

    expectTypeOf<Awaited<typeof query>>().toEqualTypeOf<
      {
        card: { id: number; titleLength: number; author: { displayName: string; bio: string | null; active: boolean } };
      }[]
    >();
    expect(query.toSQL().sql).toMatch(/^select "card" from \(select jsonb_build_object\(/);
  });

  it("should bind JSON keys as text parameters without interpolating them into SQL", () => {
    const expression = jsonbBuildObject({ "author's name'); select 1; --": users.name, bio: users.bio });
    const query = new PgDialect().sqlToQuery(expression);

    expect(query).toMatchObject({
      sql: 'jsonb_build_object($1::text, "users"."name", $2::text, "users"."bio")',
      params: ["author's name'); select 1; --", "bio"],
    });
  });

  it("should build an empty object without losing its result type", () => {
    const expression = jsonbBuildObject({});

    expectTypeOf(expression).toEqualTypeOf<SQL<{}>>();
    expect(new PgDialect().sqlToQuery(expression)).toMatchObject({ sql: "jsonb_build_object()", params: [] });
  });

  it("should exclude column types whose decoded values differ from their JSON representation", () => {
    const conversions = pgTable("conversions", {
      createdAt: timestamp("created_at").notNull(),
      amount: numeric("amount").notNull(),
      largeId: bigint("large_id", { mode: "bigint" }).notNull(),
    });
    type JsonField = Parameters<typeof jsonbBuildObject>[0][string];

    expectTypeOf<typeof conversions.createdAt>().not.toExtend<JsonField>();
    expectTypeOf<typeof conversions.amount>().not.toExtend<JsonField>();
    expectTypeOf<typeof conversions.largeId>().not.toExtend<JsonField>();
  });
});
