import type { PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import type { PairSide } from "@drizzle-run/core/pair";
import { describe, expect, it, vi } from "vitest";

import {
  applyDocumentMeta,
  createD1DocumentServices,
  resolveDocumentMeta,
  resolveDocumentRoute,
  isHiddenFromSearch,
  serveRobots,
  serveSitemap,
  type DocumentServices,
} from "./document-meta";
import type { WorkerEnvironment } from "./platform";
import type { SharePageRepository, StoredSharePage } from "./share-page-repository";
import { toSnapshotSummaryJson } from "./snapshot-summary";

const origin = "https://run.test";
const linkId = "123e4567-e89b-42d3-a456-426614174000";
const environment = {} as WorkerEnvironment;
const homeImage = { path: "/og/home.png", alt: "Write a schema. Seed it. Run a query." };

const softDeletes: PlaygroundSnapshot = {
  snapshotVersion: 1,
  name: "Soft deletes",
  manifest: {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "postgresql" },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: { "query.ts": "" },
    entrypoints: { schema: "query.ts" },
  },
};

async function makeSharePage({
  snapshot = softDeletes,
  ...options
}: Partial<Omit<StoredSharePage, "summaryJson">> & { snapshot?: PlaygroundSnapshot } = {}): Promise<StoredSharePage> {
  return {
    summaryJson: await toSnapshotSummaryJson(snapshot),
    description: "Hide deleted rows by default.",
    listingTopic: null,
    ...options,
  };
}

function makeServices(repository: Partial<SharePageRepository>): DocumentServices {
  return {
    sharePages: () => ({
      findSharePage: async () => null,
      listListedLinkIds: async () => [],
      ...repository,
    }),
  };
}

describe("resolveDocumentRoute", () => {
  it("should name every app page, and nothing else", () => {
    expect(resolveDocumentRoute("/")).toEqual({ kind: "home" });
    expect(resolveDocumentRoute("/examples/")).toEqual({ kind: "examples" });
    expect(resolveDocumentRoute("/examples/transactions")).toEqual({ kind: "example", slug: "transactions" });
    expect(resolveDocumentRoute("/community")).toEqual({ kind: "community" });
    expect(resolveDocumentRoute(`/s/${linkId}`)).toEqual({ kind: "share", linkId });
    expect(resolveDocumentRoute("/p/local-project")).toEqual({ kind: "private", path: "/p/local-project" });
    expect(resolveDocumentRoute("/assets/index.js")).toBeNull();
    expect(resolveDocumentRoute("/embed/drizzle-run.js")).toBeNull();
  });
});

describe("resolveDocumentMeta", () => {
  it("should describe an official example from its example.json, and keep an unknown one out of search", async () => {
    expect(
      await resolveDocumentMeta(
        { kind: "example", slug: "drizzle-in-five-minutes" },
        environment,
        createD1DocumentServices(),
      ),
    ).toEqual({
      title: "Drizzle in five minutes · Drizzle Run",
      description: "Create, read, update and delete posts, compare query shapes, then keep related writes together.",
      path: "/examples/drizzle-in-five-minutes",
      indexable: true,
      image: { path: "/og/examples/drizzle-in-five-minutes.png", alt: "Drizzle in five minutes" },
    });
    expect(
      await resolveDocumentMeta({ kind: "example", slug: "nope" }, environment, createD1DocumentServices()),
    ).toMatchObject({
      indexable: false,
      image: homeImage,
    });
  });

  it("should index a share only while it is listed in Community", async () => {
    const listed = makeServices({ findSharePage: async () => makeSharePage({ listingTopic: "playground" }) });
    const unlisted = makeServices({ findSharePage: async () => makeSharePage() });

    expect(await resolveDocumentMeta({ kind: "share", linkId }, environment, listed)).toMatchObject({
      title: "Soft deletes · Drizzle Run",
      description: "Hide deleted rows by default.",
      path: `/s/${linkId}`,
      indexable: true,
      image: {
        path: "/og/shares/playground/postgresql/1.0.0-rc.5.png",
        alt: "A shared Drizzle playground, PostgreSQL 1.0.0-rc.5",
      },
    });
    expect(await resolveDocumentMeta({ kind: "share", linkId }, environment, unlisted)).toMatchObject({
      title: "Soft deletes · Drizzle Run",
      indexable: false,
    });
  });

  it("should fall back to a generic preview for a share without a description, an unknown link, or a D1 failure", async () => {
    const generic = "A Drizzle ORM playground. Open it to read and run its code in your browser.";
    const withoutDescription = makeServices({ findSharePage: async () => makeSharePage({ description: null }) });
    const failing = makeServices({
      findSharePage: async () => {
        throw new Error("D1 is down");
      },
    });
    const route = { kind: "share", linkId } as const;

    expect(await resolveDocumentMeta(route, environment, withoutDescription)).toMatchObject({ description: generic });
    expect(await resolveDocumentMeta(route, environment, makeServices({}))).toEqual({
      title: "Drizzle Run",
      description: generic,
      path: `/s/${linkId}`,
      indexable: false,
      image: { path: "/og/shares/playground.png", alt: "A shared Drizzle playground" },
    });
    expect(await resolveDocumentMeta(route, environment, failing)).toMatchObject({ indexable: false });
  });
});

