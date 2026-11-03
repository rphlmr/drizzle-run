import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../../test/store/memory-store";
import { createProject } from "../project/projects";
import { LocalProjectStorage, VolatileProjectStorage } from "../store/storage";
import { findGuide, GUIDE_SEEN_SETTING } from "./catalog";
import { FIRST_PROJECT_NAME, resolveFirstProject } from "./first-project";

describe("resolveFirstProject", () => {
  it("should create the guided first project on the first click", async () => {
    const settings = new VolatileProjectStorage();

    const first = await resolveFirstProject(settings, [], "postgresql");

    expect(first).toMatchObject({ guideSlug: "first-run", created: true, project: { name: FIRST_PROJECT_NAME } });
    expect(first?.project.source).toEqual({ kind: "guide", id: findGuide("first-run")?.id });
  });

  it("should reopen the same project on the next click instead of creating another", async () => {
    const settings = new VolatileProjectStorage();
    const first = await resolveFirstProject(settings, [], "sqlite");

    const again = await resolveFirstProject(settings, first ? [first.project] : [], "sqlite");

    expect(again).toMatchObject({ guideSlug: "first-run-sqlite", created: false });
    expect(again?.project.id).toBe(first?.project.id);
  });

  it("should find the remembered project in the store while the workspace list is still loading", async () => {
    const settings = new VolatileProjectStorage();
    const first = await resolveFirstProject(settings, [], "sqlite");

    if (first === undefined) {
      throw new Error("Expected the first project.");
    }

    const storage = {
      readSetting: (key: string) => settings.readSetting(key),
      writeSetting: (key: string, value: unknown) => settings.writeSetting(key, value),
      readProject: (id: string) => Promise.resolve(id === first.project.id ? first.project : null),
    };
    const again = await resolveFirstProject(storage, [], "sqlite");

    expect(again).toMatchObject({ created: false, project: { id: first.project.id } });
  });

  it("should leave this tab's save alone when it finds the project in the store", async () => {
    const { client } = await createMemoryStore();
    const thisTab = new LocalProjectStorage({ client });
    const otherTab = new LocalProjectStorage({ client });
    const mine = createProject("Mine", { dialect: "sqlite" });
    const theirs = createProject("Theirs", { dialect: "sqlite" });
    await thisTab.load();
    await thisTab.save([mine]);
    await otherTab.save([theirs]);
    await thisTab.writeSetting("first-project:sqlite", theirs.id);

    const found = await resolveFirstProject(thisTab, [mine], "sqlite");
    await thisTab.save([mine]);

    expect(found?.project.id).toBe(theirs.id);
    expect((await otherTab.load()).map((project) => project.id).toSorted()).toEqual([mine.id, theirs.id].toSorted());
  });

  it("should create a new one when the remembered project was deleted", async () => {
    const settings = new VolatileProjectStorage();
    const first = await resolveFirstProject(settings, [], "postgresql");

    const again = await resolveFirstProject(settings, [], "postgresql");

    expect(again?.created).toBe(true);
    expect(again?.project.id).not.toBe(first?.project.id);
  });

  it("should leave the starter to a plain project once a guide was seen", async () => {
    const settings = new VolatileProjectStorage();
    await settings.writeSetting(GUIDE_SEEN_SETTING, true);

    await expect(resolveFirstProject(settings, [], "postgresql")).resolves.toBeUndefined();
  });
});
