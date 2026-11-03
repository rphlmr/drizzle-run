import { fileURLToPath } from "node:url";

import { digestCloudProject } from "@drizzle-run/core/contracts";
import initSqlite from "@sqlite.org/sqlite-wasm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../../test/store/memory-store";
import { planCloudSync } from "../cloud/cloud-plan";
import { readStoreMigrations } from "./migrations";
import type { StoredProject } from "./service";
import { exportSnapshot, openSnapshotDatabase } from "./snapshot-database";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

function makeStoredProject(options: { id?: string; name?: string } = {}): StoredProject {
  return {
    version: 1,
    id: options.id ?? crypto.randomUUID(),
    name: options.name ?? "Stored",
    createdAt: "2026-10-17T08:00:00.000Z",
    updatedAt: "2026-10-17T08:00:00.000Z",
    revision: 1,
    manifest: { kind: "drizzle-run", files: { "schema.ts": "export {};\n" } },
    trust: "trusted",
  };
}

describe("readStoreMigrations", () => {
  it("should bundle the same migrations drizzle-orm reads from the Kit folders", async () => {
    const bundled = await readStoreMigrations();

    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled).toEqual(readMigrationFiles({ migrationsFolder }));
  });
});

describe("store service", () => {
  it("should apply every migration on the first request, once", async () => {
    const { client, database } = await createMemoryStore();
    const migrations = await readStoreMigrations();

    await client.call("loadProjects");
    await client.call("readSetting", "guide-seen");

    const applied = database.exec({
      sql: "SELECT name FROM __drizzle_migrations ORDER BY id",
      rowMode: "array",
      returnValue: "resultRows",
    });
    expect(applied).toEqual(migrations.map((migration) => [migration.name]));
  });

  it("should keep NOT NULL on the TEXT primary keys Kit leaves it off", async () => {
    const { client, database } = await createMemoryStore();
    await client.call("loadProjects");

    expect(() => database.exec("INSERT INTO settings (key, value) VALUES (NULL, 'true')")).toThrow(/NOT NULL/);
  });

  it("should keep a project's origin and trust", async () => {
    const { client } = await createMemoryStore();
    const fork: StoredProject = { ...makeStoredProject({ name: "Fork" }), origin: "community", trust: "untrusted" };
    const trusted: StoredProject = { ...makeStoredProject({ name: "Trusted fork" }), origin: "community" };
    const own = makeStoredProject({ name: "Mine" });

    await client.call("saveProjects", [fork, trusted, own], []);
    const stored = await client.call("loadProjects");

    expect(stored).toContainEqual(fork);
    expect(stored).toContainEqual(trusted);
    expect(stored).toContainEqual(own);
  });

  it("should keep the official version a project was forked from", async () => {
    const { client } = await createMemoryStore();
    const forked: StoredProject = {
      ...makeStoredProject({ name: "Forked" }),
      source: { kind: "guide", id: "db0755a7-fec9-4789-a9f7-d9314d0083cc" },
    };
    const own = makeStoredProject({ name: "Mine" });

    await client.call("saveProjects", [forked, own], []);
    const stored = await client.call("loadProjects");

    expect(stored).toContainEqual(forked);
    expect(stored).toContainEqual(own);
  });

  it("should refuse a source kind without its version id", async () => {
    const { client, database } = await createMemoryStore();
    await client.call("loadProjects");

    expect(() =>
      database.exec(
        "INSERT INTO projects (id, record_version, name, created_at, updated_at, revision, manifest, trust, source_kind) VALUES ('p', 2, 'P', '', '', 0, '{}', 'trusted', 'guide')",
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("should write a whole save or none of it", async () => {
    const { client } = await createMemoryStore();
    const kept = makeStoredProject({ name: "Kept" });
    await client.call("saveProjects", [kept], []);

    const invalid = { ...makeStoredProject(), revision: -1 };
    const save = client.call("saveProjects", [makeStoredProject({ name: "Added" }), invalid], [kept.id]);

    await expect(save).rejects.toThrow(/CHECK constraint failed/);
    expect(await client.call("loadProjects")).toEqual([kept]);
  });

  it("should keep a newer stored revision and report the older write as stale", async () => {
    const { client } = await createMemoryStore();
    const newer = { ...makeStoredProject({ name: "Newer" }), revision: 3 };
    await client.call("saveProjects", [newer], []);

    const older = { ...newer, name: "Older", revision: 2 };
    const added = makeStoredProject({ name: "Added" });
    const result = await client.call("saveProjects", [older, added], []);

    expect(result).toEqual({ stale: [newer.id] });
    expect(await client.call("loadProjects")).toEqual(expect.arrayContaining([newer, added]));
  });

  it("should keep each GitHub account's cloud sync rows apart", async () => {
    const { client } = await createMemoryStore();
    const projectId = "00000000-0000-4000-8000-00000000000a";
    await client.call("saveProjects", [makeStoredProject({ id: projectId })], []);
    await client.call("writeCloudSync", 1, { projectId, revision: 3, digest: "a".repeat(64) });
    await client.call("writeCloudSync", 2, { projectId, revision: 0, digest: "" });

    await client.call("deleteCloudSync", 2, projectId);

    expect(await client.call("loadCloudSync", 1)).toEqual([{ projectId, revision: 3, digest: "a".repeat(64) }]);
    expect(await client.call("loadCloudSync", 2)).toEqual([]);
  });

  it("should clear every removed project's account associations while keeping unrelated rows and share links", async () => {
    const { client } = await createMemoryStore();
    const leaving = makeStoredProject({ name: "Leaving" });
    const staying = makeStoredProject({ name: "Staying" });
    const link = { linkId: "link-1", publishedAt: "2026-10-01T10:00:00.000Z" };
    const row = { projectId: leaving.id, revision: 2, digest: "b".repeat(64) };
    await client.call("saveProjects", [leaving, staying], []);
    await client.call("writeShareLink", leaving.id, link);
    await client.call("writeCloudSync", 1, row);
    await client.call("writeCloudSync", 2, row);
    const stayingRow = { projectId: staying.id, revision: 1, digest: digestCloudProject(staying) };
    await client.call("writeCloudSync", 2, stayingRow);

    const { removedIds } = await client.call("removeCloudProjects", 1, "discard");

    expect(removedIds).toEqual([leaving.id]);
    expect(await client.call("loadProjects")).toEqual([staying]);
    expect(await client.call("loadCloudSync", 1)).toEqual([]);
    expect(await client.call("loadCloudSync", 2)).toEqual([stayingRow]);
    expect(await client.call("readShareLink", leaving.id)).toEqual(link);
  });

  it("should download another account's Cloud copy after expiry instead of scheduling its deletion", async () => {
    const { client } = await createMemoryStore();
    const project = makeStoredProject();
    const row = { projectId: project.id, revision: 1, digest: digestCloudProject(project) };
    await client.call("saveProjects", [project], []);
    await client.call("writeCloudSync", 1, row);
    await client.call("writeCloudSync", 2, row);

    await client.call("removeCloudProjects", 2, "keep_unsaved");
    const plan = planCloudSync({
      local: [],
      rows: await client.call("loadCloudSync", 1),
      cloud: [
        {
          id: project.id,
          name: project.name,
          revision: row.revision,
          digest: row.digest,
          byteSize: 100,
          updatedAt: project.updatedAt,
        },
      ],
      unopenable: new Set(),
      maxProjectBytes: 1024,
    });

    expect(plan.steps).toEqual([expect.objectContaining({ kind: "download" })]);
  });

  it("should not recreate a sync row when another tab finishes uploading after sign-out", async () => {
    const { client } = await createMemoryStore();
    const project = makeStoredProject();
    const row = { projectId: project.id, revision: 1, digest: "a".repeat(64) };
    await client.call("saveProjects", [project], []);
    await client.call("writeCloudSync", 1, row);

    await client.call("removeCloudProjects", 1, "discard");
    await client.call("writeCloudSync", 1, { ...row, revision: 2 });

    expect(await client.call("loadCloudSync", 1)).toEqual([]);
    expect(await client.call("loadProjects")).toEqual([]);
  });

  it("should still update a pending deletion's existing row when its upload finishes", async () => {
    const { client } = await createMemoryStore();
    const project = makeStoredProject();
    const row = { projectId: project.id, revision: 1, digest: "a".repeat(64) };
    await client.call("saveProjects", [project], []);
    await client.call("writeCloudSync", 1, row);
    await client.call("saveProjects", [], [project.id]);

    await client.call("writeCloudSync", 1, { ...row, revision: 2 });

    expect(await client.call("loadCloudSync", 1)).toEqual([{ ...row, revision: 2 }]);
    expect(await client.call("loadProjects")).toEqual([]);
  });

  it("should preserve every project when a final sign-out removal finds newer unsaved edits", async () => {
    const { client } = await createMemoryStore();
    const project = makeStoredProject();
    await client.call("saveProjects", [project], []);
    await client.call("writeCloudSync", 1, {
      projectId: project.id,
      revision: 1,
      digest: digestCloudProject(project),
    });
    const edited = { ...project, name: "Later edit", revision: 2 };
    await client.call("saveProjects", [edited], []);

    const result = await client.call("removeCloudProjects", 1, "require_saved");

    expect(result).toEqual({ removedIds: [], unsavedIds: [project.id] });
    expect(await client.call("loadProjects")).toEqual([edited]);
    expect(await client.call("loadCloudSync", 1)).toHaveLength(1);
  });

  it("should remove saved copies on session expiry and keep unsaved projects as Local without stale rows", async () => {
    const { client } = await createMemoryStore();
    const saved = makeStoredProject({ name: "Saved" });
    const edited = makeStoredProject({ name: "Edited" });
    const local = makeStoredProject({ name: "Local" });
    await client.call("saveProjects", [saved, edited, local], []);
    await client.call("writeCloudSync", 1, {
      projectId: saved.id,
      revision: 1,
      digest: digestCloudProject(saved),
    });
    await client.call("writeCloudSync", 1, { projectId: edited.id, revision: 0, digest: "" });

    const result = await client.call("removeCloudProjects", 1, "keep_unsaved");

    expect(result).toEqual({ removedIds: [saved.id], unsavedIds: [edited.id] });
    expect(await client.call("loadProjects")).toEqual(expect.arrayContaining([edited, local]));
    expect(await client.call("loadProjects")).toHaveLength(2);
    expect(await client.call("loadCloudSync", 1)).toEqual([]);
  });
});

describe("openSnapshotDatabase", () => {
  it("should reopen a database from the bytes it exported", async () => {
    const sqlite = await initSqlite();
    const original = openSnapshotDatabase(sqlite, undefined);
    original.exec("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    original.exec("INSERT INTO settings VALUES ('guide-seen', 'true')");
    const bytes = exportSnapshot(sqlite, original);
    original.close();

    const reopened = openSnapshotDatabase(sqlite, bytes);
    reopened.exec("INSERT INTO settings VALUES ('theme', 'dark')");

    expect(
      reopened.exec({ sql: "SELECT key FROM settings ORDER BY key", rowMode: "array", returnValue: "resultRows" }),
    ).toEqual([["guide-seen"], ["theme"]]);
    reopened.close();
  });
});
