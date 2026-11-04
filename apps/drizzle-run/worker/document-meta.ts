import { exampleSummaries } from "./examples.generated";
import { UuidV4Schema } from "./http";
import { readListedSnapshot } from "./listed-snapshot";
import { logWorkerFailure } from "./logger";
import { describeShareImage, resolveShareImageVariant, toShareImagePath, type ShareImageVariant } from "./og-images";
import type { WorkerEnvironment } from "./platform";
import { createD1SharePageRepository, type SharePageRepository } from "./share-page-repository";

const siteName = "Drizzle Run";
const siteDescription =
  "Real Drizzle ORM and Kit run in your browser, with a fresh database on every run. Nothing to install.";
const shareDescription = "A Drizzle ORM playground. Open it to read and run its code in your browser.";
/** The most shares one sitemap lists. Search engines take up to 50,000 URLs per sitemap. */
const maxSitemapShares = 5_000;

/** A page of the app as crawlers and link previews see it. */
export type DocumentRoute =
  | { kind: "home" }
  | { kind: "examples" }
  | { kind: "example"; slug: string }
  | { kind: "community" }
  | { kind: "share"; linkId: string }
  | { kind: "private"; path: string };

/** What a document's head says about it. */
export interface DocumentMeta {
  title: string;
  description: string;
  /** The page's own path, which its canonical and `og:url` name. */
  path: string;
  indexable: boolean;
  image: DocumentImage;
}

/** A link preview image, drawn at build time by scripts/build-og-images.ts (og/cards.ts lists them). */
export interface DocumentImage {
  path: string;
  /** What the image shows, for `og:image:alt`. */
  alt: string;
}

/** What the document routes depend on: the shared page repository. */
export interface DocumentServices {
  sharePages(database: WorkerEnvironment["PLAYGROUNDS"]): SharePageRepository;
}

/** The page services the Worker runs with: D1. */
export function createD1DocumentServices(): DocumentServices {
  return { sharePages: createD1SharePageRepository };
}

const examples = new Map(exampleSummaries.map((example) => [example.slug, example]));

const homeImage: DocumentImage = { path: "/og/home.png", alt: "Write a schema. Seed it. Run a query." };
const genericShareImage = toShareImage({ topic: "playground", runtime: null });

/** The document route a path names; null for a path that is not one of the app's pages. */
export function resolveDocumentRoute(pathname: string): DocumentRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;

  if (path === "/" || path === "/index.html") {
    return { kind: "home" };
  }

  if (path === "/examples") {
    return { kind: "examples" };
  }

  if (path === "/community") {
    return { kind: "community" };
  }

  if (path === "/projects" || /^\/p\/[^/]+$/.test(path)) {
    return { kind: "private", path };
  }

  const example = /^\/examples\/([^/]+)$/.exec(path);

  if (example?.[1] !== undefined) {
    return { kind: "example", slug: example[1] };
  }

  const share = /^\/s\/([^/]+)$/.exec(path);

  return share?.[1] === undefined ? null : { kind: "share", linkId: share[1] };
}

/**
 * Resolve what a document's head says
 *
 * A share is indexable only while it is listed in Community: an unlisted link is private to whoever holds it. An
 * unknown example or link is private. A D1 failure falls back to
 * the generic share preview, so the page still loads. A share's image is drawn for its Community topic, database, and
 * versions, each on its database (og-images.ts), and a page with nothing public to show uses the home image.
 */
export async function resolveDocumentMeta(
  route: DocumentRoute,
  environment: WorkerEnvironment,
  services: DocumentServices,
  request?: Request,
): Promise<DocumentMeta> {
  switch (route.kind) {
    case "home":
      return { title: siteName, description: siteDescription, path: "/", indexable: true, image: homeImage };
    case "examples":
      return {
        title: `Examples · ${siteName}`,
        description:
          "Official Drizzle ORM examples you can run in your browser: queries, schema, transactions and more.",
        path: "/examples",
        indexable: true,
        image: { path: "/og/examples.png", alt: "Official examples" },
      };
    case "community":
      return {
        title: `Community · ${siteName}`,
        description: "Drizzle ORM playgrounds the community shared. Open a copy and run it in your browser.",
        path: "/community",
        indexable: true,
        image: { path: "/og/community.png", alt: "Community shares" },
      };
    case "example": {
      const example = examples.get(route.slug);
      const path = `/examples/${route.slug}`;

      return example === undefined
        ? { title: siteName, description: siteDescription, path, indexable: false, image: homeImage }
        : {
            title: `${example.title} · ${siteName}`,
            description: example.description,
            path,
            indexable: true,
            image: { path: `/og/examples/${route.slug}.png`, alt: example.title },
          };
    }
    case "share":
      return resolveShareMeta(route, environment, services, request);
    case "private":
      return { title: siteName, description: siteDescription, path: route.path, indexable: false, image: homeImage };
  }
}

