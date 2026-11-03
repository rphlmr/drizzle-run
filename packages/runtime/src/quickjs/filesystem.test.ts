import { createHash as createNativeHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createHash } from "../../scripts/quickjs/crypto.ts";
import { configureProjectFiles, existsSync, readFileSync, readdirSync } from "../../scripts/quickjs/filesystem.ts";

describe("project migration filesystem", () => {
  it("should read Legacy journal files and list Next migration directories", () => {
    configureProjectFiles({
      "migrations/meta/_journal.json": '{"entries":[]}',
      "migrations/20261103120000_users/migration.sql": "CREATE TABLE users (id integer);",
    });

    expect(existsSync("./migrations/meta/_journal.json")).toBe(true);
    expect(readFileSync("migrations/meta/_journal.json").toString()).toBe('{"entries":[]}');
    expect(readdirSync("migrations")).toEqual(["20261103120000_users", "meta"]);
    expect(readFileSync("migrations/20261103120000_users/migration.sql", "utf8")).toContain("CREATE TABLE");
  });

  it("should replace earlier project files and never read the host filesystem", () => {
    configureProjectFiles({ "secret.sql": "select 1" });
    configureProjectFiles({ "current.sql": "select 2" });

    expect(existsSync("secret.sql")).toBe(false);
    expect(() => readFileSync("secret.sql")).toThrow("does not exist");
    expect(() => readFileSync("/etc/passwd")).toThrow("relative path");
    expect(() => readFileSync("../../package.json")).toThrow("escapes its root");
    expect(() => readdirSync("missing")).toThrow("does not exist");
  });
});

describe("migration hashing", () => {
  it("should match Node SHA-256 for Unicode SQL and multiple updates", () => {
    const text = "INSERT INTO names VALUES ('Élodie');";
    const expected = createNativeHash("sha256").update(text).digest("hex");

    expect(createHash("sha256").update(text.slice(0, 10)).update(text.slice(10)).digest("hex")).toBe(expected);
    expect(() => createHash("md5")).toThrow("supports sha256");
  });
});
