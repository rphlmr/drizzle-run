import { getRecommendedTuple } from "@drizzle-run/core/catalog";
import { digestCloudProject } from "@drizzle-run/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { createMemoryStore } from "../../test/store/memory-store";
import {
  chooseRelease,
  createProject,
  editProject,
  toCommunityProject,
  transitionProjectTrust,
} from "../project/projects";
import { mergeExternalProjects, workspaceMachine } from "../workspace/workspace-machine";
import { createStoreClient, type StoreClient, type StorePort } from "./client";
import type { StoreArgs, StoreOperationName, StoreResponse } from "./service";
import {
  LocalProjectStorage,
  readShareLinkRecord,
  VolatileProjectStorage,
  type ExternalProjectChange,
} from "./storage";

function makeProject() {
  return createProject("Stored", { dialect: "sqlite" });
}

async function makeStorage() {
  const store = await createMemoryStore();

  return { ...store, storage: new LocalProjectStorage({ client: store.client }) };
}

/** Two tabs on one store, each listening for the other's changes. */
async function makeTabs() {
  const { client } = await createMemoryStore();
  const storeName = `tabs-${crypto.randomUUID()}`;
  const first = new LocalProjectStorage({ client, storeName });
  const second = new LocalProjectStorage({ client, storeName });
  const heard: [ExternalProjectChange[], ExternalProjectChange[]] = [[], []];
  const stopFirst = first.onExternalChange((change) => heard[0].push(change));
  const stopSecond = second.onExternalChange((change) => heard[1].push(change));

  return {
    client,
    storeName,
    first,
    second,
    heard,
    close: () => {
      stopFirst();
      stopSecond();
    },
  };
}

/**
 * Two tabs on one store, where the first tab's reads of the store can be held
 *
 * `holdFirstTabReads` holds the first tab's next reads until `release`; `started` resolves once one is waiting, such as
 * the reload of a change the second tab saved.
 */
/** Tells the store's tabs that another tab saved `ids` and deleted `deletedIds`, as a saving tab does. */
function announceStoreChange(storeName: string, change: { ids: string[]; deletedIds: string[] }) {
  const channel = new BroadcastChannel(`drizzle-run-store:${storeName}`);
  channel.postMessage(change);
  channel.close();
}

async function makeTabsWithHeldReads() {
  const { client } = await createMemoryStore();
  const storeName = `tabs-${crypto.randomUUID()}`;
  let held: PromiseWithResolvers<void> | undefined;
  let readStarted: PromiseWithResolvers<void> | undefined;
  const firstTabClient: StoreClient = {
    get failure() {
      return client.failure;
    },
    async call<Name extends StoreOperationName>(operation: Name, ...args: StoreArgs[Name]) {
      if (operation === "loadProjects" && held !== undefined) {
        readStarted?.resolve();
        await held.promise;
      }

      return client.call(operation, ...args);
    },
  };
  const first = new LocalProjectStorage({ client: firstTabClient, storeName });
  const second = new LocalProjectStorage({ client, storeName });
  const heard: ExternalProjectChange[] = [];
  const stopFirst = first.onExternalChange((change) => heard.push(change));
  const stopSecond = second.onExternalChange(() => {});

  return {
    client,
    first,
    second,
    heard,
    holdFirstTabReads: () => {
      const hold = Promise.withResolvers<void>();
      held = hold;
      readStarted = Promise.withResolvers<void>();

      return {
        started: readStarted.promise,
        release: () => {
          held = undefined;
          hold.resolve();
        },
      };
    },
    close: () => {
      stopFirst();
      stopSecond();
    },
  };
}

function makeShareLink() {
  return {
    linkId: "123e4567-e89b-42d3-a456-426614174000",
    publishedAt: "2026-10-13T10:00:00.000Z",
  };
}

