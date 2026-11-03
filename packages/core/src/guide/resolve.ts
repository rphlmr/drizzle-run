import type { GuideEdit, GuideMerge, GuideSplit } from "../shared/models.ts";
import { applyProjectEdits, applyProjectShape, type GuideProject, type GuideShapeChange } from "./project.ts";
import type { GuideStep, GuideStepBase } from "./types.ts";

/**
 * A step of any kind, as `resolveStep` reads it
 *
 * Core's walkthrough and a host's own step kinds change the project through the same optional fields; a kind
 * without them, such as a quiz, leaves the files as they are.
 */
export type ResolvableGuideStep = GuideStepBase & {
  readonly type: string;
  readonly split?: GuideSplit;
  readonly merge?: GuideMerge;
  readonly edits?: readonly GuideEdit[];
};

/** A guide step with the project before and after its edits. */
export interface ResolvedGuideStep<Step = GuideStep> {
  index: number;
  step: Step;
  /** The project before this step: the other shape when the step splits or merges. */
  previous: GuideProject;
  /** The project after this step's split or merge and edits: what the learner sees and runs. */
  project: GuideProject;
}

function getStepShape(step: ResolvableGuideStep): GuideShapeChange {
  return {
    ...(step.split === undefined ? {} : { split: step.split }),
    ...(step.merge === undefined ? {} : { merge: step.merge }),
  };
}

function applyStep(project: GuideProject, step: ResolvableGuideStep): GuideProject {
  return applyProjectEdits(applyProjectShape(project, getStepShape(step)), step.edits ?? []);
}

/**
 * Resolve a guide step
 *
 * Returns the state of the guide at step `index` (0-based): every earlier step's split or merge and edits, then
 * this step's. A step's project may have either shape, whatever the guide starts with. Throws a `RangeError`
 * outside the steps, and a `GuideEditError` or `GuideShapeError` if a step does not apply, which a parsed manifest
 * rules out.
 */
export function resolveStep<Step extends ResolvableGuideStep>(
  manifest: { readonly project: GuideProject; readonly steps: readonly Step[] },
  index: number,
): ResolvedGuideStep<Step> {
  const step = manifest.steps[index];

  if (!Number.isInteger(index) || step === undefined) {
    throw new RangeError(`Step ${index} does not exist; this guide has ${manifest.steps.length} steps.`);
  }

  let previous = manifest.project;

  for (const earlierStep of manifest.steps.slice(0, index)) {
    previous = applyStep(previous, earlierStep);
  }

  return {
    index,
    step,
    previous,
    project: applyStep(previous, step),
  };
}
