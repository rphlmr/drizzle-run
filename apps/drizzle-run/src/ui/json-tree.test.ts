import { serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import {
  getRelationHint,
  getSizeLabel,
  getTableColumns,
  getTableRows,
  NESTED_TABLE_DEPTH,
  toJsonLiteral,
} from "./json-tree";

describe("toJsonLiteral", () => {
  it("should write primitives the way JSON does", () => {
    expect(toJsonLiteral(serializeValue("Ada"))).toBe('"Ada"');
    expect(toJsonLiteral(serializeValue(7))).toBe("7");
    expect(toJsonLiteral(serializeValue(null))).toBe("null");
    expect(toJsonLiteral(serializeValue(true))).toBe("true");
    expect(toJsonLiteral(serializeValue(undefined))).toBe("undefined");
  });
});

describe("getSizeLabel", () => {
  it("should count an array's items and an object's fields", () => {
    expect(getSizeLabel({ type: "array", value: [serializeValue(1), serializeValue(2), serializeValue(3)] })).toBe(
      "3 items",
    );
    expect(getSizeLabel({ type: "array", value: [serializeValue(1)] })).toBe("1 item");
    expect(getSizeLabel({ type: "object", value: { name: serializeValue("Ada") } })).toBe("1 field");
    expect(getSizeLabel({ type: "object", value: { id: serializeValue(1), name: serializeValue("Ada") } })).toBe(
      "2 fields",
    );
  });
});

describe("getTableRows", () => {
  it("should show a non-empty array of objects as rows, and an object as one row", () => {
    expect(getTableRows(serializeValue([{ id: 1 }, { id: 2 }]))).toHaveLength(2);
    expect(getTableRows(serializeValue({ id: 1 }))).toHaveLength(1);
  });

  it("should leave empty values, mixed arrays and leaves out", () => {
    expect(getTableRows(serializeValue([]))).toBeUndefined();
    expect(getTableRows(serializeValue({}))).toBeUndefined();
    expect(getTableRows(serializeValue([{ id: 1 }, 2]))).toBeUndefined();
    expect(getTableRows(serializeValue("Ada"))).toBeUndefined();
  });
});

const relationHintOf = (...values: unknown[]) => getRelationHint(values.map((value) => serializeValue(value)));

describe("getRelationHint", () => {
  it("should say many for arrays of objects, empty arrays included, and one for objects or null", () => {
    expect(relationHintOf([{ title: "Hello" }], [])).toBe("many");
    expect(relationHintOf({ name: "Ada" }, null)).toBe("one");
  });

  it("should give plain and mixed columns no hint", () => {
    expect(relationHintOf(1, 2)).toBeUndefined();
    expect(relationHintOf(["a"], [])).toBeUndefined();
    expect(relationHintOf({ name: "Ada" }, [{ name: "Grace" }])).toBeUndefined();
    expect(relationHintOf(null)).toBeUndefined();
  });
});

function tableRowsOf(value: unknown) {
  const rows = getTableRows(serializeValue(value));

  if (rows === undefined) {
    throw new Error(`Expected table rows, but got none for: ${JSON.stringify(value)}`);
  }

  return rows;
}

describe("getTableColumns", () => {
  it("should nest relations down to the depth cap, then show them as chips", () => {
    const users = tableRowsOf([{ name: "Ada", posts: [{ title: "Hello" }] }]);

    expect(NESTED_TABLE_DEPTH).toBe(2);
    expect(getTableColumns(users, 0)).toEqual([
      { name: "name", hint: undefined, nested: false, fit: true },
      { name: "posts", hint: "many", nested: true, fit: false },
    ]);
    expect(getTableColumns(users, 1).find((column) => column.name === "posts")).toMatchObject({
      hint: "many",
      nested: true,
    });
    expect(getTableColumns(users, 2).find((column) => column.name === "posts")).toMatchObject({
      hint: "many",
      nested: false,
      fit: true,
    });
  });

  it("should let plain columns share the width when nothing nests", () => {
    const comments = tableRowsOf([{ body: "Welcome aboard.", author: { name: "Grace" } }]);

    expect(getTableColumns(comments, 2)).toEqual([
      { name: "body", hint: undefined, nested: false, fit: false },
      { name: "author", hint: "one", nested: false, fit: true },
    ]);
    expect(getTableColumns(tableRowsOf([{ id: 1, name: "Ada" }]), 0).every((column) => !column.fit)).toBe(true);
  });
});
