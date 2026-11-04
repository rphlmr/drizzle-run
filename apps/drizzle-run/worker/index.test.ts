import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_readRawConfig } from "wrangler";

import { appPages } from "../test/app-pages";
import { createAppContentSecurityPolicy } from "./content-security-policy";
import worker from "./index";
import type { HtmlRewriter, WorkerEnvironment } from "./platform";
import { runtimeAssets } from "./runtime-assets.generated";

function makeEnvironment(
  response = new Response("application shell", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }),
): WorkerEnvironment {
  return {
    PLAYGROUNDS: {
      prepare() {
        throw new Error("The asset-route test must not access D1.");
      },
      batch() {
        throw new Error("The asset-route test must not access D1.");
      },
    },
    RUNTIME_ASSETS: {
      async get() {
        throw new Error("The app-route test must not access R2.");
      },
    },
    ASSETS: {
      async fetch() {
        return response;
      },
    },
  };
}

class PassThroughRewriter implements HtmlRewriter {
  on(): HtmlRewriter {
    return this;
  }

  transform(response: Response): Response {
    return response;
  }
}

/** Every page the app routes to that can run a project, as a visitor can load it from the address bar. */
const appPagePaths = Object.values(appPages);

beforeEach(() => {
  vi.stubGlobal("HTMLRewriter", PassThroughRewriter);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Worker analytics relay", () => {
  it("should relay image beacons without forwarding credentials or caching events", async () => {
    const collector = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([71, 73, 70]), {
        headers: { "Content-Type": "image/gif", "Set-Cookie": "collector=secret", "Cache-Control": "public" },
      }),
    );
    vi.stubGlobal("fetch", collector);

    const response = await worker.fetch(
      new Request("https://drizzle.run/api/analytics/events?data=abc%2B123%3D", {
        headers: {
          Cookie: "session=secret",
          Authorization: "Bearer secret",
          "User-Agent": "test-browser",
          Referer: "https://drizzle.run/",
          "CF-Connecting-IP": "192.0.2.1",
          "X-Forwarded-For": "spoofed",
        },
      }),
      makeEnvironment(),
    );

    expect(collector).toHaveBeenCalledOnce();
    const [url, init] = collector.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://collector.onedollarstats.com/events?data=abc%2B123%3D");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(Object.fromEntries(init.headers)).toEqual({
      referer: "https://drizzle.run/",
      "user-agent": "test-browser",
      "x-forwarded-for": "192.0.2.1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([71, 73, 70]);
  });

  it.each(["text/plain;charset=UTF-8", "application/json"])(
    "should relay the %s POST transport without changing its payload",
    async (contentType) => {
      const collector = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", collector);
      const body = JSON.stringify({ u: "https://drizzle.run/", e: [{ t: "view" }] });

      const response = await worker.fetch(
        new Request("https://drizzle.run/api/analytics/events", {
          method: "POST",
          headers: { "Content-Type": contentType },
          body,
        }),
        makeEnvironment(),
      );

      const [, init] = collector.mock.calls[0] ?? [];
      expect(init.method).toBe("POST");
      expect(init.headers.get("content-type")).toBe(contentType);
      expect(new TextDecoder().decode(init.body)).toBe(body);
      expect(response.status).toBe(204);
    },
  );

  it("should refuse oversized POSTs before contacting the collector", async () => {
    const collector = vi.fn();
    vi.stubGlobal("fetch", collector);

    const response = await worker.fetch(
      new Request("https://drizzle.run/api/analytics/events", { method: "POST", body: "x".repeat(64 * 1024 + 1) }),
      makeEnvironment(),
    );

    expect(response.status).toBe(413);
    expect(collector).not.toHaveBeenCalled();
  });

  it("should leave the relay unavailable outside production", async () => {
    const collector = vi.fn();
    vi.stubGlobal("fetch", collector);

    const response = await worker.fetch(
      new Request("https://next.drizzle.run/api/analytics/events"),
      makeEnvironment(),
    );

    expect(response.status).toBe(404);
    expect(collector).not.toHaveBeenCalled();
  });
});

describe("Worker first routes", () => {
  it("should run the Worker before the assets for every request but the build files", () => {
    const { rawConfig } = experimental_readRawConfig({
      config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    });

    expect(rawConfig.assets?.run_worker_first).toEqual(["/*", "!/assets/*"]);
  });

  it("should give the build files COEP, and the app shell a missing one falls back to no framing, in public/_headers", async () => {
    const headersFile = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
    const rules = headersFile.split("\n").filter((line) => line !== "" && !line.startsWith("#"));

    expect(rules).toEqual([
      "/assets/*",
      "  Cross-Origin-Embedder-Policy: require-corp",
      "  Content-Security-Policy: frame-ancestors 'self'",
    ]);
  });
});

