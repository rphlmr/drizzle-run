import { isPairProject, resolveStep, type GuideManifest } from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { pairSide } from "@drizzle-run/core/pair";
import { LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { useParams, useSearchParams, type LoaderFunctionArgs } from "react-router";

import { appServicesContext } from "../app-services";
import { getGuideConversation } from "../connect/conversations";
import { getGuideProgressSetting } from "../guides/catalog";
import { GuidedPlayground } from "../guides/guided-playground";
import { getErrorText } from "../lib/error-text";
import { ProjectView } from "../project/project-view";
import {
  createProjectFromManifest,
  isSideBySide,
  withSource,
  type OneVersionProject,
  type ProjectRecord,
} from "../project/projects";
import { SiteHeader } from "../shell/site-header";
import { SideBySideView } from "../side-by-side/side-by-side-view";
import { VolatileProjectStorage } from "../store/storage";
import { ForkButton } from "../ui/fork-button";
import { KindBadge } from "../ui/kind-badge";
import { SnapshotNote } from "../ui/snapshot-note";
import { useWorkspace } from "../workspace/context";
import { NotFoundPage } from "../workspace/project-page";
import { findExample, findNextGuidedExample, type OfficialExample } from "./catalog";
import { ExampleTitle } from "./example-title";
import { LinkList } from "./link-list";
import { getExampleViewedSetting } from "./progress";

/** Record a local visit when an existing official example is opened, including a direct link. */
export async function loadExamplePage({ params, context }: LoaderFunctionArgs) {
  const example = findExample(params.slug ?? "");

  if (example) {
    const { settings } = context.get(appServicesContext);

    try {
      await settings.writeSetting(getExampleViewedSetting(example.id), new Date().toISOString());
    } catch (cause) {
      console.warn(`Could not save the visit to example ${example.slug}.`, cause);
    }
  }

  return null;
}

/** The `/examples/:slug` page: the example walked by its guide when it has one, else in an editable workspace. */
export function ExamplePage() {
  const { slug = "" } = useParams();
  const example = findExample(slug);

  if (!example) {
    return (
      <>
        <SiteHeader />
        <NotFoundPage title="Example not found" message="There is no official example at this address." />
      </>
    );
  }

  const { guide } = example;

  return guide ? (
    <GuidedExample key={example.id} example={example} guide={guide} />
  ) : (
    <ExampleWorkspace key={example.id} example={example} />
  );
}

/**
 * Read the 0-based step the address names
 *
 * Takes the 1-based step number the page writes, or a step id, which official embeds link to. Returns `undefined` for
 * anything else.
 */
function parseStepParam(value: string | null, guide: GuideManifest): number | undefined {
  if (value !== null && /^[1-9]\d{0,2}$/.test(value)) {
    return Number(value) - 1;
  }

  const index = guide.steps.findIndex((step) => step.id === value);

  return index === -1 ? undefined : index;
}

/**
 * Get the one-version manifest a guide's temporary copy starts from
 *
 * A side-by-side start gives its first side, without the drizzle-seed pin that only a side by side sets.
 */
function toOneVersionStart(project: GuideManifest["project"]): RunManifest {
  if (!isPairProject(project)) {
    return project;
  }

  const { seedGeneratorVersion: _seedGeneratorVersion, ...firstSide } = pairSide(project, 0);

  return firstSide;
}

/** Whether the guide's last step is side by side, so the finished editors show both sides. */
function endsSideBySide(guide: GuideManifest) {
  return isPairProject(resolveStep(guide, guide.steps.length - 1).project);
}

/**
 * A guided example: the guide walks a temporary copy, one step shape at a time, then the code is the reader's to try.
 * Nothing here is saved: a guide's steps may switch between one version and two sides, so no single copy stands for it.
 */
function GuidedExample({ example, guide }: { example: OfficialExample; guide: GuideManifest }) {
  const workspace = useWorkspace();
  const { renderFork, forkBeforeLeaving } = useExampleFork(example);
  const [search, setSearch] = useSearchParams();
  const [storage] = useState(() => new VolatileProjectStorage());
  const [startAt] = useState(() => parseStepParam(search.get("step"), guide));
  const [project, setProject] = useState<OneVersionProject>(() =>
    createProjectFromManifest(example.title, toOneVersionStart(guide.project)),
  );
  const nextExample = findNextGuidedExample(example.slug);

  // Reads the address as it is now: the editor may have written its file since this render.
  const showPosition = (index: number) => {
    const params = new URLSearchParams(window.location.search);
    const value = String(Math.min(index + 1, guide.steps.length));

    if (params.get("step") !== value) {
      params.set("step", value);
      setSearch(params, { replace: true });
    }
  };

  return (
    <GuidedPlayground
      guide={guide}
      project={project}
      update={setProject}
      storage={storage}
      settings={workspace.storage}
      progressKey={getGuideProgressSetting(guide.id)}
      conversation={getGuideConversation(guide.id)}
      startAt={startAt}
      saveState="temporary"
      lockedSaveState="guided_read_only"
      renderFork={renderFork}
      forkBeforeLeaving={forkBeforeLeaving}
      banner={workspace.banners}
      renderLeading={({ index, count, finished }) => (
        <ExampleTitle
          title={example.title}
          badge={
            <>
              <KindBadge tone="lime" header>
                Official
              </KindBadge>
              <KindBadge tone="outline" header>
                Guided
              </KindBadge>
            </>
          }
          phoneStep={finished ? "Guide complete" : `Guide · step ${index + 1} of ${count}`}
        />
      )}
      leave="pause"
      lockedMessage={() => "Read-only while the guide runs. Pause it to experiment."}
      done={{
        text: endsSideBySide(guide)
          ? "Edit either side and run both. Changes here are not saved."
          : "Edit any file and run it. Changes here are not saved.",
        next: nextExample && { title: nextExample.title, href: `/examples/${nextExample.slug}` },
      }}
      onPosition={showPosition}
    />
  );
}

/**
 * "Fork to my projects" for an example: saves the copy on screen, edits included, as the user's own project
 *
 * `renderFork` draws the header button, which opens the fork. `forkBeforeLeaving` saves it from the leave dialog
 * and leaves the page in front.
 */
function useExampleFork(example: OfficialExample) {
  const workspace = useWorkspace();
  const toFork = (project: ProjectRecord) =>
    withSource(createProjectFromManifest(project.name, project.manifest), { kind: "example", id: example.id });

  const renderFork = (project: ProjectRecord) => {
    const fork = () => {
      try {
        workspace.add(toFork(project), { arrival: { kind: "forked", originalHref: `/examples/${example.slug}` } });
      } catch (cause) {
        workspace.reportError(getErrorText(cause));
      }
    };

    return <ForkButton onFork={fork} disabled={workspace.loading} />;
  };
  const forkBeforeLeaving = async (project: ProjectRecord) => {
    workspace.add(toFork(project), { open: false });
  };

  return { renderFork, forkBeforeLeaving };
}

/** An example without a guide, in an editable workspace: one version, or both sides of a side-by-side example. */
function ExampleWorkspace({ example }: { example: OfficialExample }) {
  const workspace = useWorkspace();
  const [storage] = useState(() => new VolatileProjectStorage());
  const [project, setProject] = useState<ProjectRecord>(() =>
    createProjectFromManifest(example.title, example.manifest),
  );

  const { renderFork, forkBeforeLeaving } = useExampleFork(example);

  const view = {
    storage,
    update: setProject,
    saveState: "temporary" as const,
    unsavedCopy: project.revision > 0,
    reportError: workspace.reportError,
    projectActions: false,
    leading: (
      <ExampleTitle
        title={example.title}
        badge={
          <KindBadge tone="lime" header>
            Official
          </KindBadge>
        }
      />
    ),
    fork: renderFork(project),
    forkBeforeLeaving: () => forkBeforeLeaving(project),
    banner: (
      <>
        {workspace.banners}
        <SnapshotNote>
          <LightbulbIcon aria-hidden="true" />
          <span className="text-text">{example.description}</span>
          <span className="text-muted max-phone:hidden">
            Edit anything and press {isSideBySide(project) ? "Run both" : "Run"}. Fork to my projects keeps your
            version.
          </span>
          {example.links.length > 0 && <LinkList links={example.links} />}
        </SnapshotNote>
      </>
    ),
  };

  return isSideBySide(project) ? (
    <SideBySideView project={project} {...view} />
  ) : (
    <ProjectView project={project} {...view} />
  );
}