/** One rc.5 side of a stored side-by-side manifest, on `dialect`. */
function makeStoredSide(dialect: "postgresql" | "sqlite"): PairSide {
  return {
    target: { dialect },
    dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
    files: { "schema.ts": "" },
  };
}

describe("share images", () => {
  it("should use the bug repro image for a share listed as one", async () => {
    const services = makeServices({ findSharePage: async () => makeSharePage({ listingTopic: "bug-repros" }) });
    const bugRepro = {
      path: "/og/shares/bug-repros/postgresql/1.0.0-rc.5.png",
      alt: "A Drizzle bug repro, PostgreSQL 1.0.0-rc.5",
    };

    expect((await resolveDocumentMeta({ kind: "share", linkId }, environment, services)).image).toEqual(bugRepro);
  });

  it("should name each side's database for a side-by-side share on two", async () => {
    const services = makeServices({
      findSharePage: async () =>
        makeSharePage({
          snapshot: {
            snapshotVersion: 1,
            name: "PostgreSQL vs SQLite",
            manifest: {
              kind: "drizzle-run-pair",
              manifestVersion: 1,
              entrypoints: { schema: "schema.ts" },
              files: {},
              sides: [makeStoredSide("sqlite"), makeStoredSide("postgresql")],
            },
          },
        }),
    });

    expect((await resolveDocumentMeta({ kind: "share", linkId }, environment, services)).image).toEqual({
      path: "/og/shares/playground/postgresql-vs-sqlite/1.0.0-rc.5-vs-1.0.0-rc.5.png",
      alt: "A shared Drizzle playground, PostgreSQL 1.0.0-rc.5 vs SQLite 1.0.0-rc.5",
    });
  });
});

describe("applyDocumentMeta", () => {
  it("should point og:image at the page's static image, as a large X card", async () => {
    const appended: string[] = [];
    vi.stubGlobal(
      "HTMLRewriter",
      class {
        on(selector: string, handlers: { element(element: unknown): void }) {
          if (selector === "head") {
            handlers.element({ append: (content: string) => appended.push(content), setInnerContent: () => {} });
          }

          return this;
        }

        transform(response: Response) {
          return response;
        }
      },
    );
    const meta = await resolveDocumentMeta({ kind: "home" }, environment, createD1DocumentServices());
    const page = new Response("<html></html>", { headers: { "content-type": "text/html" } });

    applyDocumentMeta(page, meta, origin);

    const head = appended.join("");
    expect(head).toContain(`<meta property="og:image" content="${origin}/og/home.png"/>`);
    expect(head).toContain(`<meta property="og:image:alt" content="Write a schema. Seed it. Run a query."/>`);
    expect(head).toContain(`<meta property="og:image:width" content="1200"/>`);
    expect(head).toContain(`<meta name="twitter:card" content="summary_large_image"/>`);
    vi.unstubAllGlobals();
  });
});

describe("crawler files", () => {
  it("should keep the API and visitors' own pages out of robots.txt, and point at the sitemap", async () => {
    const robots = await serveRobots(origin, environment).text();

    expect(robots).toBe(
      [
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /embed/",
        "Disallow: /p/",
        "Disallow: /projects",
        "Disallow: /runtime-assets/",
        `Sitemap: ${origin}/sitemap.xml`,
        "",
      ].join("\n"),
    );
  });

  it("should list the public pages, every official example and every listed share", async () => {
    const services = makeServices({ listListedLinkIds: async () => [linkId] });
    const response = await serveSitemap(origin, environment, services);
    const sitemap = await response.text();

    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(sitemap).toContain(`<loc>${origin}/</loc>`);
    expect(sitemap).toContain(`<loc>${origin}/community</loc>`);
    expect(sitemap).toContain(`<loc>${origin}/examples/drizzle-in-five-minutes</loc>`);
    expect(sitemap).toContain(`<loc>${origin}/s/${linkId}</loc>`);
  });
});

describe("sites hidden from search", () => {
  const previewOrigin = "https://drizzle-run.example.workers.dev";

  it("should hide *.workers.dev and any deploy with search indexing off", () => {
    expect(isHiddenFromSearch(previewOrigin, {})).toBe(true);
    expect(isHiddenFromSearch("https://next.drizzle.run", { SEARCH_INDEXING: "off" })).toBe(true);
    expect(isHiddenFromSearch("https://drizzle.run", {})).toBe(false);
    expect(isHiddenFromSearch("https://workers.dev.example.com", {})).toBe(false);
  });

  it.each([
    { siteOrigin: previewOrigin, indexing: {} },
    { siteOrigin: "https://pr-42.example.workers.dev", indexing: { SEARCH_INDEXING: "off" } },
    { siteOrigin: "https://next.drizzle.run", indexing: { SEARCH_INDEXING: "off" } },
  ])(
    "should opt $siteOrigin out of AI crawling while letting search engines read noindex",
    async ({ siteOrigin, indexing }) => {
      const robots = await serveRobots(siteOrigin, { ...environment, ...indexing }).text();

      expect(robots).toBe(
        [
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
        ].join("\n"),
      );
    },
  );

  it("should have no sitemap", async () => {
    const services = makeServices({ listListedLinkIds: async () => [linkId] });
    const response = await serveSitemap(previewOrigin, environment, services);

    expect(response.status).toBe(404);
  });
});
