import { getRecommendedTuple, listSupportedTuples } from "@drizzle-run/core/catalog";
import { findRetiredPairSnapshot } from "@drizzle-run/core/contracts";
import { createPairManifest, pairSide } from "@drizzle-run/core/pair";
import { omit } from "es-toolkit";
import { describe, expect, it } from "vitest";

import { getProjectReleaseLines } from "../home/project-list";
import { formatBothSides, getSideReleases } from "../side-by-side/side-labels";
import { importProjectValue, readProjectJson } from "./project-file";
import {
  formatProjectDialects,
  getCatalogTarget,
  listProjectDialects,
  applyHelperOperation,
  applySideHelperOperation,
  changeSideVersion,
  changeVersion,
  chooseRelease,
  createProject,
  createProjectFromManifest,
  createSideBySideProject,
  duplicateProject,
  editProject,
  editSideFile,
  forkAsSideBySide,
  isOneVersion,
  isSideBySide,
  listMovablePairs,
  listRetiredReleases,
  openRetiredSnapshot,
  openSharedSnapshot,
  orderProjectFiles,
  renameSide,
  resolveRetiredPairProject,
  shareSideFile,
  splitSideFile,
  splitsSharedFiles,
  swapSides,
  getProjectScope,
  toCommunityProject,
  transitionProjectTrust,
  validateManifest,
  validateRecord,
  withSource,
  type ProjectRecord,
} from "./projects";

const target = { dialect: "sqlite" as const };

/** The manifest of a project the test knows runs on one version. */
function getOneVersionProject(project: ProjectRecord | undefined) {
  if (project === undefined || !isOneVersion(project)) {
    throw new Error("Expected a one-version project.");
  }

  return project;
}

function getOneVersionManifest(project: ProjectRecord | undefined) {
  return getOneVersionProject(project).manifest;
}

const manifestWith = (files: string[], seed: boolean) =>
  validateManifest({
    ...createProject("Order", target).manifest,
    entrypoints: seed
      ? { schema: "schema.ts", seed: "seed.ts", run: "query.ts" }
      : { schema: "schema.ts", run: "query.ts" },
    files: Object.fromEntries(files.map((path) => [path, "export {};\n"])),
  });

describe("file order", () => {
  it("should order query, schema, seed, then helpers", () => {
    const manifest = manifestWith(["z.ts", "schema.ts", "a.ts", "query.ts", "seed.ts"], true);

    expect(orderProjectFiles(manifest)).toEqual(["query.ts", "schema.ts", "seed.ts", "a.ts", "z.ts"]);
  });

  it("should order a project without a seed entrypoint", () => {
    const manifest = manifestWith(["helpers/b.ts", "schema.ts", "query.ts", "a.ts"], false);

    expect(orderProjectFiles(manifest)).toEqual(["query.ts", "schema.ts", "a.ts", "helpers/b.ts"]);
  });

  it("should keep a disabled seed in its slot instead of among the helpers", () => {
    const manifest = manifestWith(["z.ts", "schema.ts", "a.ts", "query.ts", "seed.ts", "fixtures.ts"], false);

    expect(orderProjectFiles(manifest)).toEqual(["query.ts", "schema.ts", "seed.ts", "a.ts", "fixtures.ts", "z.ts"]);
    expect(orderProjectFiles(manifest, "fixtures.ts")).toEqual([
      "query.ts",
      "schema.ts",
      "fixtures.ts",
      "a.ts",
      "seed.ts",
      "z.ts",
    ]);
  });
});

