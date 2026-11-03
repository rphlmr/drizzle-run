import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { toRecordedGuest, type PlaygroundSnapshot } from "@drizzle-run/core/contracts";
import type { APIRequestContext, Page } from "@playwright/test";
import { uniq } from "es-toolkit";

import { EMBED_DEFAULT_HEIGHT, type PlaygroundPreview } from "../src/embed-loader/index";
import { resolveOfficialEmbed } from "../src/official/official-embeds";
import { buildEmbedPreview } from "../src/share/embed-preview";
import { appOrigin, blogOrigin, expect, test } from "./fixtures";
import { readOfficialExamples } from "./official-examples";
import { postSnapshot } from "./publish";
import { removedNext, serveSnapshot } from "./retired-pair";

function isMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const environment =
  (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const appBaseUrl = environment.DRIZZLE_RUN_APP_URL ?? appOrigin;
const blogBaseUrl = environment.DRIZZLE_RUN_BLOG_URL ?? blogOrigin;
const sentinel = "drizzle-run-auto-run-sentinel";
const officialExamples = readOfficialExamples();

function createSnapshot(name: string) {
  return {
    snapshotVersion: 1,
    name,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: {
        "drizzle-orm": "0.45.4",
        "drizzle-kit": "0.31.11",
      },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: {
        "schema.ts":
          'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const records = sqliteTable("records", { id: integer("id").primaryKey() });\n',
        "query.ts": `$.display("${sentinel}", [{ value: "${sentinel}" }]);\nthrow new Error("${sentinel}");\n`,
      },
    },
  } satisfies PlaygroundSnapshot;
}

async function publishSnapshot(request: APIRequestContext, name: string): Promise<string> {
  return publishSnapshotPayload(request, createSnapshot(name));
}

async function publishSnapshotPayload(request: APIRequestContext, snapshot: Record<string, unknown>): Promise<string> {
  const response = await postSnapshot(request, {
    baseUrl: appBaseUrl,
    data: snapshot,
  });
  const text = await response.text();
  expect(response.ok(), `Snapshot publication failed: ${text}`).toBe(true);
  const body: unknown = JSON.parse(text);
  expect(body).toMatchObject({ id: expect.any(String), digest: expect.any(String) });

  return (body as { id: string }).id;
}

const recordedSentinel = "drizzle-run-recorded-sentinel";

const recordedDisplay = {
  label: "Recorded rows",
  values: [
    { type: "array", value: [{ type: "object", value: { label: { type: "primitive", value: recordedSentinel } } }] },
  ],
};

/** A succeeded run of a snapshot, as the Share dialog records it: no database, no query plans. */
function createRecording(snapshotDigest: string) {
  return {
    recordingVersion: 1,
    snapshotDigest,
    recordedAt: "2026-10-17T10:00:00.000Z",
    guests: [toRecordedGuest({ dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" } })],
    result: {
      version: 1,
      ok: true,
      outcome: "succeeded",
      target: { dialect: "sqlite" },
      tuple: { id: "legacy", target: { dialect: "sqlite" }, ormVersion: "0.45.4", kitVersion: "0.31.11" },
      random: {
        effectiveSeed: 1,
        source: "derived",
        derivation: "run-manifest-sha256-u32-v1",
        generator: "mulberry32-v1",
      },
      phases: [],
      diagnostics: [],
      sql: [],
      logs: [],
      value: { type: "undefined" },
      displays: [recordedDisplay],
      events: [{ type: "display", sequence: 1, payload: recordedDisplay }],
      cleanupErrors: [],
      cleanup: { guest: { mode: "graceful" }, database: { mode: "graceful" } },
      timings: { total: 120 },
    },
  };
}

/** Publishes a link signed in, then records a run of its code. */
async function publishRecordedSnapshot(request: APIRequestContext, name: string): Promise<string> {
  const response = await postSnapshot(request, {
    baseUrl: appBaseUrl,
    data: createSnapshot(name),
  });
  const published = (await response.json()) as { id: string; digest: string };
  expect(response.ok(), `Snapshot publication failed: ${JSON.stringify(published)}`).toBe(true);

  const recorded = await request.put(new URL(`/api/playgrounds/${published.id}/recording`, appBaseUrl).href, {
    headers: { Origin: new URL(appBaseUrl).origin },
    data: createRecording(published.digest),
  });
  expect(recorded.ok(), `Recording failed: ${await recorded.text()}`).toBe(true);

  return published.id;
}

function createJavaScriptAndJsonSnapshot() {
  return {
    snapshotVersion: 1,
    name: "JavaScript and JSON editor fixture",
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: {
        "drizzle-orm": "0.45.4",
        "drizzle-kit": "0.31.11",
      },
      entrypoints: { schema: "schema.mjs", run: "query.mjs" },
      files: {
        "schema.mjs":
          'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";\n\nexport const records = sqliteTable("records", { id: integer("id").primaryKey(), label: text("label") });\n',
        "query.mjs": 'import settings from "./settings.json";\n\n$.display("settings", [{ label: settings.label }]);\n',
        "settings.json": '{\n  "label": "json-worker-ready"\n}\n',
      },
    },
  };
}

function buildBlogUrl(
  snapshotIds: readonly string[],
  hostedLoader = false,
  preview = buildEmbedPreview(createSnapshot("Shared playground")),
): string {
  const url = new URL("/", blogBaseUrl);

  for (const snapshotId of snapshotIds) {
    url.searchParams.append("snapshotId", snapshotId);
    url.searchParams.append("preview", JSON.stringify(preview));
  }

  url.searchParams.set("baseUrl", new URL(appBaseUrl).origin);

  if (hostedLoader) {
    url.searchParams.set("hostedLoader", "true");
  }

  return url.href;
}

/** The blog fixture with one official embed: `quick-start-sqlite`, or a guide step as `transactions/02-savepoint`. */
function buildBlogExampleUrl(example: string, preview = getOfficialPreview(example)): string {
  const url = new URL("/", blogBaseUrl);
  url.searchParams.set("example", example);
  url.searchParams.set("baseUrl", new URL(appBaseUrl).origin);
  url.searchParams.set("preview", JSON.stringify(preview));

  return url.href;
}

function getOfficialPreview(path: string): PlaygroundPreview {
  const [example, step] = path.split("/");
  const official = resolveOfficialEmbed(officialExamples, { example, step });

  if (official === null) {
    throw new Error(`Expected an official embed for '${path}'.`);
  }

  return buildEmbedPreview({
    name: official.example.title,
    description: official.example.description,
    manifest: official.manifest,
  });
}

function observeAppRequests(page: Page): string[] {
  const requests: string[] = [];
  const requestOrigin = new URL(appBaseUrl).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());

    if (url.origin === requestOrigin) {
      requests.push(url.pathname);
    }
  });

  return requests;
}