async function resolveShareMeta(
  route: Extract<DocumentRoute, { kind: "share" }>,
  environment: WorkerEnvironment,
  services: DocumentServices,
  request?: Request,
): Promise<DocumentMeta> {
  const path = `/s/${route.linkId}`;
  const fallback = { title: siteName, description: shareDescription, path, indexable: false, image: genericShareImage };

  if (!UuidV4Schema.safeParse(route.linkId).success) {
    return fallback;
  }

  let page;

  try {
    page = await services.sharePages(environment.PLAYGROUNDS).findSharePage(route.linkId);
  } catch (cause) {
    logWorkerFailure({
      event: "share_preview_failed",
      cause,
      message: "Loading a share page's preview failed",
      request,
      context: { link_id: route.linkId },
    });
    return fallback;
  }

  if (page === null) {
    return fallback;
  }

  const shared = readListedSnapshot(page.summaryJson);

  return {
    title: `${shared.title} · ${siteName}`,
    description: page.description ?? shareDescription,
    path,
    indexable: page.listingTopic !== null,
    image: toShareImage(
      resolveShareImageVariant(
        page.listingTopic ?? "playground",
        [shared.pair, ...(shared.second === null ? [] : [shared.second])].map((pair) => ({
          dialect: pair.dialect,
          ormVersion: pair.orm,
          guestFlavor: pair.guestFlavor,
        })),
      ),
    ),
  };
}

function toShareImage(variant: ShareImageVariant): DocumentImage {
  return { path: toShareImagePath(variant), alt: describeShareImage(variant) };
}

/** The document with its title, description, canonical link, robots rule, and Open Graph and X card tags. */
export function applyDocumentMeta(response: Response, meta: DocumentMeta, origin: string): Response {
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok || !contentType.includes("text/html")) {
    return response;
  }

  const url = new URL(meta.path, origin).href;
  const imageUrl = new URL(meta.image.path, origin).href;
  const tags = [
    `<meta name="description" content="${escapeAttribute(meta.description)}"/>`,
    `<link rel="canonical" href="${escapeAttribute(url)}"/>`,
    ...(meta.indexable ? [] : [`<meta name="robots" content="noindex"/>`]),
    `<meta property="og:site_name" content="${siteName}"/>`,
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:title" content="${escapeAttribute(meta.title)}"/>`,
    `<meta property="og:description" content="${escapeAttribute(meta.description)}"/>`,
    `<meta property="og:url" content="${escapeAttribute(url)}"/>`,
    `<meta property="og:image" content="${escapeAttribute(imageUrl)}"/>`,
    `<meta property="og:image:type" content="image/png"/>`,
    `<meta property="og:image:width" content="1200"/>`,
    `<meta property="og:image:height" content="630"/>`,
    `<meta property="og:image:alt" content="${escapeAttribute(meta.image.alt)}"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
  ];

  const rewritten = new HTMLRewriter()
    .on("title", { element: (element) => element.setInnerContent(meta.title) })
    .on("head", { element: (element) => element.append(tags.join(""), { html: true }) })
    .transform(response);
  const headers = new Headers(rewritten.headers);

  if (!meta.indexable) {
    headers.set("X-Robots-Tag", "noindex");
  }

  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Whether search engines must not index this response's site
 *
 * True on a Cloudflare `*.workers.dev` host, where the Worker answers before, and beside, its own domain, and on every
 * deploy that sets `SEARCH_INDEXING` to `off`: next.drizzle.run and pull request previews
 * (scripts/deploy-environment.ts). Search engines must index only the released domain.
 */
export function isHiddenFromSearch(origin: string, environment: Pick<WorkerEnvironment, "SEARCH_INDEXING">): boolean {
  return environment.SEARCH_INDEXING === "off" || new URL(origin).hostname.endsWith(".workers.dev");
}

/**
 * Answers `GET /robots.txt`: public pages may be crawled, the API and visitors' own pages may not
 *
 * A site hidden from search lets search engines reach its noindex headers, opts out of AI crawling, and has no sitemap.
 */
export function serveRobots(origin: string, environment: Pick<WorkerEnvironment, "SEARCH_INDEXING">): Response {
  if (isHiddenFromSearch(origin, environment)) {
    const body = [
      "User-agent: *",
      "Allow: /",
      "",
      "User-agent: GPTBot",
      "User-agent: OAI-SearchBot",
      "User-agent: Google-Extended",
      "User-agent: ClaudeBot",
      "User-agent: Claude-SearchBot",
      "User-agent: PerplexityBot",
      "Disallow: /",
      "",
    ].join("\n");

    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }

  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /embed/",
    "Disallow: /p/",
    "Disallow: /projects",
    "Disallow: /runtime-assets/",
    `Sitemap: ${new URL("/sitemap.xml", origin).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

/**
 * Answers `GET /sitemap.xml`: the home, Examples, Community, every official example and every listed share
 *
 * A site hidden from search has no sitemap (404), since none of its pages may be indexed.
 */
export async function serveSitemap(
  origin: string,
  environment: WorkerEnvironment,
  services: DocumentServices,
  request?: Request,
): Promise<Response> {
  if (isHiddenFromSearch(origin, environment)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  let listed: string[] = [];

  try {
    listed = await services.sharePages(environment.PLAYGROUNDS).listListedLinkIds(maxSitemapShares);
  } catch (cause) {
    logWorkerFailure({
      event: "sitemap_failed",
      cause,
      message: "Listing the shares for the sitemap failed",
      request,
    });
  }

  const paths = [
    "/",
    "/examples",
    "/community",
    ...[...examples.keys()].toSorted().map((slug) => `/examples/${slug}`),
    ...listed.map((linkId) => `/s/${linkId}`),
  ];
  const urls = paths.map((path) => `  <url><loc>${escapeAttribute(new URL(path, origin).href)}</loc></url>`);
  const body = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...urls,
    `</urlset>`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