describe("Worker application routes", () => {
  it("should mark every response on a workers.dev host as not to be indexed", async () => {
    const page = await worker.fetch(new Request("https://drizzle-run.example.workers.dev/"), makeEnvironment());
    const missingApi = await worker.fetch(
      new Request("https://drizzle-run.example.workers.dev/api/missing"),
      makeEnvironment(),
    );

    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(await page.text()).toBe("application shell");
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("should mark every response as not to be indexed when the deploy turns search indexing off", async () => {
    const response = await worker.fetch(new Request("https://next.run.test/"), {
      ...makeEnvironment(),
      SEARCH_INDEXING: "off",
    });

    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("should leave the home indexable on its own domain", async () => {
    const response = await worker.fetch(new Request("https://run.test/"), makeEnvironment());

    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("should isolate standalone project and share pages with COOP and COEP", async () => {
    const response = await worker.fetch(
      new Request("https://run.test/s/00000000-0000-4000-8000-000000000001"),
      makeEnvironment(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(await response.text()).toBe("application shell");
  });

  it.each(appPagePaths)("should isolate the page %s with COOP and COEP", async (path) => {
    const response = await worker.fetch(new Request(`https://run.test${path}`), makeEnvironment());

    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it.each(["/", "/p/00000000-0000-4000-8000-000000000001", "/examples/transactions", "/s/abc"])(
    "should keep the page %s from loading images or sending data to other sites",
    async (path) => {
      const response = await worker.fetch(new Request(`https://run.test${path}`), makeEnvironment());
      const policy = response.headers.get("content-security-policy") ?? "";

      expect(policy).toContain("img-src 'self' data: blob: https://avatars.githubusercontent.com;");
      expect(policy).toContain("connect-src 'self' wss://run.test https://orm.drizzle.team data: blob:");
      expect(policy).toContain("font-src 'self' data:");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'self'");
      expect(policy).not.toMatch(/default-src|script-src|style-src|worker-src/);
    },
  );

  it("should allow the relay socket of a local http server", () => {
    expect(createAppContentSecurityPolicy(new URL("http://127.0.0.1:4173/p/x"))).toContain(
      "connect-src 'self' ws://127.0.0.1:4173 https://orm.drizzle.team",
    );
  });

  it.each([
    { origin: "https://drizzle.run", allowed: false },
    { origin: "https://next.drizzle.run", allowed: false },
    { origin: "https://pr-5.example.workers.dev", allowed: false },
    { origin: "http://localhost:5173", allowed: false },
    { origin: "http://drizzle.run", allowed: false },
  ])("should keep analytics requests same-origin on $origin", async ({ origin, allowed }) => {
    const response = await worker.fetch(new Request(`${origin}/`), makeEnvironment());

    expect(response.headers.get("content-security-policy")?.includes("https://collector.onedollarstats.com")).toBe(
      allowed,
    );
  });

  it.each(["/embed/00000000-0000-4000-8000-000000000001", "/embed/examples/transactions/02-savepoint"])(
    "should keep the embed %s from sending data to other sites, while any site may frame it",
    async (path) => {
      const response = await worker.fetch(new Request(`https://run.test${path}`), makeEnvironment());
      const policy = response.headers.get("content-security-policy") ?? "";

      expect(policy).toContain("img-src 'self' data: blob: https://avatars.githubusercontent.com;");
      expect(policy).toContain("connect-src 'self' wss://run.test https://orm.drizzle.team data: blob:");
      expect(policy).toContain("object-src 'none'");
      expect(policy).not.toContain("frame-ancestors");
    },
  );

  it.each([
    "/embed/00000000-0000-4000-8000-000000000001",
    "/embed/examples/transactions/02-savepoint",
    "/embed/00000000-0000-4000-8000-00000000000A",
    "/embed/not-a-snapshot",
  ])("should isolate the embed %s in its own frame", async (path) => {
    const response = await worker.fetch(new Request(`https://run.test${path}`), makeEnvironment());

    expect(response.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.has("cross-origin-opener-policy")).toBe(false);
  });

  it("should remove inherited COOP from an embed document", async () => {
    const response = await worker.fetch(
      new Request("https://run.test/embed/examples/quick-start-sqlite"),
      makeEnvironment(
        new Response("application shell", {
          headers: {
            "Content-Type": "text/html",
            "Cross-Origin-Opener-Policy": "same-origin",
          },
        }),
      ),
    );

    expect(response.headers.has("cross-origin-opener-policy")).toBe(false);
  });

  it.each(["/embed/a/b", "/embed/examples/transactions/02-savepoint/extra"])(
    "should keep %s, which the app renders as a full page, from being framed by other sites",
    async (path) => {
      const response = await worker.fetch(new Request(`https://run.test${path}`), makeEnvironment());

      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.has("document-isolation-policy")).toBe(false);
    },
  );

  it.each([
    ["/assets/app.js", "text/javascript"],
    ["/embed/index.js", "text/javascript"],
    ["/favicon.svg", "image/svg+xml"],
  ])("should leave the file %s without a page policy", async (path, contentType) => {
    const file = new Response("file", { headers: { "Content-Type": contentType } });
    const response = await worker.fetch(new Request(`https://run.test${path}`), makeEnvironment(file));

    expect(response.headers.has("content-security-policy")).toBe(false);
    expect(response.headers.has("cross-origin-opener-policy")).toBe(false);
  });

  it("should answer Community routes with the right methods", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const listing = await worker.fetch(
      new Request(`https://run.test/api/playgrounds/${id}/listing`, { method: "POST" }),
      makeEnvironment(),
    );
    const community = await worker.fetch(
      new Request("https://run.test/api/community", { method: "POST" }),
      makeEnvironment(),
    );
    const report = await worker.fetch(new Request(`https://run.test/api/community/${id}/report`), makeEnvironment());

    expect(listing.status).toBe(405);
    expect(listing.headers.get("allow")).toBe("PUT, DELETE");
    expect(community.status).toBe(405);
    expect(community.headers.get("allow")).toBe("GET, HEAD");
    expect(report.status).toBe(405);
    expect(report.headers.get("allow")).toBe("POST");
  });

  it("should answer cloud routes with the right methods, GET with HEAD", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const status = await worker.fetch(new Request("https://run.test/api/cloud", { method: "POST" }), makeEnvironment());
    const project = await worker.fetch(
      new Request(`https://run.test/api/cloud/projects/${id}`, { method: "PATCH" }),
      makeEnvironment(),
    );

    expect(status.status).toBe(405);
    expect(status.headers.get("allow")).toBe("GET, HEAD");
    expect(project.status).toBe(405);
    expect(project.headers.get("allow")).toBe("GET, HEAD, PUT, DELETE");
  });

  it("should answer HEAD on an API route with the status and headers of GET, without a body", async () => {
    const get = await worker.fetch(new Request("https://run.test/api/auth/session"), makeEnvironment());
    const head = await worker.fetch(
      new Request("https://run.test/api/auth/session", { method: "HEAD" }),
      makeEnvironment(),
    );

    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ configured: false, user: null });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
  });

  it("should answer share routes with the right methods", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const posted = await worker.fetch(
      new Request(`https://run.test/api/playgrounds/${id}`, { method: "POST" }),
      makeEnvironment(),
    );
    const deleted = await worker.fetch(
      new Request(`https://run.test/api/playgrounds/${id}/recording`, { method: "DELETE" }),
      makeEnvironment(),
    );

    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD, PUT, DELETE");
    expect(deleted.status).toBe(405);
    expect(deleted.headers.get("allow")).toBe("GET, HEAD, PUT");
  });

  it("should use document isolation for embeds without imposing COOP on the embedding site", async () => {
    const response = await worker.fetch(
      new Request("https://run.test/embed/00000000-0000-4000-8000-000000000001"),
      makeEnvironment(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.has("cross-origin-opener-policy")).toBe(false);
  });

  it("should serve the hosted ESM loader to cross-origin blog pages without document policies", async () => {
    const response = await worker.fetch(
      new Request("https://run.test/embed/index.js"),
      makeEnvironment(
        new Response("export const mountPlayground = () => {};", {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect(response.headers.get("document-isolation-policy")).toBeNull();
    expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
  });

  it("should add COEP to approved runtime worker scripts", async () => {
    const asset = runtimeAssets.find(({ name }) => name === "quickjs/execution-worker.js");

    if (asset === undefined) {
      throw new Error("The runtime worker must be present in the generated asset inventory.");
    }

    const checksum = new ArrayBuffer(16);
    new Uint8Array(checksum).set(Uint8Array.from(asset.md5.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16)));
    const env = makeEnvironment();
    env.RUNTIME_ASSETS = {
      async get(key) {
        expect(key).toBe(asset.key);
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          httpEtag: '"runtime-worker"',
          size: asset.size,
          checksums: { md5: checksum },
        };
      },
    };

    const response = await worker.fetch(new Request(`https://run.test/runtime-assets/${asset.key}`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(asset.contentType);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});
