import type { SQL } from "drizzle-orm";
import { describe, expect, expectTypeOf, it } from "vitest";

import { jsonbAggregate, jsonbBuildObject } from "../../examples/typed-json-aggregation-postgresql/files/helpers";
import { comments as pgComments } from "../../examples/typed-json-aggregation-postgresql/files/schema";
import { jsonAggregate, jsonObject } from "../../examples/typed-json-aggregation-sqlite/files/helpers";
import { comments as sqliteComments } from "../../examples/typed-json-aggregation-sqlite/files/schema";
import {
  getJsonText as pgText,
  hasJsonArrayValue as pgArray,
} from "../../examples/typed-json-filters-postgresql/files/helpers";
import { products as pgProducts } from "../../examples/typed-json-filters-postgresql/files/schema";
import {
  getJsonText as sqliteText,
  hasJsonArrayValue as sqliteArray,
} from "../../examples/typed-json-filters-sqlite/files/helpers";
import { products as sqliteProducts } from "../../examples/typed-json-filters-sqlite/files/schema";
import type { coalesceNumber as pgCoalesce } from "../../examples/typed-scalar-helpers-postgresql/files/helpers";
import type { coalesceNumber as sqliteCoalesce } from "../../examples/typed-scalar-helpers-sqlite/files/helpers";

describe("advanced recipe types", () => {
  it("should infer arrays of nullable child fields in both dialects", () => {
    const pg = jsonbAggregate({
      value: jsonbBuildObject({ id: pgComments.id, text: pgComments.text }),
      orderBy: pgComments.id,
      present: pgComments.id,
    });
    const sqlite = jsonAggregate({
      value: jsonObject({ id: sqliteComments.id, text: sqliteComments.text }),
      orderBy: sqliteComments.id,
      present: sqliteComments.id,
    });

    expectTypeOf(pg).toEqualTypeOf<SQL<{ id: number; text: string | null }[]>>();
    expectTypeOf(sqlite).toEqualTypeOf<SQL<{ id: number; text: string | null }[]>>();
    expect(pg.getSQL()).toBeDefined();
    expect(sqlite.getSQL()).toBeDefined();
  });

  it("should restrict JSON keys by the declared field kind", () => {
    expectTypeOf<Parameters<typeof pgText<typeof pgProducts.attributes>>[1]>().toEqualTypeOf<"color">();
    expectTypeOf<Parameters<typeof sqliteText<typeof sqliteProducts.attributes>>[1]>().toEqualTypeOf<"color">();
    expectTypeOf<Parameters<typeof pgArray<typeof pgProducts.attributes>>[1]>().toEqualTypeOf<"sizes">();
    expectTypeOf<Parameters<typeof sqliteArray<typeof sqliteProducts.attributes>>[1]>().toEqualTypeOf<"sizes">();
    expectTypeOf(pgText(pgProducts.attributes, "color")).toEqualTypeOf<SQL<string | null>>();
    expectTypeOf(sqliteText(sqliteProducts.attributes, "color")).toEqualTypeOf<SQL<string | null>>();
    expectTypeOf(pgArray(pgProducts.attributes, "sizes", "M")).toEqualTypeOf<SQL<boolean>>();
    expectTypeOf(sqliteArray(sqliteProducts.attributes, "sizes", "M")).toEqualTypeOf<SQL<boolean>>();
  });

  it("should give numeric fallback helpers a non-null numeric result", () => {
    expectTypeOf<ReturnType<typeof pgCoalesce>>().toEqualTypeOf<SQL<number>>();
    expectTypeOf<ReturnType<typeof sqliteCoalesce>>().toEqualTypeOf<SQL<number>>();
  });
});
