import type { ProjectSource } from "@drizzle-run/core/contracts";
import type { GuideLink } from "@drizzle-run/core/guide";

import { listExampleVersions, type OfficialExample } from "../examples/catalog";
import { DOCS_ORIGIN, NOTES_ORIGIN, type ExampleLink } from "../examples/source";
import { listGuideVersions, type GuideVersion } from "../guides/catalog";
import { pickShown, SHOWS_DRAFTS } from "./versions";

/** One link of a project's docs: external docs or notes, another official example, or any other page. */
export interface DocsLink {
  kind: "docs" | "notes" | "example" | "link";
  label: string;
  /** An https URL, or a path in Drizzle Run for an example. */
  href: string;
}

/** The links of one part of what the project was forked from: the example, or one guide step. */
export interface DocsGroup {
  /** "Example", or the step's number and label: "2 · Relations". */
  title: string;
  links: DocsLink[];
}

/**
 * Where the docs' example stands now
 *
 * `same`: its page opens the version the project copied. `newer`: a newer version replaced it. `removed`: no version
 * of its slug shows anymore. `none`: a guide without an example, such as the first run, which has no page.
 */
export type DocsPage =
  | { status: "same"; href: string }
  | { status: "newer"; href: string }
  | { status: "removed" }
  | { status: "none" };

/** The docs a forked project keeps from the official example or guide version it copied. */
export interface ProjectDocs {
  from: ProjectSource["kind"];
  /** The title of the version it was forked from. */
  title: string;
  page: DocsPage;
  /** Each part with links, in order; a link shows once, in the first part that has it. */
  groups: DocsGroup[];
}

/** The official versions the docs are read from: every version, deleted ones included. */
export interface DocsCatalog {
  examples: readonly OfficialExample[];
  guides: readonly GuideVersion[];
  /** Whether drafts show, replacing the published version of their slug. */
  drafts: boolean;
}

function toDocsLink(link: ExampleLink): DocsLink {
  return link.kind === "example"
    ? { kind: "example", label: link.label, href: `/examples/${link.slug}` }
    : { kind: link.kind, label: link.label, href: link.url };
}

function toGuideDocsLink(link: GuideLink): DocsLink {
  if (link.href.startsWith("/")) {
    return { kind: link.href.startsWith("/examples/") ? "example" : "link", label: link.label, href: link.href };
  }

  const origin = URL.parse(link.href)?.origin;
  const kind = origin === DOCS_ORIGIN ? "docs" : origin === NOTES_ORIGIN ? "notes" : "link";

  return { kind, label: link.label, href: link.href };
}

/** Drops each link already shown in an earlier group, then the groups left without links. */
function dropRepeats(groups: readonly DocsGroup[]): DocsGroup[] {
  const seen = new Set<string>();

  return groups
    .map((group) => ({
      ...group,
      links: group.links.filter((link) => {
        if (seen.has(link.href)) {
          return false;
        }

        seen.add(link.href);

        return true;
      }),
    }))
    .filter((group) => group.links.length > 0);
}

/** Where the example's slug opens now, against the version the project copied. */
function resolveDocsPage(
  catalog: DocsCatalog,
  example: OfficialExample | undefined,
  copiedId: string,
  kind: ProjectSource["kind"],
): DocsPage {
  if (example === undefined) {
    return { status: "none" };
  }

  const shown = pickShown(catalog.examples, catalog.drafts).find((item) => item.slug === example.slug);

  if (shown === undefined) {
    return { status: "removed" };
  }

  const shownId = kind === "guide" ? shown.guide?.id : shown.id;
  const href = `/examples/${shown.slug}`;

  return shownId === copiedId ? { status: "same", href } : { status: "newer", href };
}

/**
 * Resolve the docs a forked project keeps
 *
 * Reads the exact version the project was forked from, whatever its status now: the example's links, then each guide
 * step's. Returns null when the project has no source, the version is unknown, or it has no links.
 */
export function resolveProjectDocs(
  source: ProjectSource | undefined,
  catalog: DocsCatalog = { examples: listExampleVersions(), guides: listGuideVersions(), drafts: SHOWS_DRAFTS },
): ProjectDocs | null {
  if (source === undefined) {
    return null;
  }

  const guide = source.kind === "guide" ? catalog.guides.find((item) => item.id === source.id) : undefined;
  const exampleId = source.kind === "example" ? source.id : guide?.example;
  const example = exampleId === undefined ? undefined : catalog.examples.find((item) => item.id === exampleId);

  if (source.kind === "guide" ? guide === undefined : example === undefined) {
    return null;
  }

  const groups = dropRepeats([
    ...(example ? [{ title: "Example", links: example.links.map(toDocsLink) }] : []),
    ...(guide?.manifest.steps ?? []).map((step, index) => ({
      title: `${index + 1} · ${step.label}`,
      links: (step.links ?? []).map(toGuideDocsLink),
    })),
  ]);

  if (groups.length === 0) {
    return null;
  }

  return {
    from: source.kind,
    title: guide?.manifest.title ?? example?.title ?? "",
    page: resolveDocsPage(catalog, example, source.id, source.kind),
    groups,
  };
}
