import type { RunManifestTarget } from "@drizzle-run/core/manifest";

import { createProjectFromManifest, withSource, type ProjectRecord } from "../project/projects";
import type { ProjectReader, SettingStore } from "../store/storage";
import { findGuide, FIRST_RUN_GUIDES, GUIDE_SEEN_SETTING } from "./catalog";

/** The name of the project a home starter creates. */
export const FIRST_PROJECT_NAME = "My first project";

/** Where the first-run project a starter created is remembered, per dialect, so the next click reopens it. */
function getFirstProjectSetting(dialect: RunManifestTarget["dialect"]) {
  return `first-project:${dialect}`;
}

/**
 * The project a home starter opens: the first time, a new "My first project" walked by the
 * first-run guide for its dialect, then that same project while it exists (`created` is false);
 * once any guide ended or a first-run guide was left, undefined, so the starter creates a plain project.
 *
 * `projects` is the workspace's list, which may not have loaded yet right after a page load, so a remembered project
 * missing from it is looked up in the store before a new one is made.
 */
export async function resolveFirstProject(
  storage: SettingStore & ProjectReader,
  projects: readonly ProjectRecord[],
  dialect: RunManifestTarget["dialect"],
): Promise<{ project: ProjectRecord; guideSlug: string; created: boolean } | undefined> {
  const [seen, firstProjectId] = await Promise.all([
    storage.readSetting(GUIDE_SEEN_SETTING).catch(() => false),
    storage.readSetting(getFirstProjectSetting(dialect)).catch(() => undefined),
  ]);
  const guideSlug = FIRST_RUN_GUIDES[dialect];
  const guide = findGuide(guideSlug);

  if (seen === true || !guide) {
    return undefined;
  }

  const existing =
    typeof firstProjectId !== "string"
      ? undefined
      : (projects.find((project) => project.id === firstProjectId) ??
        (await storage.readProject(firstProjectId).catch(() => null)));

  if (existing) {
    return { project: existing, guideSlug, created: false };
  }

  const project = withSource(createProjectFromManifest(FIRST_PROJECT_NAME, guide.project), {
    kind: "guide",
    id: guide.id,
  });

  await storage.writeSetting(getFirstProjectSetting(dialect), project.id).catch(() => undefined);

  return { project, guideSlug, created: true };
}

/** The project's address with its guide open, named by the guide's permanent slug. */
export function getGuidedProjectPath(projectId: string, guideSlug: string) {
  return `/p/${projectId}?${new URLSearchParams({ guide: guideSlug }).toString()}`;
}
