import { assertParsedAsWritten } from "../shared/define.ts";
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
import type { GUIDE_MANIFEST_KIND, GUIDE_MANIFEST_VERSION, GuideRunPolicy } from "./types.ts";
import { parseGuideManifest } from "./validation.ts";

type WalkthroughStepDefinition<StepMeta extends ManifestMeta> = {
  type: "walkthrough";
  id: string;
  label: string;
  title: string;
  body: string;
  split?: GuideSplit;
  merge?: GuideMerge;
  edits?: readonly GuideEdit[];
  focus?: GuideFocus;
  run: GuideRunPolicy;
  highlight?: { displays: readonly string[] };
  links?: readonly GuideLink[];
  assistant?: GuideAssistant;
  meta?: StepMeta;
};

/** A guide manifest as written in source, before parsing. */
export type GuideManifestDefinition<
  Meta extends ManifestMeta = ManifestMeta,
  StepMeta extends ManifestMeta = ManifestMeta,
> = {
  kind: typeof GUIDE_MANIFEST_KIND;
  manifestVersion: typeof GUIDE_MANIFEST_VERSION;
  id: string;
  title: string;
  description?: string;
  project: GuideProject;
  steps: readonly WalkthroughStepDefinition<StepMeta>[];
  assistant?: GuideAssistant;
  meta?: Meta;
};

type StepsOf<Manifest> = Manifest extends { steps: readonly (infer Step)[] } ? Step : never;

type ProjectFiles<Manifest> =
  | (Manifest extends { project: { files: infer Files } } ? keyof Files & string : never)
  | (Manifest extends { project: { sides: readonly (infer Side)[] } }
      ? Side extends { files: infer Files }
        ? keyof Files & string
        : never
      : never);

type EditsOf<Step> = Step extends { edits: readonly (infer Edit)[] } ? Edit : never;

type WrittenFiles<Manifest> =
  EditsOf<StepsOf<Manifest>> extends infer Edit
    ? Edit extends { file: infer File extends string; write: string }
      ? File
      : never
    : never;

type ReferencedFiles<Manifest> =
  | (EditsOf<StepsOf<Manifest>> extends infer Edit
      ? Edit extends { file: infer File extends string }
        ? File
        : never
      : never)
  | (StepsOf<Manifest> extends infer Step
      ? Step extends { focus: { file: infer File extends string } }
        ? File
        : never
      : never)
  | (StepsOf<Manifest> extends infer Step
      ? Step extends { split: { files: readonly (infer File extends string)[] } }
        ? File
        : never
      : never);

/**
 * Edits, focus and split files must name a project file or one an edit writes. Order is checked
 * at runtime, where edits are replayed.
 */
type ValidGuideShape<Manifest> =
  Exclude<ReferencedFiles<Manifest>, ProjectFiles<Manifest> | WrittenFiles<Manifest>> extends never ? Manifest : never;

type DefineGuide<Meta extends ManifestMeta, StepMeta extends ManifestMeta> = <
  const Manifest extends GuideManifestDefinition<Meta, StepMeta>,
>(
  manifest: Manifest & ValidGuideShape<Manifest>,
) => Manifest;

/**
 * Define a guide manifest in source
 *
 * Keeps the literal manifest type, checks file references at the type level, and validates everything at runtime.
 * Throws when parsing would change the definition, such as a project on an older Legacy fix release that would follow
 * the current one, so the manifest returned is the one that runs. Call it with no argument to type `meta`:
 * `defineGuideManifest<CourseMeta, LessonMeta>()({ ... })`.
 */
export function defineGuideManifest<
  Meta extends ManifestMeta = ManifestMeta,
  StepMeta extends ManifestMeta = ManifestMeta,
>(): DefineGuide<Meta, StepMeta>;
export function defineGuideManifest<const Manifest extends GuideManifestDefinition>(
  manifest: Manifest & ValidGuideShape<Manifest>,
): Manifest;
export function defineGuideManifest(manifest?: GuideManifestDefinition): unknown {
  const defineChecked = (definition: GuideManifestDefinition) => {
    assertParsedAsWritten(definition, parseGuideManifest(definition), "guide");

    return definition;
  };

  return manifest === undefined ? defineChecked : defineChecked(manifest);
}
