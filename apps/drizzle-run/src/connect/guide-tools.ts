import { checkDocsUrl, DOCS_INDEX_URL, DOCS_TEXT_MAX_CHARS, docsText, type ToolError } from "@drizzle-run/core/connect";
import { isPairProject, plainText, resolveStep, type GuideLink, type GuideManifest } from "@drizzle-run/core/guide";
import type { PairSideIndex } from "@drizzle-run/core/pair";
import type { GuideStage } from "@drizzle-run/runtime/machines";

import { readStepMeta } from "../guides/catalog";
import { getStepEdits } from "../guides/step-edits";
import { getErrorText } from "../lib/error-text";

/**
 * What a guided chat reads: the guide's step (`get_guide`) and the docs (`read_docs`). The
 * fetch is the tab's: the guide's sources live here, orm.drizzle.team answers any origin,
 * and the agent and the companion keep no web access of their own.
 */

/** A guided view's guide and where the learner is in it. */
export interface ConnectGuide {
  manifest: GuideManifest;
  /** The step open now, 0-based. */
  index: number;
  stage: GuideStage;
}

/** One release pair a guide pins, per side for a side-by-side guide. */
export interface GuidePairRelease {
  side?: PairSideIndex;
  drizzle_orm: string;
  drizzle_kit: string;
}

/** Said in every guided result, so the agent answers for the guide's release. */
export interface GuideResultNote {
  id: string;
  pair: readonly GuidePairRelease[];
  note?: string;
}

/** A fetch the tab makes; `type` is the response's content type, `url` the address it ended at after redirects. */
export type FetchText = (
  url: string,
  signal: AbortSignal,
) => Promise<{ ok: boolean; status: number; type: string; text: string; url?: string }>;

/** Changed lines a step's result carries per file, so one step cannot fill the result. */
const STEP_LINES = 40;

const LEGACY_NOTE =
  "This guide runs Legacy drizzle-orm 0.x. orm.drizzle.team documents v1: read the guide's sources first, and say so when a page describes v1 behavior.";

/** The releases a guide's step runs on: one, or both sides when the step is side by side. */
export function getGuidePair(manifest: GuideManifest, index: number): readonly GuidePairRelease[] {
  const { project } = resolveStep(manifest, Math.min(index, manifest.steps.length - 1));

  if (isPairProject(project)) {
    return project.sides.map((side, sideIndex) => ({
      side: sideIndex === 0 ? 0 : 1,
      drizzle_orm: side.dependencies["drizzle-orm"],
      drizzle_kit: side.dependencies["drizzle-kit"],
    }));
  }

  return [{ drizzle_orm: project.dependencies["drizzle-orm"], drizzle_kit: project.dependencies["drizzle-kit"] }];
}

function hasLegacyRelease(pair: readonly GuidePairRelease[]) {
  return pair.some((release) => release.drizzle_orm.startsWith("0."));
}

/** True when a step of the guide runs a 0.x release, on either side. */
export function isLegacyGuide(manifest: GuideManifest) {
  return manifest.steps.some((_, index) => hasLegacyRelease(getGuidePair(manifest, index)));
}

/** What the guide tools say about the results of the guide's step `index`: its releases, and a 0.x note. */
export function getGuideResultNote(manifest: GuideManifest, index: number): GuideResultNote {
  const pair = getGuidePair(manifest, index);

  return {
    id: manifest.id,
    pair,
    ...(hasLegacyRelease(pair) ? { note: LEGACY_NOTE } : {}),
  };
}

/** The guide's own sources: its assistant sources, then each step's links and assistant sources, without repeats. */
export function listGuideSources(manifest: GuideManifest): readonly GuideLink[] {
  const links = [
    ...(manifest.assistant?.sources ?? []),
    ...manifest.steps.flatMap((step) => [...(step.assistant?.sources ?? []), ...(step.links ?? [])]),
  ].filter((link) => link.href.startsWith("https://"));
  const seen = new Set<string>();

  return links.filter((link) => {
    if (seen.has(link.href)) {
      return false;
    }

    seen.add(link.href);

    return true;
  });
}

