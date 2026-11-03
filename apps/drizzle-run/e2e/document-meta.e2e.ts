import { appOrigin, expect, test } from "./fixtures";
import { postSnapshot } from "./publish";

const snapshot = {
  snapshotVersion: 1,
  name: 'Soft deletes <with> "quotes"',
  manifest: {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const users = sqliteTable("users", { id: integer("id").primaryKey() });\n',
      "query.ts": '$.display("Users", []);\n',
    },
  },
};

test("should give each page its own title, description and link preview tags", async ({ request }) => {
  const home = await (await request.get(`${appOrigin}/`)).text();
  expect(home).toContain("<title>Drizzle Run</title>");
  expect(home).toContain(`<link rel="canonical" href="${appOrigin}/"/>`);
  expect(home).not.toContain('name="robots"');

  const example = await (await request.get(`${appOrigin}/examples/drizzle-in-five-minutes`)).text();
  expect(example).toContain("<title>Drizzle in five minutes · Drizzle Run</title>");
  expect(example).toContain(
    '<meta property="og:description" content="Create, read, update and delete posts, compare query shapes, then keep related writes together."/>',
  );

  const project = await request.get(`${appOrigin}/p/local-project`);
  expect(project.headers()["x-robots-tag"]).toBe("noindex");
});

test("should preview an unlisted share with its escaped name and description, out of search", async ({ request }) => {
  const published = await postSnapshot(request, { data: snapshot, description: "Hide deleted rows & keep them." });
  expect(published.ok(), await published.text()).toBe(true);
  const { id }: { id: string } = await published.json();

  const response = await request.get(`${appOrigin}/s/${id}`);
  const page = await response.text();

  expect(page).toContain('<title>Soft deletes &lt;with&gt; "quotes" · Drizzle Run</title>');
  expect(page).toContain(
    '<meta property="og:title" content="Soft deletes &lt;with&gt; &quot;quotes&quot; · Drizzle Run"/>',
  );
  expect(page).toContain('<meta name="description" content="Hide deleted rows &amp; keep them."/>');
  expect(page).toContain('<meta name="robots" content="noindex"/>');
  expect(response.headers()["x-robots-tag"]).toBe("noindex");
});

test("should serve robots.txt and a sitemap of the public pages", async ({ request }) => {
  const robots = await request.get(`${appOrigin}/robots.txt`);
  expect(await robots.text()).toContain(`Sitemap: ${appOrigin}/sitemap.xml`);

  const sitemap = await request.get(`${appOrigin}/sitemap.xml`);
  expect(sitemap.headers()["content-type"]).toBe("application/xml; charset=utf-8");
  expect(await sitemap.text()).toContain(`<loc>${appOrigin}/examples/drizzle-in-five-minutes</loc>`);
});

/** The `og:image` URL a page's head names. */
function readOgImageUrl(page: string): string {
  const url = /<meta property="og:image" content="([^"]+)"\/>/.exec(page)?.[1];

  if (url === undefined) {
    throw new Error("Expected the page to have an og:image tag, but found none");
  }

  return url;
}

test("should point each page at a link preview image drawn at build time as a 1200 x 630 PNG", async ({ request }) => {
  const published = await postSnapshot(request, { data: snapshot, description: "Hide deleted rows." });
  expect(published.ok(), await published.text()).toBe(true);
  const { id }: { id: string } = await published.json();

  for (const path of ["/", "/examples/drizzle-in-five-minutes", `/s/${id}`]) {
    const page = await (await request.get(`${appOrigin}${path}`)).text();
    const imageUrl = readOgImageUrl(page);
    const image = await request.get(imageUrl);
    const png = await image.body();

    expect(imageUrl, path).toMatch(/\/og\/.+\.png$/);
    expect(image.status(), path).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([1200, 630]);
  }
});
