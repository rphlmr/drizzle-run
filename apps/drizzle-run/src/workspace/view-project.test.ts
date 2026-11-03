import { getRecommendedTuple } from "@drizzle-run/core/catalog";
import { describe, expect, it } from "vitest";

import { createSideBySideProject, editProject, type SideBySideProject } from "../project/projects";
import { resolveViewProject } from "./view-project";

function makePairProject(): SideBySideProject {
  const target = { dialect: "sqlite" as const };
  const tuple = getRecommendedTuple(target);

  return createSideBySideProject("Pair", [target, target], [tuple.id, tuple.id], "separate");
}

describe("resolveViewProject", () => {
  it("should keep an edit typed since the render over the view's own older save", () => {
    const saved = editProject(makePairProject(), undefined, "Saved");
    const typed = editProject(saved, undefined, "Typed since");

    expect(resolveViewProject({ rendered: saved, current: typed, isOwnSave: true })).toBe(typed);
  });

  it("should take another tab's copy at a lower revision than this tab's edits", () => {
    const project = makePairProject();
    const typedHere = editProject(editProject(project, undefined, "One"), undefined, "Two edits here");
    const theirs = editProject(project, undefined, "One edit elsewhere");

    expect(resolveViewProject({ rendered: theirs, current: typedHere, isOwnSave: false })).toBe(theirs);
  });

  it("should take the view's own save once it caught up, and any other project", () => {
    const project = makePairProject();
    const saved = editProject(project, undefined, "Saved");
    const other = makePairProject();

    expect(resolveViewProject({ rendered: saved, current: saved, isOwnSave: true })).toBe(saved);
    expect(resolveViewProject({ rendered: other, current: saved, isOwnSave: true })).toBe(other);
  });
});
