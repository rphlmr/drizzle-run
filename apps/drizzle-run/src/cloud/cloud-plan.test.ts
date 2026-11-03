import { describe, expect, it } from "vitest";

import type { ProjectRecord } from "../project/projects";
import type { CloudSyncState } from "../store/storage";
import { planCloudSync, type CloudPlanInput, type LocalCloudProject } from "./cloud-plan";
import type { CloudProjectSummary } from "./contract";

const a = "00000000-0000-4000-8000-00000000000a";
const b = "00000000-0000-4000-8000-00000000000b";

function makeLocal(id: string, digest: string, { updatedAt = "2026-10-17T10:00:00.000Z", byteSize = 1_000 } = {}) {
  return { project: { id, updatedAt } as ProjectRecord, digest, byteSize } satisfies LocalCloudProject;
}

function makeCloud(id: string, revision: number, digest: string): CloudProjectSummary {
  return { id, name: id, revision, digest, byteSize: 1_000, updatedAt: "2026-10-17T09:00:00.000Z" };
}

function makeRow(projectId: string, revision: number, digest: string): CloudSyncState {
  return { projectId, revision, digest };
}

function plan(input: Partial<CloudPlanInput>) {
  return planCloudSync({
    local: [],
    cloud: [],
    rows: [],
    unopenable: new Set(),
    maxProjectBytes: 1024 * 1024,
    ...input,
  });
}

describe("planCloudSync", () => {
  it("should leave a project this browser cannot open as it is, on both sides", () => {
    const rows = [makeRow(a, 2, "x")];
    const cloud = [makeCloud(a, 2, "x"), makeCloud(b, 3, "y")];

    expect(plan({ cloud, rows, unopenable: new Set([a, b]) }).steps).toEqual([]);
  });

  it("should leave a Local project alone, and save new Cloud projects newest first", () => {
    const local = [makeLocal(a, "1", { updatedAt: "2026-10-01T00:00:00.000Z" }), makeLocal(b, "2")];

    expect(plan({ local }).steps).toEqual([]);
    expect(plan({ local, rows: [makeRow(a, 0, ""), makeRow(b, 0, "")] }).steps).toEqual([
      { kind: "push", id: b, baseRevision: 0 },
      { kind: "push", id: a, baseRevision: 0 },
    ]);
  });

  it("should bring every Cloud project of the account into a browser that has none", () => {
    expect(plan({ cloud: [makeCloud(a, 3, "x"), makeCloud(b, 1, "y")] }).steps).toEqual([
      { kind: "download", id: a, replace: false },
      { kind: "download", id: b, replace: false },
    ]);
  });

  it("should take a newer cloud revision when this copy did not change", () => {
    expect(
      plan({ local: [makeLocal(a, "old")], cloud: [makeCloud(a, 2, "new")], rows: [makeRow(a, 1, "old")] }).steps,
    ).toEqual([{ kind: "download", id: a, replace: true }]);
  });

  it("should keep the other machine's version as a copy when both sides changed", () => {
    expect(
      plan({ local: [makeLocal(a, "mine")], cloud: [makeCloud(a, 2, "theirs")], rows: [makeRow(a, 1, "old")] }).steps,
    ).toEqual([{ kind: "copy", id: a, revision: 2, digest: "theirs" }]);
  });

  it("should copy nothing when this browser's version is over 1 MB, so the cloud's is never replaced by it", () => {
    const local = [makeLocal(a, "mine", { byteSize: 2 * 1024 * 1024 })];

    expect(plan({ local, cloud: [makeCloud(a, 2, "theirs")], rows: [makeRow(a, 1, "old")] }).steps).toEqual([
      { kind: "too_large", id: a },
    ]);
  });

  it("should take a copy saved again elsewhere at the same revision, and never remove it, after a delete here", () => {
    const row = makeRow(a, 1, "saved before");
    const savedAgain = makeCloud(a, 1, "saved again");

    expect(plan({ local: [makeLocal(a, "saved before")], cloud: [savedAgain], rows: [row] }).steps).toEqual([
      { kind: "download", id: a, replace: true },
    ]);
    expect(plan({ cloud: [savedAgain], rows: [row] }).steps).toEqual([{ kind: "download", id: a, replace: false }]);
  });

  it("should only record the revision when both sides already hold the same content", () => {
    expect(
      plan({ local: [makeLocal(a, "same")], cloud: [makeCloud(a, 4, "same")], rows: [makeRow(a, 1, "old")] }).steps,
    ).toEqual([{ kind: "record", id: a, state: makeRow(a, 4, "same") }]);
  });

  it("should save over the cloud copy it last matched when only this browser changed", () => {
    expect(
      plan({ local: [makeLocal(a, "edited")], cloud: [makeCloud(a, 2, "x")], rows: [makeRow(a, 2, "x")] }).steps,
    ).toEqual([{ kind: "push", id: a, baseRevision: 2, baseDigest: "x" }]);
  });

  it("should remove the cloud copy of a Cloud project deleted here", () => {
    expect(plan({ cloud: [makeCloud(a, 2, "x")], rows: [makeRow(a, 2, "x")] }).steps).toEqual([
      { kind: "remove", id: a, revision: 2, digest: "x" },
    ]);
  });

  it("should forget the row of a Cloud project deleted here before it ever saved", () => {
    expect(plan({ rows: [makeRow(a, 0, "")] }).steps).toEqual([{ kind: "forget", id: a }]);
  });

  it("should take a project removed from the account elsewhere out of this browser too, unless edited here", () => {
    expect(plan({ local: [makeLocal(a, "x")], rows: [makeRow(a, 3, "x")] }).steps).toEqual([
      { kind: "discard", id: a },
    ]);
    expect(plan({ local: [makeLocal(a, "edited")], rows: [makeRow(a, 3, "x")] }).steps).toEqual([
      { kind: "forget", id: a },
    ]);
  });

  it("should keep a Cloud project over 1 MB waiting here", () => {
    expect(
      plan({ local: [makeLocal(a, "big", { byteSize: 2 * 1024 * 1024 })], rows: [makeRow(a, 0, "")] }).steps,
    ).toEqual([{ kind: "too_large", id: a }]);
  });

  it("should never remove an account's cloud copy after another account signed in to this browser", () => {
    const local = [makeLocal(a, "p1")];
    const firstA = plan({ local, rows: [makeRow(a, 0, "")] });
    const thenB = plan({ local, rows: [] });
    const backToA = plan({ local, cloud: [makeCloud(a, 1, "p1")], rows: [makeRow(a, 1, "p1")] });

    expect(firstA.steps).toEqual([{ kind: "push", id: a, baseRevision: 0 }]);
    expect(thenB.steps).toEqual([]);
    expect(backToA.steps).toEqual([]);
  });
});
