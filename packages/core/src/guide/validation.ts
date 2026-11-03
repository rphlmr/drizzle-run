import * as z from "zod/mini";

import { safeParseRunManifest } from "../manifest/validation.ts";
import { isPairManifestLike, safeParsePairManifest } from "../pair/validation.ts";
import {
  createSlugSchema,
  GuideAssistantSchema,
  GuideTextSchema,
  ManifestMetaSchema,
  readField,
  type ManifestMeta,
} from "../shared/models.ts";
import { formatIssuePath, type IssuePath } from "../shared/records.ts";
import { DataRecordSchema } from "../shared/schema.ts";
import { followGuideInPlaceRelease } from "./follow-release.ts";
import type { GuideProject } from "./project.ts";
import { STEP_KINDS, type ReportGuideIssue, type StepKindDefinition } from "./step-kinds.ts";
import {
  GUIDE_MANIFEST_KIND,
  GUIDE_MANIFEST_VERSION,
  type GuideManifest,
  type GuideManifestIssue,
  type GuideStepBase,
  type SafeParseGuideManifestResult,
} from "./types.ts";

/** The guide's own fields; its project and steps are read on their own, since steps replay on the project. */
const GuideFieldsSchema = z.strictObject({
  kind: z.literal(GUIDE_MANIFEST_KIND, `Expected "${GUIDE_MANIFEST_KIND}".`),
  manifestVersion: z.literal(GUIDE_MANIFEST_VERSION, `Expected manifest version ${GUIDE_MANIFEST_VERSION}.`),
  id: createSlugSchema("Guide ids are lowercase words and digits joined by hyphens."),
  title: GuideTextSchema,
  description: z.optional(GuideTextSchema),
  project: z.unknown(),
  steps: z.unknown(),
  assistant: z.optional(GuideAssistantSchema),
  meta: z.optional(ManifestMetaSchema),
});

const GuideStepListSchema = z
  .array(z.unknown(), { error: "Expected a list of steps." })
  .check(z.minLength(1, "A guide needs at least one step."));

type ParsedStep = GuideStepBase & { readonly type: string };

/**
 * Create a guide manifest validator
 *
 * Builds a guide validator over a set of step kinds. Core's own parser uses `STEP_KINDS`; a host adds its own kind
 * with `createGuideManifestParser([...STEP_KINDS, myKind])`, reading shared fields with `readStepBase`. The runtime's
 * guide machine walks only the walkthrough kind, so a host runs its own kinds itself.
 */
export function createGuideManifestParser<Step extends ParsedStep>(
  stepKinds: readonly StepKindDefinition<Step>[],
): (input: unknown) => SafeParseGuideManifestResult<GuideManifest<ManifestMeta, ManifestMeta, Step>> {
  const stepKindsByType = new Map(stepKinds.map((stepKind) => [stepKind.type, stepKind]));

  return (input) => {
    const issues: GuideManifestIssue[] = [];
    const report: ReportGuideIssue = (path, code, message) => issues.push({ path: [...path], code, message });
    const manifestRecord = readField(DataRecordSchema, followGuideInPlaceRelease(input), [], report);

    if (!manifestRecord.success) {
      return { success: false, issues };
    }

    const manifest = manifestRecord.data;
    const version = manifest.manifestVersion;

    if (typeof version === "number" && Number.isInteger(version) && version > GUIDE_MANIFEST_VERSION) {
      report(
        ["manifestVersion"],
        "UNSUPPORTED_VERSION",
        `This guide uses manifest version ${version}; this version of @drizzle-run/core reads up to version ${GUIDE_MANIFEST_VERSION}.`,
      );
      return { success: false, issues };
    }

    const fields = readField(GuideFieldsSchema, manifest, [], report);
    const projectResult = isPairManifestLike(manifest.project)
      ? safeParsePairManifest(manifest.project)
      : safeParseRunManifest(manifest.project);
    let project: GuideProject | undefined;

    if (projectResult.success) {
      project = projectResult.data;
    } else {
      for (const issue of projectResult.issues) {
        report(["project", ...issue.path], issue.code, issue.message);
      }
    }

    const steps: Step[] = [];
    const rawSteps = readField(GuideStepListSchema, manifest.steps, ["steps"], report);

    if (rawSteps.success) {
      const seenStepIds = new Set<string>();
      let currentProject: GuideProject | undefined = project;

      for (const [index, rawStep] of rawSteps.data.entries()) {
        const path: IssuePath = ["steps", index];
        const stepRecord = readField(DataRecordSchema, rawStep, path, report);

        if (!stepRecord.success) {
          currentProject = undefined;
          continue;
        }

        const record = stepRecord.data;
        const stepKind = typeof record.type === "string" ? stepKindsByType.get(record.type) : undefined;

        if (typeof record.type !== "string") {
          report([...path, "type"], "INVALID_TYPE", "Expected a step kind.");
        } else if (stepKind === undefined) {
          report(
            [...path, "type"],
            "UNSUPPORTED_STEP_KIND",
            `Unsupported step kind: ${record.type}. This version knows ${[...stepKindsByType.keys()].join(", ")}.`,
          );
        }

        if (stepKind === undefined) {
          // Later steps build on files this step may change, so they are no longer replayed.
          currentProject = undefined;
          continue;
        }

        const result = stepKind.read(record, { path, project: currentProject, report });

        currentProject = result.project;

        if (typeof record.id === "string") {
          if (seenStepIds.has(record.id)) {
            report([...path, "id"], "DUPLICATE_ID", `Step id ${record.id} is used more than once.`);
          }

          seenStepIds.add(record.id);
        }

        if (result.step !== undefined) {
          steps.push(result.step);
        }
      }
    }

    if (issues.length > 0 || !fields.success || project === undefined) {
      return { success: false, issues };
    }

    const { id, title, description, assistant, meta } = fields.data;

    return {
      success: true,
      data: {
        kind: GUIDE_MANIFEST_KIND,
        manifestVersion: GUIDE_MANIFEST_VERSION,
        id,
        title,
        ...(description === undefined ? {} : { description }),
        project,
        steps,
        ...(assistant === undefined ? {} : { assistant }),
        ...(meta === undefined ? {} : { meta }),
      },
    };
  };
}

/** Validates a guide manifest and returns typed issues instead of throwing. */
export const safeParseGuideManifest: (input: unknown) => SafeParseGuideManifestResult =
  createGuideManifestParser(STEP_KINDS);

/** Thrown by `parseGuideManifest` with every issue found, one per message line. */
export class GuideManifestValidationError extends TypeError {
  readonly issues: readonly GuideManifestIssue[];

  constructor(issues: readonly GuideManifestIssue[]) {
    super(issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"));
    this.name = "GuideManifestValidationError";
    this.issues = issues;
  }
}

/**
 * Parse a guide manifest
 *
 * Throws `GuideManifestValidationError` listing each issue path.
 */
export function parseGuideManifest(input: unknown): GuideManifest {
  const result = safeParseGuideManifest(input);

  if (!result.success) {
    throw new GuideManifestValidationError(result.issues);
  }

  return result.data;
}
