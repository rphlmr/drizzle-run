import { describe, expect, it } from "vitest";
import * as z from "zod/mini";

import { ProjectSourceSchema } from "./project-source.ts";

const VERSION_ID = "ee9bf870-ca60-4975-a7e3-f9e12000cb40";

describe("ProjectSourceSchema", () => {
  it("should read an example or a guide version by its id", () => {
    expect(z.parse(ProjectSourceSchema, { kind: "example", id: VERSION_ID })).toEqual({
      kind: "example",
      id: VERSION_ID,
    });
    expect(z.parse(ProjectSourceSchema, { kind: "guide", id: VERSION_ID })).toEqual({ kind: "guide", id: VERSION_ID });
  });

  it("should drop unknown fields", () => {
    expect(z.parse(ProjectSourceSchema, { kind: "guide", id: VERSION_ID, title: "Transactions" })).toEqual({
      kind: "guide",
      id: VERSION_ID,
    });
  });

  it("should refuse another kind, a slug or an uppercase id", () => {
    expect(z.safeParse(ProjectSourceSchema, { kind: "community", id: VERSION_ID }).success).toBe(false);
    expect(z.safeParse(ProjectSourceSchema, { kind: "example", id: "transactions" }).success).toBe(false);
    expect(z.safeParse(ProjectSourceSchema, { kind: "example", id: VERSION_ID.toUpperCase() }).success).toBe(false);
    expect(z.safeParse(ProjectSourceSchema, { kind: "example" }).success).toBe(false);
  });
});
