import { describe, expect, it } from "vitest";

import {
  confirmsIndex,
  drizzleIndexLine,
  INDEX_IMPROVEMENT_FACTOR,
  indexName,
  SQLITE_TIMING_FLOOR_MS,
} from "./rules.ts";

describe("confirmsIndex", () => {
  it("should keep an index the database used when the cost drops tenfold", () => {
    expect(confirmsIndex({ used: true, unit: "cost", before: 1986, after: 8.47 })).toBe(true);
    expect(confirmsIndex({ used: true, unit: "cost", before: 100, after: 100 / INDEX_IMPROVEMENT_FACTOR })).toBe(true);
  });

  it("should drop an index that helps less than tenfold", () => {
    expect(confirmsIndex({ used: true, unit: "cost", before: 2186, after: 500 })).toBe(false);
    expect(confirmsIndex({ used: true, unit: "ms", before: 9, after: 1 })).toBe(false);
  });

  it("should drop an index the database did not use, however the measure moved", () => {
    expect(confirmsIndex({ used: false, unit: "cost", before: 1986, after: 1 })).toBe(false);
  });

  it("should ignore SQLite times too small to rise above timer noise", () => {
    expect(confirmsIndex({ used: true, unit: "ms", before: SQLITE_TIMING_FLOOR_MS / 2, after: 0.001 })).toBe(false);
    expect(confirmsIndex({ used: true, unit: "ms", before: 2.06, after: 0.009 })).toBe(true);
  });

  it("should refuse measures that are not real numbers", () => {
    expect(confirmsIndex({ used: true, unit: "cost", before: Number.NaN, after: 1 })).toBe(false);
    expect(confirmsIndex({ used: true, unit: "cost", before: 0, after: 0 })).toBe(false);
  });
});

describe("indexName", () => {
  it("should name an index after its table and columns, without the _id suffix", () => {
    expect(indexName("posts", ["author_id"], new Set())).toBe("posts_author_idx");
    expect(indexName("posts", ["created_at"], new Set())).toBe("posts_created_at_idx");
    expect(indexName("comments", ["post_id", "created_at"], new Set())).toBe("comments_post_created_at_idx");
  });

  it("should never reuse a name the database already has", () => {
    expect(indexName("posts", ["author_id"], new Set(["posts_author_idx"]))).toBe("posts_author_2_idx");
  });
});

describe("drizzleIndexLine", () => {
  it("should write the Drizzle line with the table's property names", () => {
    expect(drizzleIndexLine("posts_author_idx", ["author_id"], { author_id: "authorId" })).toBe(
      `index("posts_author_idx").on(t.authorId)`,
    );
    expect(drizzleIndexLine("posts_author_idx", ["author_id"], { author_id: "writer" })).toBe(
      `index("posts_author_idx").on(t.writer)`,
    );
    expect(drizzleIndexLine("posts_author_idx", ["author_id"], undefined)).toBe(
      `index("posts_author_idx").on(t.authorId)`,
    );
    expect(drizzleIndexLine("a_idx", ["a", "b"], { a: "my-key", b: "b" })).toBe(`index("a_idx").on(t["my-key"], t.b)`);
  });
});
