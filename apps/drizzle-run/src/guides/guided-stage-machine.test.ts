import { isPairProject, parseGuideManifest, resolveStep, type GuideManifest } from "@drizzle-run/core/guide";
import { pairSide } from "@drizzle-run/core/pair";
import { projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { createProjectFromManifest, editProject, type OneVersionProject } from "../project/projects";
import { findGuide } from "./catalog";
import { createGuidedStageMachine } from "./guided-stage-machine";

function getPairGuide(): GuideManifest {
  const guide = findGuide("relational-queries");

  if (!guide) {
    throw new Error("Expected the relational-queries guide in the catalog, but got none.");
  }

  return guide;
}

const oneVersionGuide = parseGuideManifest({
  kind: "drizzle-run-guide",
  manifestVersion: 1,
  id: "one-version",
  title: "One version",
  project: projectManifest(),
  steps: [
    {
      type: "walkthrough",
      id: "01-read",
      label: "Read",
      title: "Read the query",
      body: "Run it.",
      focus: { file: "query.ts", lines: [1, 2] },
      run: "required",
    },
    { type: "walkthrough", id: "02-next", label: "Next", title: "Then", body: "Read it.", run: "none" },
  ],
});

const walkedProject = createProjectFromManifest("Guide", projectManifest());

/** The one-version copy a side-by-side guide walks: its first side, as a guided example starts it. */
function getPairWalked(guide: GuideManifest): OneVersionProject {
  if (!isPairProject(guide.project)) {
    throw new Error(`Expected a side-by-side guide, but ${guide.id} starts on one version.`);
  }

  return createProjectFromManifest("Guide", pairSide(guide.project, 0));
}

function startStage(guide: GuideManifest) {
  const errors: string[] = [];
  const writes: OneVersionProject[] = [];
  const editedOutside: string[] = [];
  const machine = createGuidedStageMachine({ writeProject: (project) => writes.push(project) });
  const actor = createActor(machine, { input: { guide, projectName: "Guide" } }).start();
  actor.on("stage.error", ({ message }) => errors.push(message));
  actor.on("stage.edited_outside", (event) => editedOutside.push(event.type));

  return { actor, errors, writes, editedOutside };
}

/** A one-version project with the files of the first-run guide's project at step `index`, or before it. */
function createFirstRunProject(index: number, at: "previous" | "project"): OneVersionProject {
  const guide = getFirstRunGuide();
  const manifest = resolveStep(guide, index)[at];

  if (isPairProject(manifest)) {
    throw new Error(`Expected step ${index} of ${guide.id} on one version, but it is side by side.`);
  }

  return createProjectFromManifest("My first project", manifest);
}

function getFirstRunGuide(): GuideManifest {
  const guide = findGuide("first-run");

  if (!guide) {
    throw new Error("Expected the first-run guide in the catalog, but got none.");
  }

  return guide;
}

function editQuery(project: OneVersionProject, query: string): OneVersionProject {
  return editProject(project, { ...project.manifest, files: { ...project.manifest.files, "query.ts": query } });
}

function showStep(
  actor: ReturnType<typeof startStage>["actor"],
  guide: GuideManifest,
  index: number,
  walked: OneVersionProject = walkedProject,
) {
  const step = guide.steps[index];

  if (step === undefined) {
    throw new Error(`Expected a step at ${index}, but got none.`);
  }

  actor.send({ type: "step.show", index, step, project: resolveStep(guide, index).project, walked });
}

describe("guidedStageMachine", () => {
  it("should build each split step on the one shown before, even when two arrive before a render", () => {
    const guide = getPairGuide();
    const { actor } = startStage(guide);

    showStep(actor, guide, 1, getPairWalked(guide));
    showStep(actor, guide, 2, getPairWalked(guide));
    const { pair, version } = actor.getSnapshot().context;

    expect(version).toBe(2);
    expect(pair?.shown).toEqual(resolveStep(guide, 2).project);
    expect(pair?.project.manifest).toEqual(resolveStep(guide, 2).project);
    expect(pair?.marks.version).toBe(2);
  });

  it("should put a split step's files back over the learner's edits when the guide shows it again", () => {
    const guide = getPairGuide();
    const { actor } = startStage(guide);
    showStep(actor, guide, 0, getPairWalked(guide));
    const shown = actor.getSnapshot().context.pair;

    if (shown === undefined) {
      throw new Error("Expected a split step's stage, but got none.");
    }

    const [path = ""] = Object.keys(shown.project.manifest.files);
    const edited = editProject(shown.project, {
      ...shown.project.manifest,
      files: { ...shown.project.manifest.files, [path]: "// mine\n" },
    });
    actor.send({ type: "pair.edit", project: edited });
    const whileEdited = actor.getSnapshot().context.pair?.project;
    showStep(actor, guide, 0, getPairWalked(guide));

    expect(whileEdited).toBe(edited);
    expect(actor.getSnapshot().context.pair?.project.manifest).toEqual(shown.shown);
    expect(actor.getSnapshot().context.pair?.fileOverride).toEqual({ version: 2, manifest: shown.shown });
  });

  it("should write a one-version step's files and mark its focus, and leave the split stage", () => {
    const { actor, writes } = startStage(oneVersionGuide);

    showStep(actor, oneVersionGuide, 1);
    showStep(actor, oneVersionGuide, 0, editQuery(walkedProject, "select"));
    showStep(actor, oneVersionGuide, 1, writes[0]);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.manifest.files).toEqual(walkedProject.manifest.files);
    expect(actor.getSnapshot().context).toMatchObject({
      version: 3,
      pair: undefined,
      fileOverride: { version: 2, files: walkedProject.manifest.files },
      highlight: { version: 2, file: "query.ts", startLine: 1, endLine: 2 },
    });
  });

  it("should leave a walked project edited outside the guide as it is when the first step arrives", () => {
    const guide = getFirstRunGuide();
    const { actor, writes, editedOutside } = startStage(guide);

    showStep(actor, guide, 1, editQuery(createFirstRunProject(0, "previous"), "// my own work\n"));

    expect(writes).toEqual([]);
    expect(editedOutside).toHaveLength(1);
    expect(actor.getSnapshot().context.version).toBe(0);
  });

  it("should write the step when the guide opens on files it left, such as a step saved before its project", () => {
    const guide = getFirstRunGuide();
    const { actor, writes, editedOutside } = startStage(guide);

    showStep(actor, guide, 2, createFirstRunProject(1, "project"));

    expect(editedOutside).toEqual([]);
    expect(writes[0]?.manifest.files).toEqual(createFirstRunProject(2, "project").manifest.files);
  });

  it("should write nothing and report it when a one-version step's project cannot be built", () => {
    const { actor, errors, writes } = startStage(oneVersionGuide);
    const [step] = oneVersionGuide.steps;
    const project = { ...walkedProject.manifest, files: { "../query.ts": "select" } };

    actor.send({ type: "step.show", index: 0, step, project, walked: walkedProject });

    expect(writes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(actor.getSnapshot().context).toMatchObject({ version: 1, fileOverride: undefined });
  });
});
