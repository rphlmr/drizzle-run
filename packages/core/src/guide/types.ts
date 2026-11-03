import type { RunManifestIssue } from "../manifest/types.ts";
import type {
  GuideAssistant,
  GuideEdit,
  GuideFocus,
  GuideLink,
  GuideMerge,
  GuideSplit,
  ManifestMeta,
} from "../shared/models.ts";
import type { GuideProject } from "./project.ts";

export type {
  GuideAssistant,
  GuideEdit,
  GuideFocus,
  GuideLink,
  GuideMerge,
  GuideSplit,
  GuideSplitSide,
  ManifestMeta,
} from "../shared/models.ts";

/** The `kind` of a guide manifest. */
export const GUIDE_MANIFEST_KIND = "drizzle-run-guide";

/** The newest guide manifest version this version reads. */
export const GUIDE_MANIFEST_VERSION = 1;

/** Whether the learner must run, may run, or cannot run the code at this step. */
export type GuideRunPolicy = "required" | "optional" | "none";

/** Fields every step kind shares. */
export interface GuideStepBase<StepMeta extends ManifestMeta = ManifestMeta> {
  /** Unique within the guide, such as `01-transfer`. Progress and recorded outputs are keyed by it. */
  readonly id: string;
  /** A short name for the progress rail. */
  readonly label: string;
  readonly title: string;
  /** Rich text source: paragraphs, `code`, **bold**, and [links](https://...). */
  readonly body: string;
  readonly links?: readonly GuideLink[];
  /** Context for an AI agent answering questions on this step; its links count as sources too. */
  readonly assistant?: GuideAssistant;
  /** Consumer-owned; never read by core or the machines. */
  readonly meta?: StepMeta;
}

/** Scripted edits apply when the step starts, the editor stays read-only, and the learner presses Run. */
export interface WalkthroughStep<StepMeta extends ManifestMeta = ManifestMeta> extends GuideStepBase<StepMeta> {
  readonly type: "walkthrough";
  /** Opens two sides from a one-version project when the step starts, before its edits. */
  readonly split?: GuideSplit;
  /** Returns a side-by-side project to one version when the step starts, before its edits. */
  readonly merge?: GuideMerge;
  /** Applied in order when the step starts, after a split or merge. */
  readonly edits?: readonly GuideEdit[];
  readonly focus?: GuideFocus;
  readonly run: GuideRunPolicy;
  /** The display labels "what changed" points at. */
  readonly highlight?: { readonly displays: readonly string[] };
}

/**
 * The closed union of step kinds this version knows. Later kinds (exercise, quiz) are
 * added here; existing kinds and fields never change within a manifest version.
 */
export type GuideStep<StepMeta extends ManifestMeta = ManifestMeta> = WalkthroughStep<StepMeta>;

/** Every step kind this version knows. */
export type GuideStepKind = GuideStep["type"];

/** A guide: a pinned starting project and the steps that walk through it. */
export interface GuideManifest<
  Meta extends ManifestMeta = ManifestMeta,
  StepMeta extends ManifestMeta = ManifestMeta,
  Step extends GuideStepBase<StepMeta> & { readonly type: string } = GuideStep<StepMeta>,
  Project extends GuideProject = GuideProject,
> {
  readonly kind: typeof GUIDE_MANIFEST_KIND;
  readonly manifestVersion: typeof GUIDE_MANIFEST_VERSION;
  /** A slug, such as `transactions`. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /**
   * The starting project: one release pair, or two for a side-by-side guide, whose runs run both sides. A step's
   * `split` or `merge` changes the shape from that step on.
   */
  readonly project: Project;
  readonly steps: readonly Step[];
  /**
   * Context for an AI agent answering questions during the guide, such as `llms.txt` or an upgrade page as
   * sources.
   */
  readonly assistant?: GuideAssistant;
  /** Consumer-owned; never read by core or the machines. */
  readonly meta?: Meta;
}

/** One problem found in a guide manifest, at a path inside it. */
export interface GuideManifestIssue {
  path: readonly (string | number)[];
  code:
    | RunManifestIssue["code"]
    | "UNSUPPORTED_VERSION"
    | "UNSUPPORTED_STEP_KIND"
    | "UNSUPPORTED_CHECK"
    | "DUPLICATE_ID"
    | "EDIT_CONFLICT"
    | "SPLIT_NOT_ONE_VERSION"
    | "MERGE_NOT_PAIR"
    | "SPLIT_AND_MERGE";
  message: string;
}

/** The result of `safeParseGuideManifest`: the manifest, or every issue found. */
export type SafeParseGuideManifestResult<Manifest = GuideManifest> =
  | { success: true; data: Manifest }
  | { success: false; issues: readonly GuideManifestIssue[] };