describe("manifest-backed projects", () => {
  it("should create a validated manifest-backed starter with the supported runtime tuple", () => {
    const project = createProject("  Example  ", target);
    expect(project.version).toBe(1);
    expect(project.name).toBe("Example");
    expect(project.manifest.kind).toBe("drizzle-run");
    expect(project.manifest.target).toEqual({ dialect: "sqlite" });
    expect(Object.keys(project.manifest.files)).toEqual(["schema.ts", "seed.ts", "query.ts"]);
    expect(project.manifest.files["query.ts"]).toContain("$.display");
  });

  it("should set the effect flavor for the Effect choice and drop it for the plain pair or Legacy", () => {
    const next = listSupportedTuples(target).find((tuple) => tuple.releaseLine === "next");
    const legacy = listSupportedTuples(target).find((tuple) => tuple.releaseLine === "legacy");

    if (!next || !legacy) {
      throw new Error("Expected a Legacy and a Next SQLite pair.");
    }

    const effectProject = createProject("Effect", target, next.id, "effect");
    const pairPins = { "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion };

    expect(effectProject.manifest).toMatchObject({ dependencies: pairPins, guestFlavor: "effect" });
    expect(createProject("Plain", target, next.id).manifest).not.toHaveProperty("guestFlavor");

    const plainProject = createProject("Plain", target, next.id);
    const effectAgain = changeVersion(plainProject, next.ormVersion, next.kitVersion, "effect");
    const plainAgain = changeVersion(effectAgain, next.ormVersion, next.kitVersion, "slim");
    const onLegacy = changeVersion(effectAgain, legacy.ormVersion, legacy.kitVersion);

    expect(effectAgain.manifest.guestFlavor).toBe("effect");
    expect(plainAgain.manifest).not.toHaveProperty("guestFlavor");
    expect(onLegacy.manifest).not.toHaveProperty("guestFlavor");
    expect(Object.keys(onLegacy.manifest.dependencies).toSorted()).toEqual(["drizzle-kit", "drizzle-orm"]);
    expect(onLegacy.manifest.files).toEqual(plainProject.manifest.files);
  });

  it("should refuse a pair whose guest cannot serve the files' imports, naming them", () => {
    const next = listSupportedTuples(target).find((tuple) => tuple.releaseLine === "next");
    const legacy = listSupportedTuples(target).find((tuple) => tuple.releaseLine === "legacy");

    if (!next || !legacy) {
      throw new Error("Expected a Legacy and a Next SQLite pair.");
    }

    const effectProject = createProject("Effect", target, next.id, "effect");

    expect(() => changeVersion(effectProject, next.ormVersion, next.kitVersion, "slim")).toThrow(
      new RegExp(`^.+ not available with orm ${next.ormVersion} · kit ${next.kitVersion}\\. Pick another release\\.$`),
    );
    expect(() => changeVersion(effectProject, legacy.ormVersion, legacy.kitVersion)).toThrow(/Pick another release/);
    expect(listMovablePairs(effectProject.manifest, target).map((tuple) => tuple.id)).toEqual([next.id]);
  });

  it("should create a project on the chosen tested pair", () => {
    const pair = listSupportedTuples(target).find((tuple) => !tuple.recommended);

    expect(pair).toBeDefined();

    if (!pair) {
      return;
    }

    const project = createProject("Pinned", target, pair.id);

    expect(project.manifest.dependencies).toMatchObject({
      "drizzle-orm": pair.ormVersion,
      "drizzle-kit": pair.kitVersion,
    });
  });

  it("should reject a pair from another database", () => {
    const postgres = listSupportedTuples({ dialect: "postgresql" })[0];

    expect(postgres).toBeDefined();

    if (!postgres) {
      return;
    }

    expect(() => createProject("Wrong", target, postgres.id)).toThrow(/release/i);
  });

  it("should validate helper file operations and preserve all other manifest fields", () => {
    const project = createProject("Helpers", target);
    const added = applyHelperOperation(project, "create", "helpers/users.ts");
    expect(added.manifest.files["helpers/users.ts"]).toBe("export {};\n");
    const renamed = applyHelperOperation(added, "rename", "helpers/users.ts", "helpers/people.ts");
    expect(renamed.manifest.files["helpers/users.ts"]).toBeUndefined();
    expect(renamed.manifest.files["query.ts"]).toBe(project.manifest.files["query.ts"]);
    expect(applyHelperOperation(renamed, "delete", "helpers/people.ts").manifest.files).toEqual(project.manifest.files);
    const helperPathMessage = "Use a relative .ts, .tsx, .mts, .js, .jsx, .mjs, .json, or .sql path.";

    expect(() => applyHelperOperation(project, "create", "../escape.ts")).toThrow(helperPathMessage);
    expect(() => applyHelperOperation(project, "create", "schema.ts")).toThrow("That file already exists.");
    expect(() => applyHelperOperation(project, "rename", "schema.ts", "tables.ts")).toThrow(
      "Entry filenames are fixed.",
    );

    const metadata = applyHelperOperation(project, "create", "meta/_journal.json");
    expect(metadata.manifest.files["meta/_journal.json"]).toBe("{}\n");
    const migration = applyHelperOperation(project, "create", "migrations/0001_users.sql");
    expect(migration.manifest.files["migrations/0001_users.sql"]).toBe("-- SQL migration\n");
    expect(applyHelperOperation(project, "create", "schema.mts").manifest.files["schema.mts"]).toBe("export {};\n");
    expect(() => applyHelperOperation(project, "create", "helpers/unsupported.md")).toThrow(helperPathMessage);
    expect(() => applyHelperOperation(project, "create", "helpers/unsupported.cjs")).toThrow(helperPathMessage);
    expect(() => applyHelperOperation(project, "create", ".ts")).toThrow(helperPathMessage);
    expect(() => applyHelperOperation(project, "create", "lib/.ts")).toThrow(helperPathMessage);
    expect(applyHelperOperation(project, "create", "lib/.env.ts").manifest.files["lib/.env.ts"]).toBe("export {};\n");
  });

  it("should say how to write a ./ path, and refuse a helper named like a file in another case", () => {
    const project = createProject("Helpers", target);
    const next = lineTuple("next");
    const pair = createSideBySideProject("Helpers", [target, target], [next.id, next.id], "shared");

    expect(() => applyHelperOperation(project, "create", "./users.ts")).toThrow(
      'Write the path without "./", such as "users.ts".',
    );
    expect(() => applyHelperOperation(project, "create", "Schema.ts")).toThrow(
      "That file already exists as schema.ts.",
    );
    expect(() =>
      applyHelperOperation(applyHelperOperation(project, "create", "users.ts"), "rename", "users.ts", "Query.ts"),
    ).toThrow("That file already exists as query.ts.");
    expect(
      applyHelperOperation(applyHelperOperation(project, "create", "users.ts"), "rename", "users.ts", "Users.ts")
        .manifest.files["Users.ts"],
    ).toBe("export {};\n");
    expect(() => applySideHelperOperation(pair, "create", "SEED.ts")).toThrow("That file already exists as seed.ts.");
  });

  it("should import manifests as fresh local projects without trusting exported local IDs", () => {
    const project = createProject("Exported", target);
    const { project: imported } = importProjectValue(
      readProjectJson(JSON.stringify({ ...project, id: "attacker-id", createdAt: "invalid" })),
    );
    expect(imported.id).not.toBe("attacker-id");
    expect(imported.manifest).toEqual(project.manifest);
    expect(imported.createdAt).not.toBe("invalid");
  });

  it("should import the published snapshot envelope as a fresh local project", () => {
    const source = createProject("Snapshot", target);
    const { project: imported, format } = importProjectValue(
      readProjectJson(JSON.stringify({ snapshotVersion: 1, name: source.name, manifest: source.manifest })),
    );
    expect(format).toBe("snapshot");
    expect(imported.version).toBe(1);
    expect(imported.name).toBe(source.name);
    expect(imported.id).not.toBe(source.id);
    expect(imported.manifest).toEqual(source.manifest);
  });

  it("should import a published snapshot as someone else's untrusted project", () => {
    const source = createProject("Snapshot", target);

    const { project: imported } = importProjectValue(
      readProjectJson(JSON.stringify({ snapshotVersion: 1, name: source.name, manifest: source.manifest })),
    );

    expect(imported.origin).toBe("community");
    expect(imported.trust).toBe("untrusted");
  });

  it("should keep the origin and trust of a project export", () => {
    const own = createProject("Own", target);
    const community = toCommunityProject(createProject("Forked", target));
    const allowed = { ...community, trust: "trusted" as const };

    const [ownImport, communityImport, allowedImport, unmarkedImport] = [
      importProjectValue(readProjectJson(JSON.stringify(own))),
      importProjectValue(readProjectJson(JSON.stringify(community))),
      importProjectValue(readProjectJson(JSON.stringify(allowed))),
      importProjectValue(readProjectJson(JSON.stringify({ ...community, trust: undefined }))),
    ];

    expect(ownImport.project.origin).toBeUndefined();
    expect(ownImport.project.trust).toBe("trusted");
    expect(communityImport.project).toMatchObject({ origin: "community", trust: "untrusted" });
    expect(allowedImport.project).toMatchObject({ origin: "community", trust: "trusted" });
    expect(unmarkedImport.project).toMatchObject({ origin: "community", trust: "untrusted" });
  });

  it("should reject unsupported manifests instead of keeping an unexecutable project", () => {
    expect(() =>
      validateManifest({
        kind: "drizzle-run",
        manifestVersion: 1,
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "latest", "drizzle-kit": "latest" },
        entrypoints: { schema: "schema.ts" },
        files: { "schema.ts": "" },
      }),
    ).toThrow('$["dependencies"]: The pinned Drizzle ORM and Kit versions are not an admitted pair for this database.');
  });

  it("should increment revisions for edits without mutating the captured project", () => {
    const project = createProject("Revision", target);
    const updated = editProject(project, { ...project.manifest, randomSeed: 99 });
    expect(project.manifest.randomSeed).toBeUndefined();
    expect(updated.manifest.randomSeed).toBe(99);
    expect(updated.revision).toBe(1);
  });
});

