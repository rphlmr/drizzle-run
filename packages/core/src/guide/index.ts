export { defineGuideManifest } from "./define.ts";
export type { GuideManifestDefinition } from "./define.ts";
export { diffRunResults } from "./diff.ts";
export type { ChangedRow, DiffedResult, DisplayChange, RunResultDiff } from "./diff.ts";
export { applyProjectEdits, applyProjectShape, GuideShapeError, isPairProject, projectFiles } from "./project.ts";
export type { GuideProject, GuideShapeChange, GuideShapeFailure } from "./project.ts";
export { resolveStep } from "./resolve.ts";
export type { ResolvableGuideStep, ResolvedGuideStep } from "./resolve.ts";
export { readStepBase, replayEdits, STEP_BASE_FIELDS, STEP_KINDS } from "./step-kinds.ts";
export type { ReportGuideIssue, StepKindDefinition, StepReadContext, StepReadResult } from "./step-kinds.ts";
export {
  createGuideManifestParser,
  GuideManifestValidationError,
  parseGuideManifest,
  safeParseGuideManifest,
} from "./validation.ts";
export { GUIDE_MANIFEST_KIND, GUIDE_MANIFEST_VERSION } from "./types.ts";
export type {
  GuideAssistant,
  GuideEdit,
  GuideFocus,
  GuideLink,
  GuideManifest,
  GuideManifestIssue,
  GuideMerge,
  GuideRunPolicy,
  GuideSplit,
  GuideSplitSide,
  GuideStep,
  GuideStepBase,
  GuideStepKind,
  ManifestMeta,
  SafeParseGuideManifestResult,
  WalkthroughStep,
} from "./types.ts";
export { applyEdits, GUIDE_ASSISTANT_NOTES_MAX, GuideEditError } from "../shared/models.ts";
export type { GuideEditFailure } from "../shared/models.ts";
export { isGuideHref, parseRichText, plainText, RichTextError } from "../shared/rich-text.ts";
export type { RichText, RichTextInline, RichTextParagraph } from "../shared/rich-text.ts";
export { formatIssuePath } from "../shared/records.ts";
