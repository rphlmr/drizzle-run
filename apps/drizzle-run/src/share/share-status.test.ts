import { describe, expect, it } from "vitest";

import { createProject, editProject } from "../project/projects";
import type { ShareLinkRecord } from "../store/storage";
import { getShareStatus, resolveProjectDigest } from "./share-status";

function makeRecord(options: Partial<ShareLinkRecord> = {}): ShareLinkRecord {
  return {
    linkId: "123e4567-e89b-42d3-a456-426614174000",
    publishedAt: "2026-10-10T00:00:00.000Z",
    ...options,
  };
}

describe("getShareStatus", () => {
  const project = createProject("Captured", { dialect: "sqlite" });
  const digest = resolveProjectDigest(project);

  it("should read a project without a link as not shared", () => {
    expect(getShareStatus(undefined, digest)).toEqual({ status: "not_shared" });
  });

  it("should read the project as published while it matches the digest its link shows", () => {
    expect(getShareStatus(makeRecord({ publishedDigest: digest }), digest)).toEqual({
      status: "published",
      listed: false,
    });
  });

  it("should say whether the link is listed in Community", () => {
    expect(getShareStatus(makeRecord({ publishedDigest: digest, listing: { topic: "playground" } }), digest)).toEqual({
      status: "published",
      listed: true,
    });
  });

  it("should read an edit since what its link shows as changed", () => {
    const firstFile = Object.entries(project.manifest.files)[0];

    if (firstFile === undefined) {
      throw new Error("Expected the new project to have a file.");
    }

    const [path, source] = firstFile;
    const edited = editProject(project, {
      ...project.manifest,
      files: { ...project.manifest.files, [path]: `${source}\n// edited` },
    });

    expect(getShareStatus(makeRecord({ publishedDigest: digest }), resolveProjectDigest(edited))).toEqual({
      status: "changed",
      listed: false,
    });
  });

  it("should read a link whose published digest is not known yet as published", () => {
    expect(getShareStatus(makeRecord(), digest)).toEqual({
      status: "published",
      listed: false,
    });
  });
});