describe("local persistence", () => {
  it.each(["expiry", "deletion"])("should save another tab's pending edits as Local after %s", async (removal) => {
    const tabs = await makeTabs();
    const project = makeProject();
    await tabs.first.save([project]);
    await tabs.first.writeCloudSync(1, { projectId: project.id, revision: 1, digest: digestCloudProject(project) });
    const actor = createActor(workspaceMachine, { input: { storage: tabs.second } }).start();
    const stop = tabs.second.onExternalChange((change) => actor.send({ type: "projects.merge", ...change }));

    try {
      await waitFor(actor, (snapshot) => snapshot.matches("saved"));
      const edited = editProject(project, undefined, "Pending in the other tab");
      actor.send({ type: "projects.change", projects: [edited] });
      if (removal === "expiry") {
        await tabs.first.removeCloudProjects(1, "keep_unsaved");
      } else {
        await tabs.first.save([]);
      }

      await waitFor(actor, (snapshot) => snapshot.matches("saved"));

      const stored = await tabs.client.call("loadProjects");
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ name: `${edited.name} copy`, manifest: edited.manifest });
      expect(stored[0]?.id).not.toBe(project.id);
      const rows = await tabs.first.loadCloudSync(1);
      expect(rows).toHaveLength(removal === "expiry" ? 0 : 1);
      expect(rows.some((row) => row.projectId === stored[0]?.id)).toBe(false);
      expect(actor.getSnapshot().context.projects).toEqual(stored);
    } finally {
      stop();
      actor.stop();
      tabs.close();
    }
  });

  it("should preserve a pending save that discovers removal before the deletion notification arrives", async () => {
    const { client, database } = await createMemoryStore();
    const project = makeProject();
    await client.call("saveProjects", [project], []);
    await client.call("writeCloudSync", 1, { projectId: project.id, revision: 1, digest: digestCloudProject(project) });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const heldClient: StoreClient = {
      get failure() {
        return client.failure;
      },
      async call<Name extends StoreOperationName>(operation: Name, ...args: StoreArgs[Name]) {
        if (operation === "saveProjects") {
          started.resolve();
          await release.promise;
        }

        return client.call(operation, ...args);
      },
    };
    const storage = new LocalProjectStorage({ client: heldClient, storeName: crypto.randomUUID() });
    const actor = createActor(workspaceMachine, { input: { storage } }).start();
    const stop = storage.onExternalChange((change) => actor.send({ type: "projects.merge", ...change }));

    try {
      await waitFor(actor, (snapshot) => snapshot.matches("saved"));
      const edited = editProject(project, undefined, "Pending save");
      actor.send({ type: "projects.change", projects: [edited] });
      actor.send({ type: "save.flush" });
      await started.promise;
      await client.call("removeCloudProjects", 1, "keep_unsaved");
      release.resolve();
      await waitFor(actor, (snapshot) => snapshot.matches("saved"));

      const stored = await client.call("loadProjects");
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ name: `${edited.name} copy`, manifest: edited.manifest });
      expect(stored[0]?.id).not.toBe(project.id);
      expect(await client.call("loadCloudSync", 1)).toEqual([]);
      actor.send({ type: "projects.merge", projects: [], deletedIds: [project.id], knownRevisions: {} });
      expect(actor.getSnapshot().context.projects).toEqual(stored);
    } finally {
      release.resolve();
      stop();
      actor.stop();
      database.close();
    }
  });

  it("should round-trip project records and keep preferences separate", async () => {
    const { storage } = await makeStorage();
    const first = makeProject();

    await storage.save([first]);
    await storage.preference(first.id, "seed.ts");

    expect(await storage.load()).toEqual([first]);
    expect(await storage.preference(first.id)).toBe("seed.ts");
    await storage.save([]);
    expect(await storage.load()).toEqual([]);
  });

  it("should round-trip app settings without touching project file preferences", async () => {
    const { storage } = await makeStorage();
    const first = makeProject();
    await storage.save([first]);
    await storage.preference(first.id, "seed.ts");

    expect(await storage.readSetting("guide-seen")).toBeUndefined();
    await storage.writeSetting("guide-seen", true);
    await storage.writeSetting("progress", { step: 2, skipped: [1] });

    expect(await storage.readSetting("guide-seen")).toBe(true);
    expect(await storage.readSetting("progress")).toEqual({ step: 2, skipped: [1] });
    expect(await storage.preference(first.id)).toBe("seed.ts");
    expect(await storage.load()).toEqual([first]);

    await storage.writeSetting("progress", undefined);
    expect(await storage.readSetting("progress")).toBeUndefined();
  });

  it("should keep a share link and its listing, and delete it with its project", async () => {
    const { storage } = await makeStorage();
    const first = makeProject();
    const link = makeShareLink();
    const listed = {
      ...link,
      description: "Demo",
      listing: { topic: "bug-repros" as const },
    };
    await storage.save([first]);

    expect(await storage.shareLink(first.id)).toBeUndefined();
    await storage.saveShareLink(first.id, link);
    expect(await storage.shareLink(first.id)).toEqual(link);
    await storage.saveShareLink(first.id, listed);
    expect(await storage.shareLink(first.id)).toEqual(listed);
    await storage.saveShareLink(first.id, link);
    expect(await storage.shareLink(first.id)).toEqual(link);

    await storage.save([]);
    expect(await storage.shareLink(first.id)).toBeUndefined();
  });

  it("should read a share link's description and drop a listing on an unknown topic", () => {
    const described = { ...makeShareLink(), description: "Demo", listing: { topic: "bug-repros" } };

    expect(readShareLinkRecord(described)).toEqual(described);
    expect(readShareLinkRecord({ ...described, description: "x".repeat(141) })).toEqual({
      ...makeShareLink(),
      listing: { topic: "bug-repros" },
    });
    expect(readShareLinkRecord({ ...described, listing: { topic: "gossip" } })).toEqual({
      ...makeShareLink(),
      description: "Demo",
    });
  });

  it("should not read a malformed share link", async () => {
    const { client, storage } = await makeStorage();
    const first = makeProject();
    await client.call("writeShareLink", first.id, { ...makeShareLink(), linkId: "not-a-uuid" });

    expect(await storage.shareLink(first.id)).toBeUndefined();
  });

  it("should list readable share links before loading projects and keep valid rows when another is malformed", async () => {
    const { client, storage } = await makeStorage();
    const link = makeShareLink();
    const other = { ...link, linkId: "223e4567-e89b-42d3-a456-426614174000" };
    await storage.saveShareLink("pending-project", link);
    await storage.saveShareLink("owned-project", other);
    await client.call("writeShareLink", "broken-project", { ...link, publishedAt: "yesterday" });

    const found = await storage.listShareLinks();

    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        { projectId: "pending-project", link },
        { projectId: "owned-project", link: other },
      ]),
    );
  });

  it("should forget a deleted share link only while it is still the project's link", async () => {
    const { storage } = await makeStorage();
    const first = makeProject();
    const link = makeShareLink();
    const newer = { ...link, linkId: "223e4567-e89b-42d3-a456-426614174000" };
    await storage.save([first]);
    await storage.preference(first.id, "seed.ts");
    await storage.saveShareLink(first.id, newer);

    await storage.deleteShareLink(first.id, link.linkId);
    expect(await storage.shareLink(first.id)).toEqual(newer);

    await storage.deleteShareLink(first.id, newer.linkId);
    expect(await storage.shareLink(first.id)).toBeUndefined();
    await expect(storage.deleteShareLink(first.id, newer.linkId)).resolves.toBeUndefined();
    expect(await storage.load()).toEqual([first]);
    expect(await storage.preference(first.id)).toBe("seed.ts");
  });

  it("should forget a deleted share link in memory only while it is still the project's link", async () => {
    const storage = new VolatileProjectStorage();
    const link = makeShareLink();
    const newer = { ...link, linkId: "223e4567-e89b-42d3-a456-426614174000" };
    await storage.saveShareLink("project-1", newer);

    await storage.deleteShareLink("project-1", link.linkId);
    expect(await storage.shareLink("project-1")).toEqual(newer);

    await storage.deleteShareLink("project-1", newer.linkId);
    expect(await storage.shareLink("project-1")).toBeUndefined();
  });

  it("should serialize competing saves so the latest revision wins", async () => {
    const { storage } = await makeStorage();
    const first = makeProject();
    const second = editProject(first, undefined, "Latest");

    await Promise.all([storage.save([first]), storage.save([second])]);

    expect(await storage.load()).toEqual([second]);
  });

  it("should keep projects saved by another tab when this one deletes its own", async () => {
    const { client, storage } = await makeStorage();
    const mine = makeProject();
    const theirs = { ...makeProject(), name: "Other tab" };
    await storage.save([mine]);
    await new LocalProjectStorage({ client }).save([theirs]);

    await storage.save([]);

    expect(await storage.load()).toEqual([theirs]);
  });

  it("should keep the newer copy when an older tab saves the same project, and hand that tab the newer one", async () => {
    const tabs = await makeTabs();
    const project = makeProject();
    await tabs.first.save([project]);
    await Promise.all([tabs.first.load(), tabs.second.load()]);

    const firstEdit = editProject(project, undefined, "First tab");
    const secondEdit = editProject(project, undefined, "Second tab");
    await tabs.first.save([firstEdit]);
    await tabs.second.save([secondEdit]);

    expect(await tabs.first.load()).toEqual([firstEdit]);
    expect(tabs.heard[1]).toContainEqual({
      projects: [firstEdit],
      deletedIds: [],
      knownRevisions: { [project.id]: project.revision },
    });
    tabs.close();
  });

  it("should not bring back a project another tab deleted when this tab saves its list", async () => {
    const tabs = await makeTabs();
    const deleted = makeProject();
    const kept = makeProject();
    await tabs.first.save([deleted, kept]);
    await Promise.all([tabs.first.load(), tabs.second.load()]);

    await tabs.first.save([kept]);
    const edited = editProject(kept, undefined, "Edited");
    await tabs.second.save([deleted, edited]);

    expect(await tabs.first.load()).toEqual([edited]);
    tabs.close();
  });

  it("should tell other tabs which projects it saved and deleted", async () => {
    const tabs = await makeTabs();
    const deleted = makeProject();
    await tabs.first.save([deleted]);
    await Promise.all([tabs.first.load(), tabs.second.load()]);

    const added = makeProject();
    await tabs.first.save([added]);

    await vi.waitFor(() =>
      expect(tabs.heard[1]).toContainEqual({
        projects: [added],
        deletedIds: [deleted.id],
        knownRevisions: { [deleted.id]: deleted.revision },
      }),
    );
    expect(tabs.heard[0]).toEqual([]);
    tabs.close();
  });

  it("should tell other tabs about a save from a storage that does not listen itself", async () => {
    const { client } = await createMemoryStore();
    const storeName = `tabs-${crypto.randomUUID()}`;
    const workspace = new LocalProjectStorage({ client, storeName });
    const heard: ExternalProjectChange[] = [];
    const stop = workspace.onExternalChange((change) => heard.push(change));
    await workspace.load();
    const forkStorage = new LocalProjectStorage({ client, storeName });
    const forked = makeProject();

    await forkStorage.save([...(await forkStorage.load()), forked]);

    await vi.waitFor(() => expect(heard).toContainEqual({ projects: [forked], deletedIds: [], knownRevisions: {} }));
    stop();
  });

  it("should write only the projects that changed since the last save", async () => {
    const { client, storage } = await makeStorage();
    const unchanged = makeProject();
    const changed = makeProject();
    await storage.save([unchanged, changed]);
    const call = vi.spyOn(client, "call");

    const edited = editProject(changed, undefined, "Edited");
    await storage.save([unchanged, edited]);

    expect(call).toHaveBeenCalledWith("saveProjects", [edited], [], { [changed.id]: changed.revision });
  });

  it("should save a trust change on its own, so a reload keeps it", async () => {
    const { client, storage } = await makeStorage();
    const fork = transitionProjectTrust(toCommunityProject(makeProject()), { type: "project.trust" });
    await storage.save([fork]);

    await storage.save([transitionProjectTrust(fork, { type: "project.untrust" })]);

    const [reloaded] = await new LocalProjectStorage({ client }).load();
    expect(reloaded?.trust).toBe("untrusted");
  });

  it("should not let a tab overwrite a save another tab made after it last read the project", async () => {
    const tabs = await makeTabs();
    const project = makeProject();
    await tabs.first.save([project]);
    await tabs.second.load();

    await tabs.second.save([editProject(project, undefined, "Second tab")]);
    const ahead = editProject(editProject(project, undefined, "First"), undefined, "First tab");
    await tabs.first.save([ahead]);

    const [stored] = await tabs.client.call("loadProjects");
    expect(stored?.name).toBe("Second tab");
    tabs.close();
  });

  it("should not let a save queued behind another tab's reload write over that tab's copy", async () => {
    const tabs = await makeTabsWithHeldReads();
    const project = makeProject();
    await tabs.first.save([project]);
    await tabs.second.load();

    const reading = tabs.holdFirstTabReads();
    await tabs.second.save([editProject(project, undefined, "Second tab")]);
    await reading.started;
    const saving = tabs.first.save([editProject(project, undefined, "First tab")]);
    reading.release();
    await saving;

    const [stored] = await tabs.client.call("loadProjects");
    expect(stored?.name).toBe("Second tab");
    await vi.waitFor(() => expect(tabs.heard.at(-1)?.projects).toMatchObject([{ name: "Second tab" }]));
    tabs.close();
  });

  it("should not bring back a project another tab deleted while this tab's save waited behind the reload", async () => {
    const tabs = await makeTabsWithHeldReads();
    const project = makeProject();
    await tabs.first.save([project]);
    await tabs.second.load();

    const reading = tabs.holdFirstTabReads();
    await tabs.second.save([]);
    await reading.started;
    const saving = tabs.first.save([editProject(project, undefined, "Edited after the delete")]);
    reading.release();
    await saving;

    expect(await tabs.client.call("loadProjects")).toEqual([]);
    tabs.close();
  });

  it("should not bring back a project another tab deleted while this tab's save waited", async () => {
    const tabs = await makeTabs();
    const project = makeProject();
    await tabs.first.save([project]);
    await tabs.second.load();

    await tabs.second.save([]);
    await tabs.first.save([editProject(project, undefined, "Edited after the delete")]);

    expect(await tabs.client.call("loadProjects")).toEqual([]);
    await vi.waitFor(() => expect(tabs.heard[0].at(-1)?.deletedIds).toEqual([project.id]));
    tabs.close();
  });

  it("should merge another tab's projects by revision, keeping newer copies here and dropping deleted ones", () => {
    const older = makeProject();
    const newerHere = editProject(makeProject(), undefined, "Typed here");
    const deleted = makeProject();
    const updated = editProject(older, undefined, "Saved elsewhere");
    const staleCopy = { ...newerHere, name: "Older elsewhere", revision: newerHere.revision - 1 };
    const added = makeProject();

    const merged = mergeExternalProjects([older, newerHere, deleted], {
      projects: [updated, staleCopy, added],
      deletedIds: [deleted.id],
      knownRevisions: {
        [older.id]: older.revision,
        [newerHere.id]: staleCopy.revision,
        [deleted.id]: deleted.revision,
      },
    });

    expect(merged).toEqual({ projects: [updated, newerHere, added], replaced: [], recovered: [] });
  });

  it("should take the store's copy when both tabs edited one revision, and say this tab's edits were replaced", () => {
    const project = makeProject();
    const theirs = editProject(project, undefined, "Other tab");
    const mine = editProject(project, undefined, "This tab");
    const sameAsMine = { ...mine, updatedAt: new Date(0).toISOString() };
    const knownRevisions = { [project.id]: project.revision };

    expect(mergeExternalProjects([mine], { projects: [theirs], deletedIds: [], knownRevisions })).toEqual({
      projects: [theirs],
      replaced: [{ id: project.id, name: "This tab" }],
      recovered: [],
    });
    expect(mergeExternalProjects([mine], { projects: [sameAsMine], deletedIds: [], knownRevisions })).toEqual({
      projects: [mine],
      replaced: [],
      recovered: [],
    });
  });

  it("should give way to a revision another tab saved over this tab's unsaved edits, and keep them otherwise", () => {
    const project = makeProject();
    const mine = editProject(editProject(project, undefined, "Edit"), undefined, "Two edits here");
    const theirs = editProject(project, undefined, "One edit elsewhere");
    const echo = { ...project };

    expect(
      mergeExternalProjects([mine], {
        projects: [theirs],
        deletedIds: [],
        knownRevisions: { [project.id]: project.revision },
      }),
    ).toEqual({ projects: [theirs], replaced: [{ id: project.id, name: "Two edits here" }], recovered: [] });
    expect(
      mergeExternalProjects([mine], {
        projects: [echo],
        deletedIds: [],
        knownRevisions: { [project.id]: project.revision },
      }),
    ).toEqual({ projects: [mine], replaced: [], recovered: [] });
  });

  it("should keep the replaced notice in the workspace until it is dismissed", async () => {
    const project = makeProject();
    const actor = createActor(workspaceMachine, {
      input: { storage: { load: async () => [project], save: vi.fn().mockResolvedValue(undefined) } },
    }).start();
    await waitFor(actor, (state) => state.matches("saved"));

    const mine = editProject(project, undefined, "This tab");
    actor.send({ type: "projects.change", projects: [mine] });
    actor.send({
      type: "projects.merge",
      projects: [editProject(project, undefined, "Other tab")],
      deletedIds: [],
      knownRevisions: { [project.id]: project.revision },
    });

    expect(actor.getSnapshot().context.replaced).toEqual([{ id: project.id, name: "This tab" }]);

    actor.send({ type: "replaced.dismiss" });

    expect(actor.getSnapshot().context.replaced).toEqual([]);
    actor.stop();
  });

  it("should merge another tab's change into the workspace without saving it again", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const project = makeProject();
    const actor = createActor(workspaceMachine, { input: { storage: { load: async () => [project], save } } }).start();
    await waitFor(actor, (state) => state.matches("saved"));

    const updated = editProject(project, undefined, "Saved elsewhere");
    actor.send({
      type: "projects.merge",
      projects: [updated],
      deletedIds: [],
      knownRevisions: { [project.id]: project.revision },
    });

    expect(actor.getSnapshot().context.projects).toEqual([updated]);
    expect(actor.getSnapshot().matches("saved")).toBe(true);
    expect(save).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should leave invalid stored records untouched and count them as recoverable", async () => {
    const { client, storage } = await makeStorage();
    const invalid = {
      version: 1,
      id: "invalid-project",
      name: "Broken",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
      manifest: { kind: "drizzle-run", files: {} },
      trust: "trusted" as const,
    };
    await client.call("saveProjects", [invalid], []);

    expect(await storage.load()).toEqual([]);
    expect(storage.recoverableCount).toBe(1);
    expect(storage.getRecoverableRecords()).toEqual([invalid]);
    expect(storage.listUnopenableProjectIds()).toEqual(["invalid-project"]);
    await storage.save([]);
    expect(await client.call("loadProjects")).toEqual([invalid]);
  });

  it("should load a project on an older Legacy version on the Legacy pair", async () => {
    const { client, storage } = await makeStorage();
    const older = { ...makeProject(), name: "Older Legacy" };
    await client.call(
      "saveProjects",
      [
        {
          ...older,
          manifest: { ...older.manifest, dependencies: { "drizzle-orm": "0.44.0", "drizzle-kit": "0.30.0" } },
        },
      ],
      [],
    );

    expect(await storage.load()).toMatchObject([
      { id: older.id, manifest: { dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" } } },
    ]);
    expect(storage.getRetiredPairProjects()).toEqual([]);
  });

  it("should list a project on a removed pair for a new release instead of hiding it", async () => {
    const { client, storage } = await makeStorage();
    const current = makeProject();
    const retired = { ...makeProject(), name: "Old pair" };
    const stored = {
      ...retired,
      manifest: { ...retired.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
    };
    await client.call("saveProjects", [stored], []);
    await storage.save([current]);

    expect(await storage.load()).toEqual([current]);
    expect(storage.recoverableCount).toBe(0);
    expect(storage.getRetiredPairProjects()).toMatchObject([
      { id: retired.id, name: "Old pair", releases: [{ ormVersion: "1.0.0-rc.3" }] },
    ]);
    expect(storage.listUnopenableProjectIds()).toEqual([retired.id]);

    await storage.save([current]);
    expect(await client.call("loadProjects")).toContainEqual(stored);
  });

  it("should open a project on a removed pair once this tab saves it on a new release", async () => {
    const { client, storage } = await makeStorage();
    const retired = makeProject();
    await client.call(
      "saveProjects",
      [
        {
          ...retired,
          manifest: { ...retired.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
        },
      ],
      [],
    );
    await storage.load();
    const [question] = storage.getRetiredPairProjects();

    if (question === undefined) {
      throw new Error("Expected the project on a removed pair to be asked about.");
    }

    await storage.save([chooseRelease(question, [{ tupleId: getRecommendedTuple({ dialect: "sqlite" }).id }])]);

    expect(storage.getRetiredPairProjects()).toEqual([]);
    expect(storage.listUnopenableProjectIds()).toEqual([]);
  });

  it("should list a project another tab saved in a shape this tab cannot open as unopenable", async () => {
    const tabs = await makeTabs();
    const retired = { ...makeProject(), name: "Removed pair" };
    await tabs.second.load();

    await tabs.client.call(
      "saveProjects",
      [
        {
          ...retired,
          manifest: { ...retired.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
        },
      ],
      [],
    );
    announceStoreChange(tabs.storeName, { ids: [retired.id], deletedIds: [] });

    await vi.waitFor(() => expect(tabs.second.listUnopenableProjectIds()).toEqual([retired.id]));
    tabs.close();
  });

  it("should stop listing a project set aside on a reload once another tab deletes it", async () => {
    const tabs = await makeTabs();
    const project = makeProject();
    await tabs.second.load();

    await tabs.client.call("saveProjects", [{ ...project, manifest: { kind: "drizzle-run", files: {} } }], []);
    announceStoreChange(tabs.storeName, { ids: [project.id], deletedIds: [] });
    await vi.waitFor(() => expect(tabs.second.recoverableCount).toBe(1));

    await tabs.client.call("saveProjects", [], [project.id]);
    announceStoreChange(tabs.storeName, { ids: [], deletedIds: [project.id] });

    await vi.waitFor(() => expect(tabs.second.recoverableCount).toBe(0));
    expect(tabs.second.getRecoverableRecords()).toEqual([]);
    expect(tabs.second.listUnopenableProjectIds()).toEqual([]);
    tabs.close();
  });

  it("should open a project set aside on a reload once another tab saves it in a shape this tab reads", async () => {
    const tabs = await makeTabs();
    const project = makeProject();
    await tabs.second.load();

    await tabs.client.call("saveProjects", [{ ...project, manifest: { kind: "drizzle-run", files: {} } }], []);
    announceStoreChange(tabs.storeName, { ids: [project.id], deletedIds: [] });
    await vi.waitFor(() => expect(tabs.second.recoverableCount).toBe(1));

    await tabs.client.call("saveProjects", [{ ...project, revision: project.revision + 1 }], []);
    announceStoreChange(tabs.storeName, { ids: [project.id], deletedIds: [] });

    await vi.waitFor(() => expect(tabs.heard[1].at(-1)?.projects.map((heard) => heard.id)).toEqual([project.id]));
    expect(tabs.second.recoverableCount).toBe(0);
    expect(tabs.second.listUnopenableProjectIds()).toEqual([]);
    tabs.close();
  });

  it("should stop asking about a removed-pair project another tab moved, then deleted", async () => {
    const tabs = await makeTabs();
    const retired = { ...makeProject(), name: "Old pair" };
    await tabs.client.call(
      "saveProjects",
      [
        {
          ...retired,
          manifest: { ...retired.manifest, dependencies: { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" } },
        },
      ],
      [],
    );
    await Promise.all([tabs.first.load(), tabs.second.load()]);
    const [question] = tabs.first.getRetiredPairProjects();

    if (question === undefined) {
      throw new Error("Expected the removed-pair project to be asked about.");
    }

    await tabs.first.save([chooseRelease(question, [{ tupleId: getRecommendedTuple({ dialect: "sqlite" }).id }])]);
    await vi.waitFor(() => expect(tabs.heard[1]).toHaveLength(1));

    expect(tabs.second.getRetiredPairProjects()).toEqual([]);

    await tabs.first.save([]);
    await vi.waitFor(() => expect(tabs.heard[1]).toHaveLength(2));

    expect(tabs.second.getRetiredPairProjects()).toEqual([]);
    tabs.close();
  });

  it("should keep edits arriving during a save and immediately writes the newer revision", async () => {
    let finish: (() => void) | undefined;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const actor = createActor(workspaceMachine, { input: { storage: { load: async () => [], save } } }).start();
    await waitFor(actor, (state) => state.matches("saved"));
    const first = makeProject();
    actor.send({ type: "projects.change", projects: [first] });
    await waitFor(actor, (state) => state.matches("saving"));
    const next = editProject(first, undefined, "New edit");
    actor.send({ type: "projects.change", projects: [next] });
    finish?.();
    await waitFor(actor, (state) => state.matches("saved"));
    expect(save.mock.calls.map((call) => call[0])).toEqual([[first], [next]]);
    actor.stop();
  });

  it("should write pending edits at once on a flush instead of waiting for the save delay", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const actor = createActor(workspaceMachine, { input: { storage: { load: async () => [], save } } }).start();
    await waitFor(actor, (state) => state.matches("saved"));
    const first = makeProject();
    actor.send({ type: "projects.change", projects: [first] });
    expect(actor.getSnapshot().matches("debouncing")).toBe(true);

    actor.send({ type: "save.flush" });
    expect(actor.getSnapshot().matches("saving")).toBe(true);
    expect(save).toHaveBeenCalledWith([first]);
    await waitFor(actor, (state) => state.matches("saved"));

    actor.send({ type: "save.flush" });
    expect(actor.getSnapshot().matches("saved")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("should post a save to the store within microtasks, so pagehide can still write", async () => {
    const posted: unknown[] = [];
    const recordingPort: StorePort = {
      postMessage: (request) => posted.push(request),
      addEventListener: () => {},
    };
    const storage = new LocalProjectStorage({ client: createStoreClient(recordingPort) });
    const first = makeProject();

    void storage.save([first]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toMatchObject([{ operation: "saveProjects", args: [[first], [], {}] }]);
  });

  it("should reject pending and later calls once the store worker fails to start", async () => {
    let reportError: ((event: Event) => void) | undefined;
    const failingPort: StorePort = {
      postMessage: () => {},
      addEventListener(type, listener: ((event: MessageEvent<StoreResponse>) => void) | ((event: Event) => void)) {
        if (type === "error") {
          reportError = listener as (event: Event) => void;
        }
      },
    };
    const client = createStoreClient(failingPort);
    const pending = client.call("loadProjects");

    reportError?.(new Event("error"));

    await expect(pending).rejects.toThrow("Local storage is unavailable");
    await expect(client.call("readSetting", "guide-seen")).rejects.toThrow("Local storage is unavailable");
    expect(client.failure).toBeInstanceOf(Error);
  });

  it("should recover load/save errors without losing in-memory edits", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("load failed")).mockResolvedValue([]);
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const actor = createActor(workspaceMachine, { input: { storage: { load, save } } }).start();
    await waitFor(actor, (state) => state.matches("loadError"));
    actor.send({ type: "store.retry" });
    await waitFor(actor, (state) => state.matches("saved"));
    const first = makeProject();
    actor.send({ type: "projects.change", projects: [first] });
    await waitFor(actor, (state) => state.matches("saveError"));
    const next = editProject(first, undefined, "Unsaved content");
    actor.send({ type: "projects.change", projects: [next] });
    expect(actor.getSnapshot().context.projects).toEqual([next]);
    actor.send({ type: "store.retry" });
    await waitFor(actor, (state) => state.matches("saved"));
    expect(save).toHaveBeenLastCalledWith([next]);
    actor.stop();
  });
});