async function waitForEmbedDisposition(
  page: Page,
): Promise<"inline" | "context-fallback" | "browser_unsupported" | "load-error"> {
  let disposition: "inline" | "context-fallback" | "browser_unsupported" | "load-error" | "loading" = "loading";
  await expect
    .poll(
      async () => {
        if (await page.getByRole("link", { name: "Open in a new tab" }).count()) {
          disposition = "context-fallback";
          return disposition;
        }

        const visibleFrame = await page
          .locator("[data-drizzle-run-embed]")
          .evaluateAll((hosts) =>
            hosts.some(
              (host) =>
                host.shadowRoot?.querySelector("iframe[data-drizzle-run-frame]") !== null &&
                host.shadowRoot?.querySelector("[data-loading]") === null,
            ),
          );

        if (visibleFrame) {
          disposition = "inline";
          return disposition;
        }

        const alerts = (await page.getByRole("alert").allTextContents()).join(" ");

        if (alerts.includes("can't run the playground")) {
          disposition = "browser_unsupported";
          return disposition;
        }

        if (alerts.includes("could not load this playground")) {
          disposition = "load-error";
          return disposition;
        }

        return "loading";
      },
      { timeout: 120_000 },
    )
    .not.toBe("loading");

  if (disposition === "loading") {
    throw new Error("The embed did not reach a terminal state after the Playwright timeout.");
  }

  return disposition;
}