/** What `get_guide` returns: the step, what it changes, the steps around it, and the guide's notes for the agent. */
export function describeGuide(guide: ConnectGuide) {
  const { manifest } = guide;
  const finished = guide.stage === "done";
  const index = Math.min(guide.index, manifest.steps.length - 1);
  const step = manifest.steps[index];
  const copy = readStepMeta(manifest, step);
  const changes = getStepEdits(manifest, index).map((edit) => ({
    ...(edit.side === undefined ? {} : { side: edit.side }),
    path: edit.file,
    lines: edit.lines
      .slice(0, STEP_LINES)
      .map((line) => `${line.line} ${line.kind === "removed" ? "-" : "+"} ${line.text}`),
    ...(edit.lines.length > STEP_LINES ? { more_lines: edit.lines.length - STEP_LINES } : {}),
  }));

  return {
    id: manifest.id,
    title: manifest.title,
    ...(manifest.description ? { description: manifest.description } : {}),
    position: finished ? "finished" : `step ${index + 1} of ${manifest.steps.length}`,
    stage: guide.stage,
    step: {
      number: index + 1,
      title: step.title,
      body: step.body,
      summary: plainText(copy.summary),
      ...(copy.changed && (guide.stage === "after" || finished) ? { what_changed: plainText(copy.changed) } : {}),
      run: step.run,
      code_changes: changes,
      ...(step.links?.length ? { links: step.links } : {}),
      ...(step.assistant?.notes ? { notes_for_you: step.assistant.notes } : {}),
    },
    steps: manifest.steps.map((item, position) => ({ number: position + 1, title: item.title })),
    ...(manifest.assistant?.notes ? { notes_for_you: manifest.assistant.notes } : {}),
    sources: listGuideSources(manifest),
    note: "The editor is read-only while the guide runs and the learner presses Run. Explain, and point at lines; do not write the next step's code for them.",
  };
}

function toFailure(code: ToolError["code"], message: string) {
  return { ok: false as const, error: { code, message } };
}

/**
 * `read_docs`: without `url`, the guide's sources and the docs index; with one, the page as
 * text when the allowlist admits it.
 */
export async function readDocs(
  manifest: GuideManifest,
  url: string | undefined,
  { fetchText, signal }: { fetchText: FetchText; signal: AbortSignal },
) {
  const sources = listGuideSources(manifest);

  if (url === undefined) {
    return {
      ok: true as const,
      result: {
        sources,
        index: DOCS_INDEX_URL,
        note: isLegacyGuide(manifest)
          ? `${LEGACY_NOTE} The index lists v1 pages.`
          : "Read a source, or find a page in the index. Pages are https://orm.drizzle.team/docs/<page>, and /docs/sqlite/<page> for SQLite.",
      },
      target: "the guide's sources",
    };
  }

  const checked = checkDocsUrl(
    url,
    sources.map((source) => source.href),
  );

  if (!checked.ok) {
    return { ...toFailure("invalid_input", checked.message), target: url };
  }

  let response: Awaited<ReturnType<FetchText>>;

  try {
    response = await fetchText(checked.url, signal);
  } catch (cause) {
    return {
      ...toFailure("unavailable", `${checked.url} did not load in the tab: ${getErrorText(cause)}`),
      target: checked.url,
    };
  }

  // A redirect must land on an address the allowlist admits too.
  if (
    response.url !== undefined &&
    response.url !== "" &&
    response.url !== checked.url &&
    !checkDocsUrl(
      response.url,
      sources.map((source) => source.href),
    ).ok
  ) {
    return {
      ...toFailure("invalid_input", `${checked.url} redirected to ${response.url}, which read_docs does not read.`),
      target: checked.url,
    };
  }

  if (!response.ok) {
    return {
      ...toFailure(
        response.status === 404 ? "not_found" : "unavailable",
        `${checked.url} answered ${response.status}. The index ${DOCS_INDEX_URL} lists the pages.`,
      ),
      target: checked.url,
    };
  }

  const page = response.type.includes("html")
    ? docsText(response.text)
    : response.text.length > DOCS_TEXT_MAX_CHARS
      ? { text: response.text.slice(0, DOCS_TEXT_MAX_CHARS), truncated: true }
      : { text: response.text, truncated: false };

  return {
    ok: true as const,
    result: { url: checked.url, kind: checked.kind, text: page.text, ...(page.truncated ? { truncated: true } : {}) },
    target: checked.url,
  };
}
