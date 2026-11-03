import { digestCloudProject } from "@drizzle-run/core/contracts";
import { projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import type { ProjectRecord } from "../project/projects";
import type { CloudSyncState } from "../store/storage";
import {
  countStoredCloudProjects,
  createStandaloneSignOutMachine,
  type StandaloneSignOutDependencies,
  type StoredCloudProjects,
} from "./standalone-sign-out-machine";

function makeProject(id: string, query = "export {};\n"): ProjectRecord {
  return {
    version: 1,
    id,
    name: `Project ${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-17T10:00:00.000Z",
    revision: 1,
    trust: "trusted",
    manifest: { ...projectManifest("sqlite"), files: { "schema.ts": "export {};\n", "query.ts": query } },
  };
}

function makeRow(project: ProjectRecord, { revision = 2 }: Partial<CloudSyncState> = {}): CloudSyncState {
  return { projectId: project.id, revision, digest: revision === 0 ? "" : digestCloudProject(project) };
}

describe("countStoredCloudProjects", () => {
  it("should count the Cloud projects kept here, and the ones whose edits the account lacks", async () => {
    const saved = makeProject("saved");
    const edited = makeProject("edited");
    const neverSaved = makeProject("never-saved");
    const projects = new Map<string, ProjectRecord>(
      [saved, makeProject("edited", "edited();\n"), neverSaved].map((project) => [project.id, project]),
    );
    const rows = [makeRow(saved), makeRow(edited), makeRow(neverSaved, { revision: 0 }), makeRow(makeProject("gone"))];

    const counted = await countStoredCloudProjects(
      {
        loadCloudSync: async () => rows,
        readProject: async (id: string) => projects.get(id) ?? null,
      },
      7,
    );

    expect(counted).toEqual({ cloudCount: 3, unsavedCount: 2 });
  });
});

function makeDependencies(stored: StoredCloudProjects) {
  return {
    countCloudProjects: vi.fn<StandaloneSignOutDependencies["countCloudProjects"]>(async () => stored),
    leaveAccount: vi.fn<StandaloneSignOutDependencies["leaveAccount"]>(async () => ({ kind: "signed_out" })),
  };
}

describe("createStandaloneSignOutMachine", () => {
  it("should sign out at once when no Cloud project is kept here", async () => {
    const dependencies = makeDependencies({ cloudCount: 0, unsavedCount: 0 });
    const actor = createActor(createStandaloneSignOutMachine(dependencies)).start();

    actor.send({ type: "sign_out.start", githubId: 7 });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(actor.getSnapshot().value).toBe("idle");
    expect(dependencies.leaveAccount).toHaveBeenCalledWith(
      { githubId: 7, policy: "require_saved" },
      expect.any(AbortSignal),
    );
  });

  it("should ask first, with the unsaved count, then remove every Cloud project before signing out", async () => {
    const dependencies = makeDependencies({ cloudCount: 2, unsavedCount: 1 });
    const actor = createActor(createStandaloneSignOutMachine(dependencies)).start();

    actor.send({ type: "sign_out.start", githubId: 7 });
    const asking = await waitFor(actor, (snapshot) => snapshot.matches("asking"));

    expect(asking.context.unsavedCount).toBe(1);

    actor.send({ type: "sign_out.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(dependencies.leaveAccount).toHaveBeenCalledWith({ githubId: 7, policy: "discard" }, expect.any(AbortSignal));
  });

  it("should keep the session when the owner cancels", async () => {
    const dependencies = makeDependencies({ cloudCount: 1, unsavedCount: 0 });
    const actor = createActor(createStandaloneSignOutMachine(dependencies)).start();

    actor.send({ type: "sign_out.start", githubId: 7 });
    await waitFor(actor, (snapshot) => snapshot.matches("asking"));
    actor.send({ type: "sign_out.cancel" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(dependencies.leaveAccount).not.toHaveBeenCalled();
  });

  it("should say why the projects could not leave, keep the session, and check again on retry", async () => {
    const dependencies = makeDependencies({ cloudCount: 1, unsavedCount: 0 });
    dependencies.leaveAccount.mockRejectedValueOnce(new Error("The store is busy."));
    const actor = createActor(createStandaloneSignOutMachine(dependencies)).start();

    actor.send({ type: "sign_out.start", githubId: 7 });
    await waitFor(actor, (snapshot) => snapshot.matches("asking"));
    actor.send({ type: "sign_out.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));

    expect(actor.getSnapshot().context.error).toBe("The store is busy.");
    expect(dependencies.leaveAccount).toHaveBeenCalledOnce();

    actor.send({ type: "sign_out.retry" });
    await waitFor(actor, (snapshot) => snapshot.matches("asking"));
    actor.send({ type: "sign_out.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(dependencies.leaveAccount).toHaveBeenCalledTimes(2);
  });

  it("should ask again when edits appear after the initial confirmation", async () => {
    const dependencies = makeDependencies({ cloudCount: 1, unsavedCount: 0 });
    dependencies.leaveAccount.mockResolvedValueOnce({ kind: "unsaved", projectIds: ["edited"] });
    const actor = createActor(createStandaloneSignOutMachine(dependencies)).start();
    actor.send({ type: "sign_out.start", githubId: 7 });
    await waitFor(actor, (snapshot) => snapshot.matches("asking"));

    actor.send({ type: "sign_out.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("asking") && snapshot.context.unsavedCount === 1);
    actor.send({ type: "sign_out.confirm" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(dependencies.leaveAccount.mock.calls.map(([input]) => input.policy)).toEqual(["require_saved", "discard"]);
    actor.stop();
  });
});
