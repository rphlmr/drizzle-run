/**
 * The docs a guided chat may read (`read_docs`): official Drizzle pages on orm.drizzle.team
 * and the guide's own sources, nothing else. Pure: the tab fetches, this decides what it may
 * fetch and turns a page into text.
 */

/** The only origin `read_docs` reads official pages from. */
export const DOCS_ORIGIN = "https://orm.drizzle.team";

/** The docs index, a list of every page. */
export const DOCS_INDEX_URL = `${DOCS_ORIGIN}/llms.txt`;

/**
 * Pages are lowercase words joined by hyphens, one or more segments under /docs/ (SQLite pages sit under
 * /docs/sqlite/).
 */
const DOCS_PAGE_PATTERN = /^\/docs(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Longest page text a tool result carries. */
export const DOCS_TEXT_MAX_CHARS = 40_000;

/** What a docs URL points at: the index, an official page, or one of the guide's sources. */
export type DocsUrlKind = "index" | "docs" | "source";

/** The result of `checkDocsUrl`: the URL to fetch, or why it is refused. */
export type DocsUrlCheck = { ok: true; url: string; kind: DocsUrlKind } | { ok: false; message: string };

function createRefusal(message: string): DocsUrlCheck {
  return { ok: false, message };
}

const REFUSAL_REASON = `read_docs reads ${DOCS_ORIGIN}/docs pages, ${DOCS_INDEX_URL}, and the sources this guide lists, nothing else.`;

/** An https URL without credentials, port, or fragment, as text; undefined when it is not one. */
function normalizeHttpsUrl(value: string): string | undefined {
  let url: URL;

  try {
    url = value.startsWith("/") && !value.startsWith("//") ? new URL(value, DOCS_ORIGIN) : new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return undefined;
  }

  url.hash = "";

  return url.href;
}

/**
 * Check whether `read_docs` may fetch a URL
 *
 * Allows a docs page or the index on orm.drizzle.team (no query), or exactly one of `sources` (the guide's https
 * sources and step links). Paths such as `/docs/select` resolve against orm.drizzle.team.
 */
export function checkDocsUrl(input: string, sources: readonly string[]): DocsUrlCheck {
  const href = normalizeHttpsUrl(input.trim());

  if (href === undefined) {
    return createRefusal(`${input} is not an https address. ${REFUSAL_REASON}`);
  }

  const url = new URL(href);
  const listedSources = sources
    .map((source) => normalizeHttpsUrl(source))
    .filter((source): source is string => source !== undefined);

  if (url.origin === DOCS_ORIGIN && url.search === "") {
    const path = url.pathname.replace(/\/$/, "");

    if (path === "/llms.txt") {
      return { ok: true, url: DOCS_INDEX_URL, kind: "index" };
    }

    if (DOCS_PAGE_PATTERN.test(path)) {
      const pageUrl = `${DOCS_ORIGIN}${path}`;

      return { ok: true, url: pageUrl, kind: listedSources.includes(pageUrl) ? "source" : "docs" };
    }
  }

  if (listedSources.includes(href)) {
    return { ok: true, url: href, kind: "source" };
  }

  return createRefusal(`${input} is not allowed. ${REFUSAL_REASON}`);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** A numeric entity's character, or the entity as written when it names no code point. */
function toCodePointCharacter(entity: string, codePoint: number): string {
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (entity, name: string) => {
    const lowerName = name.toLowerCase();

    if (lowerName.startsWith("#x")) {
      return toCodePointCharacter(entity, Number.parseInt(lowerName.slice(2), 16));
    }

    if (lowerName.startsWith("#")) {
      return toCodePointCharacter(entity, Number.parseInt(lowerName.slice(1), 10));
    }

    return HTML_ENTITIES[lowerName] ?? entity;
  });
}

/**
 * Convert a docs page to plain text
 *
 * Returns the text an agent reads: the page's `<main>` (or body), without scripts, styles, navigation, or markup.
 * Code blocks keep their lines. Cut at `DOCS_TEXT_MAX_CHARS`, with `truncated` set.
 */
export function docsText(html: string): { text: string; truncated: boolean } {
  const mainHtml =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const text = decodeHtmlEntities(
    mainHtml
      .replace(/<(script|style|noscript|svg|nav|header|footer|template|button)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|pre|table|tr|blockquote)>/gi, "\n")
      .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n# ")
      .replace(/<\/(td|th)>/gi, " | ")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > DOCS_TEXT_MAX_CHARS) {
    return { text: text.slice(0, DOCS_TEXT_MAX_CHARS), truncated: true };
  }

  return { text, truncated: false };
}