test.describe("Drizzle Run click-to-load embed", () => {
  test("should show a cover of the playground's height with the title and description before contacting the app", async ({
    page,
  }) => {
    const appRequests = observeAppRequests(page);
    const preview = getOfficialPreview("quick-start-sqlite");
    await page.goto(buildBlogExampleUrl("quick-start-sqlite"));
    const placeholder = page.locator("[data-drizzle-run-embed]");

    if (preview.description === undefined) {
      throw new Error("Expected the quick-start-sqlite example to have a description.");
    }

    await expect(placeholder.getByRole("heading", { name: preview.title })).toBeVisible();
    await expect(placeholder.getByText(preview.description)).toBeVisible();
    await expect(placeholder.getByText("Official example")).toBeVisible();
    await expect(placeholder.getByText("SQLite", { exact: true })).toBeVisible();
    await placeholder.evaluate((element) => {
      (element as HTMLElement).style.width = "800px";
    });
    const wideHeight = await placeholder.evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(wideHeight - EMBED_DEFAULT_HEIGHT)).toBeLessThanOrEqual(1);

    await placeholder.evaluate((element) => {
      (element as HTMLElement).style.width = "340px";
    });
    const button = placeholder.getByRole("button", { name: "Load playground in Drizzle Run" });
    await expect(button).toBeVisible();
    const [coverBox, buttonBox] = await Promise.all([placeholder.boundingBox(), button.boundingBox()]);
    expect((buttonBox?.y ?? Infinity) + (buttonBox?.height ?? 0)).toBeLessThanOrEqual(
      (coverBox?.y ?? 0) + (coverBox?.height ?? 0),
    );
    expect(appRequests).toEqual([]);
    await expect(placeholder.locator("iframe")).toHaveCount(0);
  });

  test("should load an official embed inside a cross-origin isolated host", async ({ page }) => {
    const hostUrl = new URL(buildBlogExampleUrl("quick-start-sqlite"));
    hostUrl.searchParams.set("isolated", "1");

    await page.goto(hostUrl.href);
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    const embedResponse = page.waitForResponse((response) =>
      response.url().startsWith(`${appBaseUrl}/embed/examples/quick-start-sqlite`),
    );
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    const response = await embedResponse;

    expect(response.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.headers()["cross-origin-opener-policy"]).toBeUndefined();
    expect(await waitForEmbedDisposition(page)).toBe("inline");
    expect(
      await page
        .frameLocator("iframe[data-drizzle-run-frame]")
        .locator("html")
        .evaluate(() => window.crossOriginIsolated),
    ).toBe(true);
  });

  test("should not contact the app before activation, and keep multiple mounts independent", async ({
    page,
    request,
  }) => {
    const first = await publishSnapshot(request, "First embed fixture");
    const second = await publishSnapshot(request, "Second embed fixture");
    const appRequests = observeAppRequests(page);
    const hostResponse = await page.goto(buildBlogUrl([first, second]));

    expect(hostResponse?.headers()["cross-origin-opener-policy"]).toBeUndefined();
    expect(hostResponse?.headers()["cross-origin-embedder-policy"]).toBeUndefined();
    expect(hostResponse?.headers()["document-isolation-policy"]).toBeUndefined();
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Load playground in Drizzle Run" })).toHaveCount(2);
    expect(appRequests).toEqual([]);
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(0);
    const applicationHints = await page
      .locator('link[rel~="preconnect"], link[rel~="prefetch"], link[rel~="dns-prefetch"]')
      .evaluateAll(
        (links, origin) => links.filter((link) => new URL((link as HTMLLinkElement).href).origin === origin).length,
        new URL(appBaseUrl).origin,
      );
    expect(applicationHints).toBe(0);

    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).nth(0).click();
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(1);
    await expect.poll(() => appRequests.includes(`/embed/${first}`)).toBe(true);
    const firstFrameUrl = new URL((await page.locator("iframe[data-drizzle-run-frame]").getAttribute("src")) ?? "");
    expect(firstFrameUrl.origin).toBe(new URL(appBaseUrl).origin);
    expect(firstFrameUrl.pathname).toBe(`/embed/${first}`);
    expect(new URLSearchParams(firstFrameUrl.hash.slice(1)).get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    await page.getByRole("button", { name: "Remove playground 1" }).click();
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(0);
    expect(appRequests).not.toContain(`/embed/${second}`);

    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(1);
    await expect.poll(() => appRequests.includes(`/embed/${second}`)).toBe(true);
    expect(uniq(appRequests.filter((path) => path.startsWith("/embed/"))).toSorted()).toEqual(
      [`/embed/${first}`, `/embed/${second}`].toSorted(),
    );
    await page.getByRole("button", { name: "Remove playground 2" }).click();
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(0);
  });

  test("should load only the hosted ESM loader before activation, and report the browser fallback", async ({
    page,
    request,
  }) => {
    const snapshotId = await publishSnapshot(request, "Hosted loader fixture");
    const appRequests = observeAppRequests(page);
    await page.goto(buildBlogUrl([snapshotId], true));

    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    expect(appRequests).toEqual(["/embed/index.js"]);
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(0);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
    expect(appRequests.some((path) => path.startsWith("/assets/"))).toBe(false);
    expect(appRequests.some((path) => path.startsWith("/api/"))).toBe(false);

    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    const disposition = await waitForEmbedDisposition(page);
    expect(appRequests).toContain(`/embed/${snapshotId}`);

    if (disposition === "context-fallback") {
      const link = page.getByRole("link", { name: "Open in a new tab" });
      expect(new URL((await link.getAttribute("href")) ?? "").pathname).toBe(`/s/${snapshotId}`);
      await expect(page.getByRole("alert")).toContainText("doesn't give embedded playgrounds the isolation");
      expect(appRequests).toContain(`/api/playgrounds/${snapshotId}/recording`);
      expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
      return;
    }

    if (disposition === "browser_unsupported") {
      await expect(page.getByRole("alert")).toContainText("can't run the playground");
      await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveCount(0);
      expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
      return;
    }

    expect(disposition).toBe("inline");
    await expect
      .poll(() => appRequests.some((path) => path.startsWith("/runtime-assets/")), { timeout: 120_000 })
      .toBe(true);
    expect(appRequests).toContain(`/api/playgrounds/${snapshotId}`);
  });

  test("should start the JSON and JavaScript editor workers for ESM project files", async ({ page, request }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(`${message.location().url}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));

    const snapshotId = await publishSnapshotPayload(request, createJavaScriptAndJsonSnapshot());
    await page.addInitScript(() => {
      const instrumentedWindow = window as Window & { drizzleRunWorkerUrls?: string[] };
      instrumentedWindow.drizzleRunWorkerUrls = [];
      const NativeWorker = window.Worker;

      window.Worker = class extends NativeWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          instrumentedWindow.drizzleRunWorkerUrls?.push(new URL(String(scriptURL), window.location.href).pathname);
          super(scriptURL, options);
        }
      };
    });
    await page.goto(new URL("/", appBaseUrl).href);
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

    const appRequests = observeAppRequests(page);
    await page.evaluate(
      async ({ id, baseUrl, preview }) => {
        const embed = await import(new URL("/embed/index.js", window.location.href).href);
        const mountPoint = document.createElement("div");
        mountPoint.id = "worker-playground-mount";
        document.body.append(mountPoint);
        embed.mountPlayground(mountPoint, { snapshotId: id, baseUrl, preview });
      },
      {
        id: snapshotId,
        baseUrl: new URL(appBaseUrl).origin,
        preview: {
          title: "JavaScript and JSON",
          description: "Drizzle ORM 0.45.4 on SQLite",
        } satisfies PlaygroundPreview,
      },
    );

    expect(appRequests).not.toContain(`/embed/${snapshotId}`);
    expect(appRequests).not.toContain(`/api/playgrounds/${snapshotId}`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    const disposition = await waitForEmbedDisposition(page);

    if (disposition === "browser_unsupported") {
      await expect(page.getByRole("alert")).toContainText("can't run the playground");
      await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveCount(0);
      expect(appRequests).toContain(`/api/playgrounds/${snapshotId}/recording`);
      expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
      return;
    }

    expect(disposition).toBe("inline");

    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");

    try {
      await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 180_000 });
    } catch (cause) {
      const frameBody = frame.locator("body");
      const [frameState, workerUrls] = await Promise.all([
        frameBody.innerText({ timeout: 5_000 }).catch(() => "Iframe text was unavailable after the readiness timeout."),
        frameBody
          .evaluate(
            () => {
              return (window as Window & { drizzleRunWorkerUrls?: string[] }).drizzleRunWorkerUrls ?? [];
            },
            undefined,
            { timeout: 5_000 },
          )
          .catch(() => [] as string[]),
      ]);
      throw new Error(
        `Playground did not become ready. Browser errors: ${JSON.stringify(browserErrors)}. Workers: ${JSON.stringify(workerUrls)}. Frame text: ${frameState}`,
        { cause },
      );
    }

    expect(appRequests.filter((path) => path === `/embed/${snapshotId}`)).toHaveLength(1);
    await expect
      .poll(
        async () =>
          frame.locator("body").evaluate(() => {
            return (window as Window & { drizzleRunWorkerUrls?: string[] }).drizzleRunWorkerUrls ?? [];
          }),
        { timeout: 30_000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringMatching(/\/assets\/json\.worker-/),
          expect.stringMatching(/\/assets\/ts\.worker-/),
        ]),
      );
    expect(appRequests).toContain(`/api/playgrounds/${snapshotId}`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(true);
  });

  test("should ask for a release before opening a snapshot on a removed Next pair", async ({ page }) => {
    // Only UUID snapshot ids get an embeddable page.
    const snapshotId = crypto.randomUUID();
    await serveSnapshot(page, snapshotId, removedNext);
    await page.goto(new URL("/", appBaseUrl).href);
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.evaluate(
      async ({ id, baseUrl, preview }) => {
        const embed = await import(new URL("/embed/index.js", window.location.href).href);
        const mountPoint = document.createElement("div");
        document.body.append(mountPoint);
        embed.mountPlayground(mountPoint, { snapshotId: id, baseUrl, preview });
      },
      {
        id: snapshotId,
        baseUrl: new URL(appBaseUrl).origin,
        preview: {
          title: "Removed release",
          description: `Drizzle ORM ${removedNext["drizzle-orm"]} on SQLite`,
        } satisfies PlaygroundPreview,
      },
    );
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

    if ((await waitForEmbedDisposition(page)) === "browser_unsupported") {
      return;
    }

    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");
    const panel = frame.getByRole("region", { name: "Choose a Drizzle release" });
    await expect(panel).toContainText("was shared with orm 1.0.0-rc.3 · kit 1.0.0-rc.3", { timeout: 120_000 });
    await expect(panel.getByRole("radio", { name: /^RC, newest, orm 1\.0\.0-rc\.5/ })).toBeChecked();
    await panel.getByRole("button", { name: "Open with this release" }).click();

    await expect(panel).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Open full playground" })).toBeVisible();
  });

  test("should open snapshots as editable copies without running submitted code", async ({ page, request }) => {
    const snapshotId = await publishSnapshot(request, "No automatic execution");
    await page.goto(new URL(`/s/${snapshotId}`, appBaseUrl).href);

    await expect(page.getByRole("region", { name: "Execution output" })).toContainText("Your results land here", {
      timeout: 120_000,
    });
    await expect(page.getByRole("button", { name: "Fork to my projects" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Execution output" }).getByText(sentinel, { exact: false }),
    ).toHaveCount(0);
  });

  test("should be read only, offer Results, Story and SQL, and show a failed run's error in Story", async ({
    page,
    request,
  }) => {
    const snapshotId = await publishSnapshot(request, "Read-only embed");
    await page.goto(buildBlogUrl([snapshotId]));
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

    if ((await waitForEmbedDisposition(page)) !== "inline") {
      return;
    }

    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");
    const output = frame.getByRole("region", { name: "Execution output" });
    await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
    await expect(output.getByRole("tablist", { name: "Output views" }).getByRole("tab")).toHaveText([
      "Results",
      "Story",
      "Logs",
    ]);
    await expect(output.getByRole("button", { name: /^Run history/ })).toHaveCount(0);

    const editor = frame.getByRole("region", { name: "Editor" });
    await editor.locator(".view-lines").click();
    await page.keyboard.type("typed-into-embed");
    await expect(editor.locator(".view-lines")).not.toContainText("typed-into-embed");

    await frame.getByRole("button", { name: "Run", exact: true }).click();
    await expect(output.getByRole("tab", { name: "Story" })).toHaveAttribute("aria-selected", "true", {
      timeout: 120_000,
    });
    await expect(output.getByRole("alert")).toContainText(sentinel);
    await expect(output.getByRole("status").filter({ hasText: "Failed" })).toBeVisible();
  });

  test("should load the playground inline in an isolation-capable application context", async ({ page, request }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));

    const snapshotId = await publishSnapshot(request, "Inline compatibility fixture");
    await page.goto(new URL("/", appBaseUrl).href);
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

    const appRequests = observeAppRequests(page);
    await page.evaluate(() => {
      const testWindow = window as Window & { drizzleRunTestMessages?: unknown[] };
      testWindow.drizzleRunTestMessages = [];
      window.addEventListener("message", (event) => {
        const frame = document
          .querySelector("[data-drizzle-run-embed]")
          ?.shadowRoot?.querySelector("iframe[data-drizzle-run-frame]");

        if (frame instanceof HTMLIFrameElement && event.source === frame.contentWindow) {
          testWindow.drizzleRunTestMessages?.push({ origin: event.origin, data: event.data });
        }
      });
    });
    await page.evaluate(
      async ({ id, baseUrl, preview }) => {
        const loaderUrl = new URL("/embed/index.js", window.location.href).href;
        const embed = await import(loaderUrl);
        const mountPoint = document.createElement("div");
        mountPoint.id = "inline-playground-mount";
        document.body.append(mountPoint);
        embed.mountPlayground(mountPoint, { snapshotId: id, baseUrl, preview });
      },
      {
        id: snapshotId,
        baseUrl: new URL(appBaseUrl).origin,
        preview: buildEmbedPreview(createSnapshot("Inline compatibility fixture")),
      },
    );

    expect(appRequests).not.toContain(`/embed/${snapshotId}`);
    expect(appRequests).not.toContain(`/api/playgrounds/${snapshotId}`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

    const mountPoint = page.locator("#inline-playground-mount");
    const loadingFrame = page.locator("iframe[data-drizzle-run-frame]");
    await expect(mountPoint.getByRole("status")).toHaveText("Loading Drizzle Run…");
    const [mountHeight, frameHeight] = await Promise.all([
      mountPoint.evaluate((element) => element.getBoundingClientRect().height),
      loadingFrame.evaluate((element) => element.getBoundingClientRect().height),
    ]);
    expect(mountHeight).toBe(frameHeight);
    expect(frameHeight).toBe(585);

    const disposition = await waitForEmbedDisposition(page);
    expect(disposition).toBe("inline");
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveAttribute("allow", "cross-origin-isolated");

    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");

    try {
      await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 45_000 });
    } catch (cause) {
      const state = await frame.locator("body").innerText();
      throw new Error(
        `Editor did not become ready. Browser errors: ${JSON.stringify(browserErrors)}. Frame text: ${state}`,
        { cause },
      );
    }

    await expect(frame.getByRole("region", { name: "Execution output" })).toContainText("Your results land here", {
      timeout: 120_000,
    });
    await expect(
      frame.getByRole("region", { name: "Execution output" }).getByText(sentinel, { exact: false }),
    ).toHaveCount(0);
    expect(appRequests).toContain(`/api/playgrounds/${snapshotId}`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(true);

    try {
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const messages = (window as Window & { drizzleRunTestMessages?: unknown[] }).drizzleRunTestMessages ?? [];
            return messages.some(
              (item) =>
                item !== null &&
                typeof item === "object" &&
                "data" in item &&
                item.data !== null &&
                typeof item.data === "object" &&
                "kind" in item.data &&
                item.data.kind === "ready",
            );
          }),
        )
        .toBe(true);
    } catch (cause) {
      const messages = await page.evaluate(
        () => (window as Window & { drizzleRunTestMessages?: unknown[] }).drizzleRunTestMessages ?? [],
      );
      throw new Error(`The embed did not report ready. Received messages: ${JSON.stringify(messages)}`, {
        cause,
      });
    }

    const captured = await page.evaluate(
      () => (window as Window & { drizzleRunTestMessages?: unknown[] }).drizzleRunTestMessages ?? [],
    );
    const messages = captured.flatMap((item) => {
      if (
        item === null ||
        typeof item !== "object" ||
        !("origin" in item) ||
        !("data" in item) ||
        item.origin !== new URL(appBaseUrl).origin
      ) {
        return [];
      }

      return isMessageRecord(item.data) ? [item.data] : [];
    });
    const keysByKind: Record<string, string[]> = {
      hello: ["kind", "nonce", "protocol", "version"],
      ready: ["kind", "nonce", "protocol", "version"],
      capability: ["kind", "nonce", "protocol", "status", "version"],
      error: ["code", "kind", "nonce", "protocol", "version"],
    };
    expect(messages.some((message) => message.kind === "ready")).toBe(true);
    expect(messages.some((message) => message.kind === "capability" && message.status === "available")).toBe(true);

    for (const message of messages) {
      expect(message.protocol).toBe("drizzle-run-embed");
      expect(message.version).toBe(1);
      expect(message.nonce).toMatch(/^[a-f0-9]{32}$/);
      expect(keysByKind[message.kind as string]).toBeDefined();
      expect(Object.keys(message).toSorted()).toEqual(keysByKind[message.kind as string]);
    }

    expect(JSON.stringify(messages)).not.toContain(sentinel);
    const height = await page
      .locator("iframe[data-drizzle-run-frame]")
      .evaluate((element) => Number.parseInt((element as HTMLIFrameElement).style.height, 10));
    expect(height).toBe(585);

    await frame.getByRole("button", { name: "Run", exact: true }).click();
    const readRunSettled = async () => {
      const received = await page.evaluate(
        () => (window as Window & { drizzleRunTestMessages?: unknown[] }).drizzleRunTestMessages ?? [],
      );

      return received
        .flatMap((item) => (isMessageRecord(item) && isMessageRecord(item.data) ? [item.data] : []))
        .filter((message) => message.kind === "run-settled");
    };
    await expect.poll(async () => (await readRunSettled()).length, { timeout: 120_000 }).toBe(1);
    const [runSettled] = await readRunSettled();
    expect(Object.keys(runSettled ?? {}).toSorted()).toEqual(["kind", "nonce", "protocol", "run", "version"]);
    expect(runSettled?.run).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining(sentinel),
      displays: [{ label: sentinel }],
      truncated: false,
    });
    expect(runSettled?.run).not.toHaveProperty("side");
  });

  test("should show inline execution or the correct isolation/browser fallback after activation", async ({
    page,
    request,
  }) => {
    const snapshotId = await publishSnapshot(request, "Compatibility fixture");
    const appRequests = observeAppRequests(page);
    await page.goto(buildBlogUrl([snapshotId]));
    await expect(page.getByRole("button", { name: "Load playground in Drizzle Run" })).toBeVisible();
    expect(appRequests).toEqual([]);

    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    const disposition = await waitForEmbedDisposition(page);
    expect(disposition).not.toBe("load-error");
    expect(appRequests).toContain(`/embed/${snapshotId}`);

    if (disposition === "context-fallback") {
      const link = page.getByRole("link", { name: "Open in a new tab" });
      expect(new URL((await link.getAttribute("href")) ?? "").pathname).toBe(`/s/${snapshotId}`);
      expect(await page.getByRole("alert").textContent()).toContain("doesn't give embedded playgrounds the isolation");
      expect(appRequests).toContain(`/api/playgrounds/${snapshotId}/recording`);
      expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
      return;
    }

    if (disposition === "browser_unsupported") {
      expect(await page.getByRole("alert").textContent()).toContain("can't run the playground");
      await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveCount(0);
      expect(appRequests).toContain(`/api/playgrounds/${snapshotId}/recording`);
      expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
      return;
    }

    await expect(
      page.frameLocator("iframe[data-drizzle-run-frame]").getByRole("button", { name: "Run", exact: true }),
    ).toBeEnabled({ timeout: 120_000 });
    const embeddedResults = page
      .frameLocator("iframe[data-drizzle-run-frame]")
      .getByRole("region", { name: "Execution output" });
    await expect(embeddedResults).toContainText("Your results land here", { timeout: 120_000 });
    await expect(embeddedResults.getByText(sentinel, { exact: false })).toHaveCount(0);
    expect(appRequests).toContain(`/api/playgrounds/${snapshotId}`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(true);
    const height = await page
      .locator("iframe[data-drizzle-run-frame]")
      .evaluate((frame) => Number.parseInt((frame as HTMLIFrameElement).style.height, 10));
    expect(height).toBe(585);
  });

  test("should show the author's recorded run inline where the embed cannot run, and run live where it can", async ({
    browserName,
    page,
    request,
  }) => {
    const snapshotId = await publishRecordedSnapshot(request, "Recorded fixture");
    const appRequests = observeAppRequests(page);
    await page.goto(buildBlogUrl([snapshotId]));
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

    expect(await waitForEmbedDisposition(page)).toBe("inline");
    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");

    if (browserName === "chromium") {
      await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
      await expect(frame.getByRole("note")).toHaveCount(0);
      await expect(frame.getByText(recordedSentinel)).toHaveCount(0);
      return;
    }

    await expect(frame.getByRole("note")).toContainText("Recorded by the author · Oct 17, 2026.");
    await expect(frame.getByRole("note")).toContainText("This page can't run it live");
    await expect(frame.getByRole("region", { name: "Execution output" })).toContainText(recordedSentinel);
    await expect(frame.getByRole("region", { name: "Code, read only" })).toContainText(`$.display("${sentinel}"`);
    await expect(frame.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
    const runLink = frame.getByRole("link", { name: "Run in a new tab ↗" });
    expect(new URL((await runLink.getAttribute("href")) ?? "", appBaseUrl).pathname).toBe(`/s/${snapshotId}`);
    await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveCount(0);
    expect(appRequests).toContain(`/api/playgrounds/${snapshotId}/recording`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
    const height = await page
      .locator("iframe[data-drizzle-run-frame]")
      .evaluate((element) => Number.parseInt((element as HTMLIFrameElement).style.height, 10));
    expect(height).toBe(585);
  });

  const officialEmbeds = [
    {
      kind: "an official example",
      example: "quick-start-sqlite",
      runButton: "Run",
      display: "Users",
      playgroundPath: "/examples/quick-start-sqlite",
    },
    {
      kind: "a guide step",
      example: "transactions/02-savepoint",
      runButton: "Run",
      display: "Balances",
      playgroundPath: "/examples/transactions?step=02-savepoint",
    },
    {
      kind: "a side-by-side guide step",
      example: "relational-queries/01-relations",
      runButton: "Run both",
      display: "Authors with posts and comments",
      playgroundPath: "/examples/relational-queries?step=01-relations",
    },
    {
      kind: "a guide step that splits into two sides",
      example: "drizzle-in-five-minutes/04-relations",
      runButton: "Run both",
      display: "Users with posts",
      playgroundPath: "/examples/drizzle-in-five-minutes?step=04-relations",
    },
    {
      kind: "a side-by-side official example",
      example: "select-vs-relational-queries",
      runButton: "Run both",
      display: "Authors with posts",
      playgroundPath: "/examples/select-vs-relational-queries",
    },
  ];

  for (const official of officialEmbeds) {
    test(`should embed ${official.kind} live where it runs, and with its recorded run where it cannot`, async ({
      browserName,
      page,
    }) => {
      const appRequests = observeAppRequests(page);
      await page.goto(buildBlogExampleUrl(official.example));
      await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

      expect(await waitForEmbedDisposition(page)).toBe("inline");
      expect(appRequests).toContain(`/embed/examples/${official.example}`);
      const frame = page.frameLocator("iframe[data-drizzle-run-frame]");

      if (browserName === "chromium") {
        await expect(frame.getByRole("button", { name: official.runButton, exact: true })).toBeEnabled({
          timeout: 120_000,
        });
        await expect(frame.getByRole("note")).toHaveCount(0);
        return;
      }

      await expect(frame.getByRole("note")).toContainText("Recorded by Drizzle Run · ");
      await expect(frame.getByRole("note")).toContainText("This page can't run it live, so you see a recorded run.");
      await expect(frame.getByRole("region", { name: /output$/ }).first()).toContainText(official.display);
      await expect(frame.getByRole("button", { name: official.runButton, exact: true })).toHaveCount(0);
      const runLink = frame.getByRole("link", { name: "Run in a new tab ↗" });
      const runUrl = new URL((await runLink.getAttribute("href")) ?? "", appBaseUrl);
      expect(`${runUrl.pathname}${runUrl.search}`).toBe(official.playgroundPath);
      await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveCount(0);
      expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
    });
  }

  test("should keep the placeholder unchanged by a host page's Tailwind and global CSS", async ({ page, request }) => {
    const snapshotId = await publishSnapshot(request, "Hostile host fixture");
    const placeholder = page.locator("[data-drizzle-run-embed]");
    const button = placeholder.getByRole("button", { name: "Load playground in Drizzle Run" });

    const shots: Buffer[] = [];

    for (const hostile of [false, true]) {
      const url = new URL(buildBlogUrl([snapshotId]));

      if (hostile) {
        url.searchParams.set("hostile", "1");
      }

      await page.goto(url.href);
      await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
      await expect(button).toBeVisible();
      await placeholder.evaluate((element) => {
        Object.assign((element as HTMLElement).style, {
          position: "fixed",
          top: "0",
          left: "0",
          width: "640px",
          background: "#ffffff",
        });
      });
      shots.push(await placeholder.screenshot({ animations: "disabled" }));
    }

    expect(shots[1]?.equals(shots[0] ?? Buffer.alloc(0)), "the hostile host changes no placeholder pixel").toBe(true);

    expect(await button.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await button.click();
    await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(1);
  });

  test("should keep the cover dark without a theme in each host color scheme", async ({ page }) => {
    const background = () =>
      page.locator("[data-drizzle-run-embed]").evaluate((host) => {
        const panel = host.shadowRoot?.querySelector(".cover");
        return panel ? getComputedStyle(panel).backgroundColor : undefined;
      });
    await page.emulateMedia({ colorScheme: "dark" });

    for (const scheme of [undefined, "light", "light dark"] as const) {
      const url = new URL(buildBlogExampleUrl("quick-start-sqlite"));

      if (scheme !== undefined) {
        url.searchParams.set("scheme", scheme);
      }

      await page.goto(url.href);
      await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
      await expect.poll(background, { message: `host scheme ${scheme ?? "none"}` }).toBe("rgb(17, 17, 17)");
    }
  });

  test("should paint the cover and the playground in the host's theme, whatever the reader's system", async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium runs an embed live on a page without isolation headers.");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(new URL("/", blogBaseUrl).href);
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    await page.evaluate(
      async ({ baseUrl, preview }) => {
        const loader = await import(new URL("/embed/index.js", window.location.origin).href);
        const mountPoint = document.createElement("div");
        document.body.append(mountPoint);
        loader.mountPlayground(mountPoint, { example: "quick-start-sqlite", baseUrl, preview, theme: "light" });
      },
      { baseUrl: new URL(appBaseUrl).origin, preview: getOfficialPreview("quick-start-sqlite") },
    );
    const cover = page.locator("[data-drizzle-run-embed]").last();

    expect(
      await cover.evaluate((host) => {
        const coverElement = host.shadowRoot?.querySelector(".cover");
        return coverElement ? getComputedStyle(coverElement).backgroundColor : undefined;
      }),
    ).toBe("rgb(255, 255, 255)");

    await cover.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");

    await expect(frame.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("should not offer a new-tab workaround when the browser lacks WebAssembly", async ({ page, request }) => {
    const snapshotId = await publishSnapshot(request, "Unsupported browser fixture");
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "WebAssembly", { configurable: true, value: undefined });
    });
    const appRequests = observeAppRequests(page);
    await page.goto(buildBlogUrl([snapshotId]));
    await expect(page.getByRole("button", { name: "Load playground in Drizzle Run" })).toBeVisible();
    expect(appRequests).toEqual([]);
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

    await expect(page.getByRole("alert")).toContainText("can't run the playground", { timeout: 120_000 });
    await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveCount(0);
    expect(appRequests).toContain(`/embed/${snapshotId}`);
    expect(appRequests).toContain(`/api/playgrounds/${snapshotId}/recording`);
    expect(appRequests.some((path) => path.startsWith("/runtime-assets/"))).toBe(false);
  });

  test("should show the author's recorded run without a run link when the browser lacks WebAssembly", async ({
    page,
    request,
  }) => {
    const snapshotId = await publishRecordedSnapshot(request, "Recorded unsupported browser fixture");
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "WebAssembly", { configurable: true, value: undefined });
    });
    await page.goto(buildBlogUrl([snapshotId]));
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

    expect(await waitForEmbedDisposition(page)).toBe("inline");
    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");
    await expect(frame.getByRole("note")).toContainText("This browser can't run Drizzle Run");
    await expect(frame.getByRole("region", { name: "Execution output" })).toContainText(recordedSentinel);
    await expect(frame.getByRole("link", { name: "Run in a new tab ↗" })).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Open full playground" })).toBeVisible();
  });

  test("should say a removed share, an unknown example or an unknown step no longer exists, without a retry", async ({
    page,
  }) => {
    const missingSnapshotId = "00000000-0000-4000-8000-000000000000";
    const missing = [
      buildBlogUrl([missingSnapshotId]),
      buildBlogExampleUrl("no-such-example", getOfficialPreview("transactions")),
      buildBlogExampleUrl("transactions/99-no-such-step", getOfficialPreview("transactions")),
    ];

    for (const url of missing) {
      await page.goto(url);
      await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();

      const alert = page.getByRole("alert");
      await expect(alert).toContainText("This playground no longer exists", { timeout: 120_000 });
      await expect(alert.getByRole("button", { name: "Retry loading" })).toHaveCount(0);
      await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(0);
      const link = alert.getByRole("link", { name: "Browse examples ↗" });
      expect(new URL((await link.getAttribute("href")) ?? "").pathname).toBe("/examples");
    }
  });

  test("should tell a host page with an opaque origin that the frame cannot connect to it", async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    test.skip(browserName !== "chromium", "Other browsers keep a file:// page from framing the app's embed route.");
    const snapshotId = await publishSnapshot(request, "Opaque host fixture");
    const nonce = "0123456789abcdef0123456789abcdef";
    const frameUrl = new URL(`/embed/${snapshotId}#nonce=${nonce}`, appBaseUrl).href;
    const hostPath = testInfo.outputPath("opaque-host.html");
    await writeFile(
      hostPath,
      `<!doctype html>
<script>
  window.frameMessages = [];
  const frame = document.createElement("iframe");
  frame.src = ${JSON.stringify(frameUrl)};
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) {
      return;
    }

    window.frameMessages.push({ origin: event.origin, data: event.data });

    if (event.data && event.data.kind === "hello") {
      const connect = { protocol: "drizzle-run-embed", version: 1, kind: "connect", nonce: ${JSON.stringify(nonce)}, snapshotId: ${JSON.stringify(snapshotId)} };
      frame.contentWindow.postMessage(connect, "*");
    }
  });
  document.addEventListener("DOMContentLoaded", () => document.body.append(frame));
</script>`,
    );
    await page.goto(pathToFileURL(hostPath).href);
    expect(await page.evaluate(() => window.origin)).toBe("null");

    const readFrameMessages = () =>
      page.evaluate(() => (window as Window & { frameMessages?: unknown[] }).frameMessages ?? []);
    await expect
      .poll(async () => (await readFrameMessages()).map((item) => (item as { data: { kind: string } }).data.kind), {
        timeout: 120_000,
      })
      .toContain("error");

    const messages = await readFrameMessages();
    expect(messages).toContainEqual({
      origin: new URL(appBaseUrl).origin,
      data: { protocol: "drizzle-run-embed", version: 1, kind: "error", nonce, code: "unsupported_host" },
    });
    expect(messages.every((item) => ["hello", "error"].includes((item as { data: { kind: string } }).data.kind))).toBe(
      true,
    );
  });

  test("should keep the chosen height from the cover through the click and after a run", async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium runs an embed live on a page without isolation headers.");
    await page.goto(new URL("/", blogBaseUrl).href);
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    await page.evaluate(
      async ({ baseUrl, preview }) => {
        const loader = await import(new URL("/embed/index.js", window.location.origin).href);
        const mountPoint = document.createElement("div");
        mountPoint.style.width = "720px";
        document.body.append(mountPoint);
        loader.mountPlayground(mountPoint, { example: "quick-start-postgresql", baseUrl, preview, height: 600 });
      },
      { baseUrl: new URL(appBaseUrl).origin, preview: getOfficialPreview("quick-start-postgresql") },
    );
    const readMountHeight = () =>
      page.locator("[data-drizzle-run-embed]").evaluate((element) => element.getBoundingClientRect().height);
    expect(await readMountHeight()).toBe(600);
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    await expect(page.locator("[data-drizzle-run-embed]").getByRole("status")).toHaveText("Loading Drizzle Run…");
    const loadingHeight = await readMountHeight();
    expect(loadingHeight).toBe(600);
    expect(await waitForEmbedDisposition(page)).toBe("inline");

    const frameElement = page.locator("iframe[data-drizzle-run-frame]");
    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");
    const readFrameHeight = () =>
      frameElement.evaluate((element) => Number.parseInt((element as HTMLIFrameElement).style.height, 10));
    const run = frame.getByRole("button", { name: "Run", exact: true });
    await expect(run).toBeEnabled({ timeout: 120_000 });
    expect(Math.abs((await readMountHeight()) - loadingHeight)).toBeLessThanOrEqual(1);
    const heightBeforeRun = await readFrameHeight();
    const editorHeight = await frame
      .locator(".monaco-editor")
      .first()
      .evaluate((element) => element.clientHeight);
    await run.click();
    await expect(frame.getByRole("region", { name: "Users" }).first()).toBeVisible({ timeout: 120_000 });

    expect(heightBeforeRun).toBe(600);
    expect(await readFrameHeight()).toBe(heightBeforeRun);
    const editorHeightAfterRun = await frame
      .locator(".monaco-editor")
      .first()
      .evaluate((element) => element.clientHeight);
    expect(Math.abs(editorHeightAfterRun - editorHeight)).toBeLessThanOrEqual(1);
  });

  test("should put the code beside the output in a wide embed and over it in a narrow one, at the same height", async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium runs an embed live on a page without isolation headers.");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL("/", blogBaseUrl).href);
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    await page.evaluate(
      async ({ baseUrl, preview }) => {
        const loader = await import(new URL("/embed/index.js", window.location.origin).href);

        for (const width of ["720px", "1000px"]) {
          const mountPoint = document.createElement("div");
          mountPoint.style.width = width;
          document.body.append(mountPoint);
          loader.mountPlayground(mountPoint, { example: "quick-start-sqlite", baseUrl, preview, height: 480 });
        }
      },
      { baseUrl: new URL(appBaseUrl).origin, preview: getOfficialPreview("quick-start-sqlite") },
    );
    const mounts = page.locator("[data-drizzle-run-embed]");

    for (const index of [0, 1]) {
      await mounts.nth(index).getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    }

    const frames = page.locator("iframe[data-drizzle-run-frame]");
    const readSplit = async (index: number) => {
      const frame = page.frameLocator("iframe[data-drizzle-run-frame]").nth(index);
      await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
      const [code, output] = await Promise.all(
        [frame.locator(".monaco-editor").first(), frame.getByRole("tablist").last()].map((locator) =>
          locator.evaluate((element) => element.getBoundingClientRect()),
        ),
      );

      return { beside: output.left >= code.right, height: (await mounts.nth(index).boundingBox())?.height };
    };

    await expect(frames).toHaveCount(2);
    expect(await readSplit(0)).toEqual({ beside: false, height: 480 });
    expect(await readSplit(1)).toEqual({ beside: true, height: 480 });
  });

  test("should fill a container the host page gives a height, and take its own height once it loses it", async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium runs an embed live on a page without isolation headers.");
    await page.goto(new URL("/", blogBaseUrl).href);
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    await page.evaluate(
      async ({ baseUrl, preview }) => {
        const loader = await import(new URL("/embed/index.js", window.location.origin).href);
        const mountPoint = document.createElement("div");
        mountPoint.id = "sized-playground-mount";
        mountPoint.style.height = "480px";
        document.body.append(mountPoint);
        loader.mountPlayground(mountPoint, { example: "quick-start-postgresql", baseUrl, preview });
      },
      { baseUrl: new URL(appBaseUrl).origin, preview: getOfficialPreview("quick-start-postgresql") },
    );
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    expect(await waitForEmbedDisposition(page)).toBe("inline");

    const mountPoint = page.locator("#sized-playground-mount");
    const frameElement = page.locator("iframe[data-drizzle-run-frame]");
    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");
    const readFrameBoxHeight = () => frameElement.evaluate((element) => element.getBoundingClientRect().height);
    const run = frame.getByRole("button", { name: "Run", exact: true });
    await expect(run).toBeEnabled({ timeout: 120_000 });
    expect(await readFrameBoxHeight()).toBe(480);

    await run.click();
    await expect(frame.getByRole("region", { name: "Users" }).first()).toBeVisible({ timeout: 120_000 });
    expect(await readFrameBoxHeight()).toBe(480);
    const workAreaBottom = await frame
      .locator("[data-guide='output']")
      .evaluate((panel) => panel.getBoundingClientRect().bottom);
    expect(workAreaBottom).toBeLessThanOrEqual(480);

    await mountPoint.evaluate((element) => {
      (element as HTMLElement).style.height = "";
    });
    await expect.poll(readFrameBoxHeight).toBe(585);

    await page.addStyleTag({ content: "@media (min-width: 1px) { #sized-playground-mount { height: 520px; } }" });
    await expect.poll(readFrameBoxHeight).toBe(520);
  });

  test("should report each side's settled run to the host, and keep the frame's height", async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== "chromium", "Only Chromium runs an embed live on a page without isolation headers.");
    await page.goto(new URL("/", blogBaseUrl).href);
    await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);
    await page.evaluate(
      async ({ baseUrl, preview }) => {
        const testWindow = window as Window & { settledRuns?: unknown[] };
        testWindow.settledRuns = [];
        const loader = await import(new URL("/embed/index.js", window.location.origin).href);
        const mountPoint = document.createElement("div");
        document.body.append(mountPoint);
        loader.mountPlayground(mountPoint, {
          example: "select-vs-relational-queries",
          baseUrl,
          preview,
          onRunSettled: (run: unknown) => testWindow.settledRuns?.push(run),
        });
      },
      { baseUrl: new URL(appBaseUrl).origin, preview: getOfficialPreview("select-vs-relational-queries") },
    );
    await page.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
    expect(await waitForEmbedDisposition(page)).toBe("inline");

    const frame = page.frameLocator("iframe[data-drizzle-run-frame]");
    const runBoth = frame.getByRole("button", { name: "Run both", exact: true });
    await expect(runBoth).toBeEnabled({ timeout: 120_000 });
    await runBoth.click();

    const readSettledRuns = () =>
      page.evaluate(() => (window as Window & { settledRuns?: unknown[] }).settledRuns ?? []);
    await expect.poll(async () => (await readSettledRuns()).length, { timeout: 120_000 }).toBe(2);
    const settledRuns = (await readSettledRuns()) as Array<{
      outcome: string;
      side: number;
      displays: Array<{ label: string; values: unknown[] }>;
      truncated: boolean;
    }>;
    expect(settledRuns.map((run) => run.side).toSorted((first, second) => first - second)).toEqual([0, 1]);

    for (const run of settledRuns) {
      expect(run.outcome).toBe("succeeded");
      expect(run.truncated).toBe(false);
      expect(Object.keys(run).toSorted()).toEqual(["displays", "outcome", "side", "truncated"]);
      expect(run.displays.map((display) => display.label)).toContain("Authors with posts");
    }

    const frameHeight = await page
      .locator("iframe[data-drizzle-run-frame]")
      .evaluate((element) => Number.parseInt((element as HTMLIFrameElement).style.height, 10));
    expect(frameHeight).toBe(585);
  });
});