const lineTuple = (line: "legacy" | "next") => {
  const tuple = listSupportedTuples(target).find((item) => item.releaseLine === line);

  if (!tuple) {
    throw new Error(`The catalog has no ${line} SQLite pair.`);
  }

  return tuple;
};

const makeStoredRecord = (dependencies: Record<string, string>) => {
  const project = createProject("Old pair", target);

  return { ...project, manifest: { ...project.manifest, dependencies } };
};

describe("projects on a removed ORM/Kit pair", () => {
  const removedNext = { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" };
  const olderLegacy = { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" };

  it("should move a project on an older Legacy version to the Legacy pair without asking", () => {
    const legacy = lineTuple("legacy");
    const record = makeStoredRecord(olderLegacy);

    expect(resolveRetiredPairProject(record)).toBeUndefined();
    expect(getOneVersionManifest(validateRecord(record)).dependencies).toEqual({
      "drizzle-orm": legacy.ormVersion,
      "drizzle-kit": legacy.kitVersion,
    });
  });

  it("should say when an imported export on an older Legacy version moves to the Legacy pair", () => {
    const legacy = lineTuple("legacy");
    const { manifest } = makeStoredRecord(olderLegacy);

    const imported = importProjectValue(readProjectJson(JSON.stringify({ version: 1, name: "Old pair", manifest })));
    const current = importProjectValue(
      readProjectJson(
        JSON.stringify({ version: 1, name: "Current", manifest: createProject("Current", target).manifest }),
      ),
    );

    expect(imported.releaseNote).toBe(
      `“Old pair” moved from orm 0.44.0 · kit 0.30.0 to orm ${legacy.ormVersion} · kit ${legacy.kitVersion}: Drizzle Run no longer ships the release it was written for.`,
    );
    expect(current.releaseNote).toBeUndefined();
  });

  it("should recognize a stored project on a removed Next pair", () => {
    expect(resolveRetiredPairProject(makeStoredRecord(removedNext))).toMatchObject({
      name: "Old pair",
      releases: [{ target, releaseLine: "next", ormVersion: "1.0.0-rc.3", kitVersion: "1.0.0-rc.3" }],
    });
  });

  it("should leave valid and otherwise broken records alone", () => {
    expect(resolveRetiredPairProject(createProject("Current", target))).toBeUndefined();
    expect(resolveRetiredPairProject({ version: 1, id: "x", name: "Broken" })).toBeUndefined();
  });

  it("should move the project to the chosen pair, keeping its files", () => {
    const record = makeStoredRecord(removedNext);
    const retired = resolveRetiredPairProject(record);
    const next = lineTuple("next");

    expect(retired).toBeDefined();

    if (!retired) {
      return;
    }

    const project = getOneVersionProject(chooseRelease(retired, [{ tupleId: next.id }]));

    expect(project.id).toBe(record.id);
    expect(project.manifest.dependencies).toEqual({ "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion });
    expect(project.manifest.files).toEqual(record.manifest.files);
    expect(project.revision).toBe(record.revision + 1);
  });

  it("should offer every pair of the project's database", () => {
    expect(listMovablePairs(makeStoredRecord(removedNext).manifest, target)).toEqual(listSupportedTuples(target));
  });

  it("should open a shared snapshot on an older Legacy version directly, and ask for a removed Next pair", () => {
    const legacy = lineTuple("legacy");
    const next = lineTuple("next");
    const shared = (dependencies: Record<string, string>) => {
      const { manifest } = makeStoredRecord(dependencies);
      const releaseLine = dependencies["drizzle-orm"] === "0.44.0" ? ("legacy" as const) : ("next" as const);

      return {
        snapshot: { snapshotVersion: 1 as const, name: "Shared", manifest },
        retiredPair: {
          target,
          releaseLine,
          ormVersion: dependencies["drizzle-orm"] ?? "",
          kitVersion: dependencies["drizzle-kit"] ?? "",
        },
      };
    };

    expect(getOneVersionManifest(openSharedSnapshot(shared(olderLegacy))).dependencies).toEqual({
      "drizzle-orm": legacy.ormVersion,
      "drizzle-kit": legacy.kitVersion,
    });
    expect(openSharedSnapshot(shared(removedNext))).toBeUndefined();

    const { snapshot } = shared(removedNext);
    const project = getOneVersionProject(
      openRetiredSnapshot(snapshot, listRetiredReleases(snapshot.manifest) ?? [], [{ tupleId: next.id }]),
    );

    expect(project.name).toBe("Shared");
    expect(project.manifest.dependencies).toEqual({ "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion });
    expect(project.manifest.files).toEqual(makeStoredRecord(removedNext).manifest.files);
  });

  it("should open a shared side by side with a side on an older Legacy version on the Legacy pair", () => {
    const legacy = lineTuple("legacy");
    const next = lineTuple("next");
    const current = createPairManifest(
      validateManifest(makeStoredRecord(olderLegacy).manifest),
      [legacy, next],
      "separate",
    );
    const published = JSON.parse(
      JSON.stringify({
        snapshotVersion: 1,
        name: "Shared pair",
        manifest: { ...current, sides: [{ ...current.sides[0], dependencies: olderLegacy }, current.sides[1]] },
      }),
    ) as unknown;
    const shared = findRetiredPairSnapshot(published);

    expect(shared).toBeDefined();

    const project = shared && openSharedSnapshot(shared);

    expect(project?.manifest).toEqual(current);
    expect(project).toMatchObject({ name: "Shared pair", trust: "untrusted" });
  });

  it("should ask for a release per removed side of a side by side, and move only those sides", () => {
    const legacy = lineTuple("legacy");
    const next = lineTuple("next");
    const current = createPairManifest(
      validateManifest(makeStoredRecord(olderLegacy).manifest),
      [legacy, next],
      "separate",
    );
    const stored = {
      ...createProjectFromManifest("Old sides", current),
      manifest: {
        ...current,
        sides: [
          { ...current.sides[0], dependencies: olderLegacy },
          { ...current.sides[1], dependencies: removedNext },
        ],
      },
    };
    const retired = resolveRetiredPairProject(stored);

    expect(retired?.releases).toMatchObject([{ side: 1, releaseLine: "next", ormVersion: "1.0.0-rc.3" }]);

    if (!retired) {
      return;
    }

    const project = chooseRelease(retired, [{ tupleId: next.id }]);

    expect(project.manifest).toEqual(current);
    expect(project.revision).toBe(stored.revision + 1);

    const shared = findRetiredPairSnapshot({ snapshotVersion: 1, name: "Old sides", manifest: stored.manifest });

    expect(shared && openSharedSnapshot(shared)).toBeUndefined();
    expect(shared && openRetiredSnapshot(shared.snapshot, retired.releases, [{ tupleId: next.id }]).manifest).toEqual(
      current,
    );
  });

  it("should say when a release chosen for a removed side gives each side its own copy of shared files", () => {
    const legacy = lineTuple("legacy");
    const next = lineTuple("next");
    const current = createPairManifest(createProject("Shared sides", target).manifest, [next, next], "shared");
    const stored = {
      ...current,
      sides: [current.sides[0], { ...current.sides[1], dependencies: removedNext }],
    };
    const releases = listRetiredReleases(stored) ?? [];

    expect(releases).toMatchObject([{ side: 1 }]);
    expect(splitsSharedFiles(stored, releases, [{ tupleId: next.id }])).toBe(false);
    expect(splitsSharedFiles(stored, releases, [{ tupleId: legacy.id }])).toBe(true);
    expect(splitsSharedFiles(makeStoredRecord(removedNext).manifest, releases, [{ tupleId: legacy.id }])).toBe(false);
  });
});

describe("project origin", () => {
  it("should mark a shared snapshot as a Community project, and keep that through storage, copies and side-by-side forks", () => {
    const starter = createProject("Shared", { dialect: "postgresql" });
    const shared = openSharedSnapshot({ snapshot: { snapshotVersion: 1, name: "Shared", manifest: starter.manifest } });
    const tuples = listSupportedTuples({ dialect: "postgresql" });
    const other = tuples.find((tuple) => tuple.ormVersion !== starter.manifest.dependencies["drizzle-orm"]);

    if (shared === undefined || !isOneVersion(shared) || other === undefined) {
      throw new Error("Expected a one-version shared project and a second release.");
    }

    expect(shared.origin).toBe("community");
    expect(validateRecord(JSON.parse(JSON.stringify(shared))).origin).toBe("community");
    expect(duplicateProject(shared).origin).toBe("community");
    expect(editProject(shared, shared.manifest, "Renamed").origin).toBe("community");
    expect(forkAsSideBySide(shared, "Pair", other.id, "separate").origin).toBe("community");
    expect(duplicateProject(starter)).not.toHaveProperty("origin");
    expect(toCommunityProject(starter).origin).toBe("community");
  });
});

describe("project source", () => {
  const guideSource = { kind: "guide", id: "db0755a7-fec9-4789-a9f7-d9314d0083cc" } as const;

  it("should keep the official version a project was forked from through storage, edits, copies and side-by-side forks", () => {
    const forked = withSource(createProject("Forked", { dialect: "postgresql" }), guideSource);
    const other = listSupportedTuples({ dialect: "postgresql" }).find(
      (tuple) => tuple.ormVersion !== forked.manifest.dependencies["drizzle-orm"],
    );

    if (!isOneVersion(forked) || other === undefined) {
      throw new Error("Expected a one-version project and a second release.");
    }

    expect(validateRecord(JSON.parse(JSON.stringify(forked))).source).toEqual(guideSource);
    expect(editProject(forked, forked.manifest, "Renamed").source).toEqual(guideSource);
    expect(duplicateProject(forked).source).toEqual(guideSource);
    expect(forkAsSideBySide(forked, "Pair", other.id, "separate").source).toEqual(guideSource);
    expect(createProject("Mine", { dialect: "postgresql" })).not.toHaveProperty("source");
  });
});

describe("project trust", () => {
  it("should trust the user's own projects from birth and read someone else's as untrusted", () => {
    const own = createProject("Mine", { dialect: "postgresql" });
    const shared = toCommunityProject(own);

    expect(own.trust).toBe("trusted");
    expect(getProjectScope(own)).toBe("project");
    expect(shared.trust).toBe("untrusted");
    expect(getProjectScope(shared)).toBe("untrusted");
  });

  it("should move trust only on the user's act, on someone else's project only", () => {
    const own = createProject("Mine", { dialect: "postgresql" });
    const fork = toCommunityProject(own);
    const trusted = transitionProjectTrust(fork, { type: "project.trust" });

    expect(trusted).toMatchObject({ trust: "trusted", origin: "community" });
    expect(getProjectScope(trusted)).toBe("project");
    expect(transitionProjectTrust(trusted, { type: "project.trust" })).toBe(trusted);
    expect(transitionProjectTrust(trusted, { type: "project.untrust" })).toMatchObject({ trust: "untrusted" });
    expect(transitionProjectTrust(own, { type: "project.untrust" })).toBe(own);
  });

  it("should keep trust through storage, edits and copies, and never let a copy gain it", () => {
    const fork = toCommunityProject(createProject("Fork", { dialect: "postgresql" }));
    const trusted = transitionProjectTrust(fork, { type: "project.trust" });

    expect(validateRecord(JSON.parse(JSON.stringify(fork))).trust).toBe("untrusted");
    expect(validateRecord(JSON.parse(JSON.stringify(trusted))).trust).toBe("trusted");
    expect(editProject(fork, fork.manifest, "Renamed").trust).toBe("untrusted");
    expect(duplicateProject(fork).trust).toBe("untrusted");
    expect(duplicateProject(trusted).trust).toBe("trusted");
    expect(toCommunityProject(trusted).trust).toBe("untrusted");
  });

  it("should refuse a stored record without a readable trust", () => {
    const own = createProject("Mine", { dialect: "postgresql" });

    expect(() => validateRecord(omit(own, ["trust"]))).toThrow("A stored project is invalid.");
    expect(() => validateRecord({ ...own, trust: "yes" })).toThrow("A stored project is invalid.");
  });
});

describe("side-by-side projects", () => {
  const [legacy, next] = [...listSupportedTuples(target)].toSorted((left) => (left.releaseLine === "legacy" ? -1 : 1));
  const pairIds = () => {
    if (!legacy || !next) {
      throw new Error("Expected a Legacy and a Next SQLite pair.");
    }

    return [legacy.id, next.id] as const;
  };

  it("should create a pair project with separate files and a shared seed, and store it as record version 2", () => {
    const project = createSideBySideProject("Both", [target, target], pairIds(), "separate");

    expect(project.version).toBe(1);
    expect(Object.keys(project.manifest.files)).toEqual(["seed.ts"]);
    expect(Object.keys(project.manifest.sides[1].files).toSorted()).toEqual(["query.ts", "schema.ts"]);
    expect(project.manifest.sides.map((side) => side.dependencies["drizzle-orm"])).toEqual(["0.45.4", "1.0.0-rc.5"]);

    const stored = validateRecord(JSON.parse(JSON.stringify(project)));

    expect(isSideBySide(stored) && stored.manifest).toEqual(project.manifest);
  });

  it("should run each side on its own database, with a schema each and the starter seed shared", () => {
    const project = createSideBySideProject(
      "Postgres vs SQLite",
      [{ dialect: "postgresql" }, target],
      [getRecommendedTuple({ dialect: "postgresql" }).id, pairIds()[1]],
      "shared",
    );

    expect(project.manifest.sides.map((side) => side.target.dialect)).toEqual(["postgresql", "sqlite"]);
    expect(Object.keys(project.manifest.files).toSorted()).toEqual(["query.ts", "seed.ts"]);
    expect(project.manifest.sides[0].files["schema.ts"]).toContain("drizzle-orm/pg-core");
    expect(project.manifest.sides[1].files["schema.ts"]).toContain("drizzle-orm/sqlite-core");
    expect(listProjectDialects(project.manifest)).toEqual(["postgresql", "sqlite"]);
    expect(formatProjectDialects(project.manifest)).toBe("PostgreSQL vs SQLite");
    expect(formatBothSides(project.manifest)).toBe("rc.5 on PostgreSQL and SQLite");
    expect(getCatalogTarget(project.manifest, 1)).toEqual({ dialect: "sqlite" });
  });

  it("should fork a PostgreSQL project into PostgreSQL vs SQLite, the new side keeping the schema to rewrite", () => {
    const postgres = createProject("Postgres", { dialect: "postgresql" });
    const sqliteNext = getRecommendedTuple(target);
    const forked = forkAsSideBySide(postgres, "Postgres vs SQLite", sqliteNext.id, "shared");
    const schema = getOneVersionManifest(postgres).files["schema.ts"];

    expect(forked.manifest.sides.map((side) => side.target.dialect)).toEqual(["postgresql", "sqlite"]);
    expect(Object.keys(forked.manifest.files).toSorted()).toEqual(["query.ts", "seed.ts"]);
    expect(forked.manifest.sides.map((side) => side.files["schema.ts"])).toEqual([schema, schema]);
    expect(pairSide(forked.manifest, 1).target).toEqual(target);
  });

  it("should move one side to the other database, its schema split from the other side's", () => {
    const postgresTuple = getRecommendedTuple({ dialect: "postgresql" });
    const project = createSideBySideProject(
      "Two Postgres",
      [{ dialect: "postgresql" }, { dialect: "postgresql" }],
      [postgresTuple.id, postgresTuple.id],
      "shared",
    );
    const moved = changeSideVersion(project, 1, getRecommendedTuple(target).id, "keep");

    expect(moved.manifest.sides.map((side) => side.target.dialect)).toEqual(["postgresql", "sqlite"]);
    expect(moved.manifest.files).not.toHaveProperty("schema.ts");
    expect(moved.manifest.sides[1].files["schema.ts"]).toBe(moved.manifest.sides[0].files["schema.ts"]);
    expect(formatProjectDialects(moved.manifest)).toBe("PostgreSQL vs SQLite");

    const copied = changeSideVersion(moved, 0, getRecommendedTuple(target).id, "copy");

    expect(copied.manifest.sides.map((side) => side.target.dialect)).toEqual(["sqlite", "sqlite"]);
  });

  it("should give each side the flavor it was created or moved with", () => {
    const [legacyId, nextId] = pairIds();
    const project = createSideBySideProject("Effect side", [target, target], [legacyId, nextId], "separate", [
      "slim",
      "effect",
    ]);

    expect(project.manifest.sides[0]).not.toHaveProperty("guestFlavor");
    expect(project.manifest.sides[1].guestFlavor).toBe("effect");

    const plain = changeSideVersion(project, 1, nextId, "keep", "slim");

    expect(plain.manifest.sides[1]).not.toHaveProperty("guestFlavor");
  });

  it("should run rc.5 next to rc.5 with Effect, each side keeping its own flavor in either files mode", () => {
    const [, nextId] = pairIds();

    for (const files of ["separate", "shared"] as const) {
      const project = createSideBySideProject("Plain vs Effect", [target, target], [nextId, nextId], files, [
        "slim",
        "effect",
      ]);

      expect(project.manifest.sides[0]).not.toHaveProperty("guestFlavor");
      expect(project.manifest.sides[1].guestFlavor).toBe("effect");
      expect(formatBothSides(project.manifest)).toBe("rc.5 and rc.5 + Effect");
      expect(getProjectReleaseLines(project).map((line) => [line.ormVersion, line.guestFlavor])).toEqual([
        ["1.0.0-rc.5", "slim"],
        ["1.0.0-rc.5", "effect"],
      ]);
      expect(getProjectReleaseLines(renameSide(project, 0, "Before")).map((line) => line.name)).toEqual([
        "Before",
        undefined,
      ]);
      expect(changeSideVersion(project, 0, nextId, "keep", "effect").manifest.sides[0].guestFlavor).toBe("effect");
    }

    const fork = forkAsSideBySide(
      createProject("Plain", target, nextId),
      "Fork",
      nextId,
      "shared",
      "project",
      "effect",
    );

    expect(getSideReleases(fork.manifest).map(({ short, line }) => [short, line])).toEqual([
      ["rc.5", "RC"],
      ["rc.5 + Effect", "RC + Effect"],
    ]);
  });

  it("should create, fork and rename sides on one release, labelled by name or (1) and (2)", () => {
    const [, nextId] = pairIds();
    const named = createSideBySideProject("Select vs RQB", [target, target], [nextId, nextId], "separate", undefined, [
      " Classic ",
      "RQB",
    ]);

    expect(named.revision).toBe(0);
    expect(named.manifest.sides.map((side) => side.name)).toEqual(["Classic", "RQB"]);
    expect(getSideReleases(named.manifest).map(({ label, short }) => [label, short])).toEqual([
      ["Classic", "rc.5"],
      ["RQB", "rc.5"],
    ]);
    expect(formatBothSides(named.manifest)).toBe("rc.5 on both sides");

    const unnamed = renameSide(renameSide(named, 0, ""), 1, "  ");

    expect(unnamed.revision).toBe(2);
    expect(getSideReleases(unnamed.manifest).map(({ label }) => label)).toEqual(["rc.5 (1)", "rc.5 (2)"]);

    const fork = forkAsSideBySide(createProject("Plain", target, nextId), "Fork", nextId, "separate", "new", "slim", [
      "Batch",
      "Transaction",
    ]);

    expect(fork.manifest.sides.map((side) => side.name)).toEqual(["Batch", "Transaction"]);
  });

  it("should show an edit to a shared file on both sides and to a per-side file on one", () => {
    const [, nextId] = pairIds();
    const shared = editSideFile(
      createSideBySideProject("Shared", [target, target], [nextId, nextId], "shared"),
      1,
      "query.ts",
      "console.log(1);\n",
    );

    expect(pairSide(shared.manifest, 0).files["query.ts"]).toBe("console.log(1);\n");
    expect(shared.revision).toBe(1);

    const separate = editSideFile(
      createSideBySideProject("Separate", [target, target], pairIds(), "separate"),
      1,
      "query.ts",
      "console.log(2);\n",
    );

    expect(pairSide(separate.manifest, 0).files["query.ts"]).not.toBe("console.log(2);\n");
    expect(pairSide(separate.manifest, 1).files["query.ts"]).toBe("console.log(2);\n");
  });

  it("should split, share, swap and move a side, keeping both sides valid", () => {
    const [legacyId, nextId] = pairIds();
    const project = createSideBySideProject("Moves", [target, target], [nextId, nextId], "shared");
    const split = splitSideFile(project, "query.ts");

    expect(Object.hasOwn(split.manifest.sides[0].files, "query.ts")).toBe(true);
    expect(shareSideFile(split, "query.ts", 1).manifest.files["query.ts"]).toBe(project.manifest.files["query.ts"]);

    const crossLine = createSideBySideProject("Lines", [target, target], [legacyId, nextId], "separate");

    expect(swapSides(crossLine).manifest.sides[0].dependencies["drizzle-orm"]).toBe("1.0.0-rc.5");
    expect(() => shareSideFile(crossLine, "query.ts", 1)).toThrow("share only the seed");

    const moved = changeSideVersion(project, 0, legacyId, "keep");

    expect(moved.manifest.sides[0].dependencies["drizzle-orm"]).toBe("0.45.4");
    expect(Object.keys(moved.manifest.files)).toEqual(["seed.ts"]);
    expect(moved.manifest.sides[0].files["query.ts"]).toBe(project.manifest.files["query.ts"]);
    expect(changeSideVersion(crossLine, 0, nextId, "copy").manifest.sides[0].files).toEqual(
      crossLine.manifest.sides[1].files,
    );
  });

  it("should fork a one-version project as side by side and keep the original", () => {
    const original = createProject("Bank transfers", target, legacy?.id);
    const fork = forkAsSideBySide(original, "Bank transfers, 0.45 vs rc.5", pairIds()[1], "separate");

    expect(fork.id).not.toBe(original.id);
    expect(fork.manifest.sides.map((side) => side.dependencies["drizzle-orm"])).toEqual(["0.45.4", "1.0.0-rc.5"]);
    expect(pairSide(fork.manifest, 1).files["query.ts"]).toBe(original.manifest.files["query.ts"]);
    expect(
      forkAsSideBySide(original, "Swapped", pairIds()[1], "separate", "new").manifest.sides[0].dependencies[
        "drizzle-orm"
      ],
    ).toBe("1.0.0-rc.5");
    expect(() => forkAsSideBySide(original, "Shared", pairIds()[1], "shared")).toThrow("share only the seed");
    expect(isOneVersion(original)).toBe(true);
  });

  it("should keep a fork of a side-by-side project side by side", () => {
    const copy = duplicateProject(createSideBySideProject("Both", [target, target], pairIds(), "separate"));

    expect(isSideBySide(copy)).toBe(true);
    expect(copy.name).toBe("Both copy");
  });

  it("should add a shared helper and rename or delete a per-side one on both sides", () => {
    const [, nextId] = pairIds();
    const oneLine = createSideBySideProject("Helpers", [target, target], [nextId, nextId], "separate");

    expect(applySideHelperOperation(oneLine, "create", "helpers.ts").manifest.files["helpers.ts"]).toBe("export {};\n");

    const project = createSideBySideProject("Helpers", [target, target], pairIds(), "separate");
    const added = applySideHelperOperation(project, "create", "helpers.ts");

    expect(Object.hasOwn(added.manifest.files, "helpers.ts")).toBe(false);
    expect(added.manifest.sides.map((side) => side.files["helpers.ts"])).toEqual(["export {};\n", "export {};\n"]);
    expect(() => applySideHelperOperation(project, "delete", "seed.ts")).toThrow("Entry filenames are fixed.");
    expect(() => applySideHelperOperation(project, "create", "schema.ts")).toThrow("That file already exists.");

    const renamed = applySideHelperOperation(added, "rename", "helpers.ts", "util.ts");

    expect(renamed.manifest.sides.map((side) => Object.hasOwn(side.files, "util.ts"))).toEqual([true, true]);
    expect(
      applySideHelperOperation(renamed, "delete", "util.ts").manifest.sides.map((side) =>
        Object.keys(side.files).toSorted(),
      ),
    ).toEqual([
      ["query.ts", "schema.ts"],
      ["query.ts", "schema.ts"],
    ]);
  });

  it("should read and import a stored pair record as it is", () => {
    const project = createSideBySideProject("Stored", [target, target], pairIds(), "separate");
    const reread = validateRecord(JSON.parse(JSON.stringify(project)));
    const { project: imported } = importProjectValue(
      readProjectJson(JSON.stringify({ snapshotVersion: 1, name: "Shared pair", manifest: project.manifest })),
    );

    expect(reread).toEqual(project);
    expect(isSideBySide(imported) && imported.manifest).toEqual(project.manifest);
    expect(imported.id).not.toBe(project.id);
  });

  it("should import an exported pair project and a bare pair manifest", () => {
    const project = createSideBySideProject("Exported", [target, target], pairIds(), "separate");
    const [exported, bare] = [
      importProjectValue(readProjectJson(JSON.stringify(project))),
      importProjectValue(readProjectJson(JSON.stringify(project.manifest))),
    ];

    expect(exported.format).toBe("project");
    expect(isSideBySide(exported.project) && exported.project.manifest).toEqual(project.manifest);
    expect(exported.project.name).toBe("Exported");
    expect(bare.format).toBe("manifest");
    expect(isSideBySide(bare.project) && bare.project.manifest).toEqual(project.manifest);
  });

  it("should refuse a stored pair whose sides list different per-side files", () => {
    const project = createSideBySideProject("Broken", [target, target], pairIds(), "separate");
    const broken = {
      ...project,
      manifest: {
        ...project.manifest,
        sides: [project.manifest.sides[0], { ...project.manifest.sides[1], files: {} }],
      },
    };

    expect(() => validateRecord(broken)).toThrow("copy per side");
  });

  it("should edit a pair project with editProject only through a valid pair manifest", () => {
    const project = createSideBySideProject("Edit", [target, target], pairIds(), "separate");

    expect(() =>
      editProject(project, { ...project.manifest, files: { ...project.manifest.files, "query.ts": "x" } }),
    ).toThrow("cannot also have a copy per side");
  });
});
