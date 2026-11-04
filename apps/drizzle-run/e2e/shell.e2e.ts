import type { APIRequestContext, Locator, Page } from "@playwright/test";

import type { StoredProject } from "../src/store/service";
import { turnOnDebug } from "./debug";
import { replaceEditorCode } from "./editor";
import { answerLeaveWarnings, expect, test } from "./fixtures";
import { postSnapshot } from "./publish";
import { makeStoredPairRecord, makeStoredRecord, olderLegacy, removedNext, serveSnapshot } from "./retired-pair";
import { runStoredProject } from "./run-project";
import { callStore } from "./store";

async function createProject(
  page: Page,
  name: string,
  { database = "SQLite" }: { database?: "SQLite" | "PostgreSQL" } = {},
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: database }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText(name);
}

/** Writes a record into the app's local store as it is, valid or not. */
async function storeProject(page: Page, record: StoredProject): Promise<void> {
  await callStore(page, "saveProjects", [record], []);
}

async function waitForRun(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
}

test("should align site header buttons on desktop and phone", async ({ page }) => {
  await page.goto("/");

  const header = page.getByRole("banner");
  const create = header.getByRole("button", { name: "New project", exact: true });
  const account = header.getByRole("button", { name: "Account", exact: true });

  await expect(create).toHaveCSS("height", "36px");
  await expect(account).toHaveCSS("height", "36px");
  await expect(account).toHaveCSS("width", "36px");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(create).toHaveCSS("height", "44px");
  await expect(account).toHaveCSS("height", "44px");
  await expect(account).toHaveCSS("width", "44px");
});

test("should align the duplicate action with the other project header buttons", async ({ page }) => {
  await createProject(page, "Header sizes");

  const header = page.getByRole("banner");
  const actions = header.getByRole("group", { name: "Project actions" });

  await expect(actions.getByRole("button", { name: "Duplicate" })).toBeVisible();
  await expect(actions).toHaveCSS("height", "36px");
  await expect(actions).toHaveCSS("width", "36px");
  await expect(header.getByRole("button", { name: "Share", exact: true })).toHaveCSS("height", "36px");
  await expect(header.getByRole("button", { name: "More actions", exact: true })).toHaveCSS("height", "36px");
});

for (const slug of ["filters-and-joins", "postgresql-vs-sqlite"]) {
  test(`should align docs and fork actions in the ${slug} header`, async ({ page }) => {
    await page.goto(`/examples/${slug}`);

    const header = page.getByRole("banner");
    const actions = header.getByRole("group", { name: "Project actions" });
    const fork = actions.getByRole("button", { name: "Fork to my projects" });

    await expect(fork).toBeVisible();
    await expect(actions).toHaveCSS("height", "36px");
    await expect(fork).toHaveCSS("width", "34px");
    await expect(header.getByRole("button", { name: "More actions", exact: true })).toHaveCSS("height", "36px");
    await expect(header.getByRole("button", { name: "Account", exact: true })).toHaveCSS("height", "36px");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(fork).toHaveCSS("height", "36px");
    await expect(fork).toHaveCSS("width", "36px");
    await expect(header.getByRole("button", { name: "More actions", exact: true })).toHaveCSS("height", "36px");
  });
}

test("should match layout C: switcher, tabs in file order, run, status bar", async ({ page }) => {
  await createProject(page, "Layout C");

  const tabs = page.getByRole("tablist", { name: "Project files" }).getByRole("tab");
  await expect(tabs).toHaveText(["query.ts", "schema.ts", "seed.ts"]);
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toContainText("SQLite");

  const statusBar = page.getByRole("contentinfo");
  await expect(statusBar.getByRole("link")).toHaveText(["GitHub", "Report an issue", "@rphlmr"]);
  await expect(statusBar.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/rphlmr/drizzle-run",
  );
  await expect(statusBar.getByRole("link", { name: "Report an issue" })).toHaveAttribute(
    "href",
    "https://github.com/rphlmr/drizzle-run/issues/new/choose",
  );
  await expect(statusBar.getByRole("link", { name: "@rphlmr" })).toHaveAttribute("href", "https://x.com/rphlmr");
  await statusBar.getByRole("button", { name: "What we use" }).click();
  await expect(page.getByRole("dialog", { name: "What we use" })).toContainText("PGlite");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "What we use" })).toHaveCount(0);

  await page.getByRole("button", { name: "Switch project" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Layout C/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await waitForRun(page);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Users" })).toContainText("Ada", { timeout: 120_000 });
});

test("should open the selected file in the editor before the runtime is ready", async ({ page }) => {
  const { promise: guest, resolve: releaseGuest } = Promise.withResolvers<void>();
  await page.context().route("**/runtime-assets/**/quickjs/**/execution.guest.js", async (route) => {
    await guest;
    await route.continue();
  });
  await createProject(page, "Editor first");

  await expect(page.getByRole("tab", { name: "query.ts" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-slot=code-preview]")).toContainText("Users");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("Users");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  releaseGuest();
  await waitForRun(page);
  await expect(page.locator("[data-slot=code-preview]")).toHaveCount(0);
});

/** The text of each editor line TypeScript underlines as an error, read from Monaco's rendered lines. */
async function getErrorLines(page: Page): Promise<string[]> {
  return page
    .locator(".monaco-editor")
    .first()
    .evaluate((editor) => {
      const lineTexts = new Map(
        [...editor.querySelectorAll<HTMLElement>(".view-lines .view-line")].map((line) => [
          line.style.top,
          line.textContent?.replaceAll("\u00a0", " ").trim() ?? "",
        ]),
      );
      const errorTops = [...editor.querySelectorAll(".view-overlays .squiggly-error")].map(
        (squiggle) => (squiggle.parentElement as HTMLElement).style.top,
      );

      return [...new Set(errorTops)].map((top) => lineTexts.get(top) ?? "").toSorted();
    });
}

test("should type code against the ES libraries the QuickJS guest implements", async ({ page }) => {
  await createProject(page, "Guest libraries");
  await waitForRun(page);

  const sourceLines = [
    "void Iterator.from([1]).map((value) => value * 2).toArray();",
    "void new Set([1]).union(new Set([2]));",
    "void Promise.try(() => 1);",
    "void new Float16Array(1);",
    'void RegExp.escape(".");',
    'void new Intl.DurationFormat("en");',
    "void Atomics.waitAsync;",
    'void new Intl.NumberFormat("en").formatRange(1, 2);',
  ];
  const editor = page.locator(".monaco-editor .view-lines");
  await replaceEditorCode(page, sourceLines);

  await expect
    .poll(async () => (await editor.innerText()).replace(/\s+/g, ""))
    .toBe(sourceLines.join("").replace(/\s+/g, ""));

  await expect
    .poll(() => getErrorLines(page), { timeout: 30_000 })
    .toEqual([
      "void Atomics.waitAsync;",
      'void new Intl.DurationFormat("en");',
      'void new Intl.NumberFormat("en").formatRange(1, 2);',
    ]);
});

test("should load an approved package's types on its first import, with no reload", async ({ page }) => {
  const typeRequests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());

    if (pathname.startsWith("/runtime-assets/") && pathname.includes("/types/")) {
      typeRequests.push(pathname.slice(pathname.lastIndexOf("/") + 1));
    }
  });
  await createProject(page, "Lazy types");
  await waitForRun(page);

  expect(typeRequests.some((name) => name.startsWith("drizzle-orm__"))).toBe(true);
  expect(typeRequests.some((name) => name.startsWith("zod__"))).toBe(false);

  const sourceLines = [
    'import { z } from "zod";',
    'export const name: string = z.string().parse("Ada");',
    'export const count: number = z.string().parse("Ada");',
  ];
  await replaceEditorCode(page, sourceLines);

  await expect
    .poll(() => getErrorLines(page), { timeout: 30_000 })
    .toEqual(['export const count: number = z.string().parse("Ada");']);
  expect(typeRequests.filter((name) => name.startsWith("zod__"))).toHaveLength(1);
});

for (const { release, releaseChoice, zodModule } of [
  {
    release: "Next",
    releaseChoice: /^RC, newest, orm 1\.0\.0-rc\.5 · kit 1\.0\.0-rc\.5$/,
    zodModule: "drizzle-orm/zod",
  },
  { release: "Legacy", releaseChoice: /^Legacy, /, zodModule: "drizzle-zod" },
]) {
  test(`should type a ${zodModule} schema on a ${release} PostgreSQL project`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Name", { exact: true }).fill(`${zodModule} types`);
    await dialog.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "PostgreSQL" }).click();
    await dialog.getByRole("radio", { name: releaseChoice }).click();
    await dialog.getByRole("button", { name: "Create project", exact: true }).click();
    await waitForRun(page);

    const sourceLines = [
      'import { pgTable, serial, text } from "drizzle-orm/pg-core";',
      `import { createInsertSchema } from "${zodModule}";`,
      'const people = pgTable("people", { id: serial("id").primaryKey(), name: text("name").notNull() });',
      'export const person: { name: string } = createInsertSchema(people).parse({ name: "Ada" });',
      'export const count: number = createInsertSchema(people).parse({ name: "Ada" }).name;',
    ];
    await replaceEditorCode(page, sourceLines);

    await expect
      .poll(() => getErrorLines(page), { timeout: 30_000 })
      .toEqual(['export const count: number = createInsertSchema(people).parse({ name: "Ada" }).name;']);
  });
}

test("should show a failed preparation as a centered card that stays until Try again, with the header usable", async ({
  page,
}) => {
  let guestBlocked = true;
  await page
    .context()
    .route("**/runtime-assets/**/quickjs/**/execution.guest.js", (route) =>
      guestBlocked ? route.abort() : route.continue(),
    );
  await createProject(page, "Failed preparation");

  const dialog = page.getByRole("alertdialog", { name: "Preparation didn't finish" });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "test-results/preparation-failed.png" });

  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2)).toBeLessThan(2);
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - (viewport?.height ?? 0) / 2)).toBeLessThan(2);

  await expect(dialog).toBeFocused();

  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Your files stay as they are.");

  await page.getByRole("button", { name: "Switch project" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Failed preparation/ })).toBeVisible();
  await page.keyboard.press("Escape");

  guestBlocked = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  await waitForRun(page);
});

test("should fail the preparation when the package declarations cannot load, and open once Try again can", async ({
  page,
}) => {
  let typesBlocked = true;
  await page
    .context()
    .route("**/runtime-assets/**/types/**", (route) => (typesBlocked ? route.abort() : route.continue()));
  await createProject(page, "No types", { database: "PostgreSQL" });

  const dialog = page.getByRole("alertdialog", { name: "Preparation didn't finish" });
  await expect(dialog).toBeVisible({ timeout: 60_000 });

  typesBlocked = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  await waitForRun(page);

  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  // One line: Firefox inserts a multi-line text into Monaco twice.
  await page.keyboard.insertText('const wrongType: number = "text";');
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(1, { timeout: 30_000 });
});

test("should keep the edit on a reload right after typing", async ({ page }) => {
  await createProject(page, "Reload keeps edits");
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// typed just before the reload\n");
  // Within the 500 ms save delay the page may warn before it leaves, and the reload itself has to write the edit.
  await answerLeaveWarnings(page, "accept", () => page.reload());

  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Reload keeps edits");
  await expect(editor).toContainText("typed just before the reload");
});

test("should say an edit past the project source limit was not saved, and put the file back", async ({ page }) => {
  const record = makeStoredRecord(crypto.randomUUID(), "Near the source limit", olderLegacy);
  const sourceBytes = Object.values(record.manifest.files).reduce(
    (total, source) => total + new TextEncoder().encode(source).byteLength,
    0,
  );
  const filler = `//${"x".repeat(1024 * 1024 - sourceBytes - 2)}`; // The rest of the 1 MiB source limit.
  await callStore(
    page,
    "saveProjects",
    [{ ...record, manifest: { ...record.manifest, files: { ...record.manifest.files, "notes.ts": filler } } }],
    [],
  );
  await page.goto(`/p/${record.id}`);
  const editor = page.locator(".monaco-editor .view-lines");
  await expect(editor).toBeVisible({ timeout: 120_000 });

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// one line too many");

  await expect(page.getByRole("alert").filter({ hasText: "at most 1048576 UTF-8 bytes" })).toContainText(
    "This edit was not saved, so the file is back to its saved text. Project source may contain at most 1048576 UTF-8 bytes in total.",
  );
  await expect(editor).not.toContainText("one line too many");
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");
});

test("should tell the tab whose unsaved edit another tab's save replaced", async ({ page }) => {
  await createProject(page, "Two tabs");
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");
  const other = await page.context().newPage();
  await other.goto(page.url());
  const otherEditor = other.locator(".monaco-editor .view-lines");
  await expect(otherEditor).toBeVisible();
  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await otherEditor.click();

  await other.keyboard.press("ControlOrMeta+End");
  await other.keyboard.insertText("\n// saved first\n");
  await page.bringToFront();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// typed second\n");

  const notice = page.getByRole("alert").filter({ hasText: "Another tab saved" });
  await expect(notice).toContainText("Another tab saved Two tabs first, so this tab now shows that copy.");
  await expect(editor).toContainText("saved first");
  await expect(editor).not.toContainText("typed second");
  await expect(other.getByRole("alert").filter({ hasText: "Another tab saved" })).toHaveCount(0);

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await other.close();
});

test("should tell a tab whose project another tab deleted that it was deleted", async ({ page }) => {
  await createProject(page, "Deleted elsewhere");
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");
  const other = await page.context().newPage();
  await other.goto("/projects");

  await other.getByRole("checkbox", { name: "Select Deleted elsewhere" }).click();
  await other.getByRole("group", { name: "Selected projects" }).getByRole("button", { name: "Delete" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();

  await expect(page.getByRole("heading", { name: "This project was deleted" })).toBeVisible();
  await expect(page.getByText("It was deleted in this browser, maybe from another tab.")).toBeVisible();
  await expect(page.getByText("Got it from someone?")).toHaveCount(0);
  await other.close();
});

/** The vertical middle of a box, in whole pixels. */
const verticalMiddle = (box: { y: number; height: number } | undefined) =>
  Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2);

test("should turn the first-run card from preparing to ready without moving anything, and stop the loader on reduced motion", async ({
  page,
}) => {
  const { promise: guest, resolve: releaseGuest } = Promise.withResolvers<void>();
  await page.context().route("**/runtime-assets/**/quickjs/**/execution.guest.js", async (route) => {
    await guest;
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createProject(page, "No layout shift");

  const output = page.getByRole("region", { name: "Execution output" });
  const card = output.locator("[data-slot=first-run]").filter({ visible: true });
  const status = output.getByRole("status");
  await expect(card).toContainText("Your results land here");
  await expect(card).toContainText("$.random.fullName()");
  await expect(card).toContainText("Preparing the runtime");
  await expect(status).toHaveText("Preparing runtime");
  await expect(page.getByRole("contentinfo")).toContainText("Preparing runtime");

  const animations = await card.evaluate((element) =>
    [...element.querySelectorAll("line, [role=progressbar] > span")].map(
      (node) => getComputedStyle(node).animationName,
    ),
  );
  expect(animations.length).toBeGreaterThan(0);
  expect(new Set(animations)).toEqual(new Set(["none"]));

  const watchedSelectors = {
    run: "[data-guide=run]",
    runPicker: "[data-slot=run-picker]",
    pill: "section[aria-label='Execution output'] output",
    runtimeStatus: "[data-slot=runtime-status]",
    release: "footer [data-slot=release]",
    cardStatus: "[data-slot=first-run-status]",
    tabs: "[aria-label='Output views']",
  };
  const boxes = () =>
    page.evaluate(
      (selectors) =>
        Object.fromEntries(
          Object.entries(selectors).map(([name, selector]) => {
            const element = [...document.querySelectorAll(selector)].find(
              (item) => item.getBoundingClientRect().width > 0,
            );
            const rect = element?.getBoundingClientRect();

            return [name, rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
          }),
        ),
      watchedSelectors,
    );
  const before = await boxes();
  expect(Object.values(before).every(Boolean)).toBe(true);
  expect(verticalMiddle(before.runPicker)).toBe(verticalMiddle(before.tabs));
  expect(verticalMiddle(before.pill)).toBe(verticalMiddle(before.tabs));
  const previewLine = await page.locator("[data-slot=code-preview] [data-line]").first().boundingBox();

  releaseGuest();
  await waitForRun(page);
  await expect(card).toContainText("Runtime ready");
  await expect(status).toHaveText("Not run yet");
  await expect(page.getByRole("contentinfo")).toContainText("Runtime ready");
  expect(await boxes()).toEqual(before);

  const editorLine = await page.locator(".monaco-editor .view-line > span").first().boundingBox();
  expect(Math.abs((editorLine?.x ?? 0) - (previewLine?.x ?? -1))).toBeLessThanOrEqual(1);
  expect(Math.abs((editorLine?.y ?? 0) - (previewLine?.y ?? -1))).toBeLessThanOrEqual(1);
});

/** Holds the Drizzle packages so the runtime stays preparing until the returned function runs. */
async function holdGuest(page: Page): Promise<() => void> {
  const { promise: guest, resolve: releaseGuest } = Promise.withResolvers<void>();
  await page.context().route("**/runtime-assets/**/quickjs/**/execution.guest.js", async (route) => {
    await guest;
    await route.continue();
  });

  return releaseGuest;
}

/**
 * The boxes of the visible elements that must not move when the runtime turns ready.
 * Waits for web fonts first: a font swapping in moves text by a fraction of a pixel, which is not the shift under test.
 */
function measureVisibleBoxes(page: Page, selectors: Record<string, string>) {
  return page.evaluate(async (wanted) => {
    await document.fonts.ready;

    return Object.fromEntries(
      Object.entries(wanted).map(([name, selector]) => {
        const element = [...document.querySelectorAll(selector)].find((item) => item.getBoundingClientRect().width > 0);
        const rect = element?.getBoundingClientRect();

        return [name, rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
      }),
    );
  }, selectors);
}

async function readLoaderAnimations(card: Locator): Promise<Set<string>> {
  const animations = await card.evaluate((element) =>
    [...element.querySelectorAll("line, [role=progressbar] > span")].map(
      (node) => getComputedStyle(node).animationName,
    ),
  );
  expect(animations.length).toBeGreaterThan(0);

  return new Set(animations);
}

test("should turn the phone first-run card from preparing to ready in place, stop the loader on reduced motion, and run from its Run", async ({
  page,
}) => {
  const releaseGuest = await holdGuest(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createProject(page, "Phone first run");

  const views = page.getByRole("navigation", { name: "Workspace views" });
  await views.getByRole("button", { name: /Output/ }).click();
  const output = page.getByRole("region", { name: "Execution output" });
  const card = output.locator("[data-slot=first-run]").filter({ visible: true });
  await expect(card).toContainText("Preparing the runtime");
  await expect(card).toContainText("$.random.fullName()");
  expect(await readLoaderAnimations(card)).toEqual(new Set(["none"]));

  const selectors = {
    run: "[data-guide=run]",
    views: "nav[aria-label='Workspace views']",
    tabs: "[aria-label='Output views']",
    pill: "section[aria-label='Execution output'] output",
    card: "[data-slot=first-run]",
    cardStatus: "[data-slot=first-run-status]",
  };
  const before = await measureVisibleBoxes(page, selectors);
  expect(Object.values(before).every(Boolean)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  releaseGuest();
  await waitForRun(page);
  await expect(card).toContainText("Runtime ready");
  expect(await measureVisibleBoxes(page, selectors)).toEqual(before);

  const cardRun = card.getByRole("button", { name: "Run this project" });
  const reach = await cardRun.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const hits = (offset: number) => element.contains(document.elementFromPoint(x, box.top + box.height / 2 + offset));

    return { height: box.height, reaches: hits(-21) && hits(21) };
  });
  expect(reach).toEqual({ height: 36, reaches: true });

  const runningLoader = page.waitForFunction(() => {
    const panel = document.querySelector("section[aria-label='Execution output']");

    return panel?.textContent?.includes("Your query is running") && !panel.querySelector("[role=progressbar]");
  });
  await cardRun.click();
  await runningLoader;
  await expect(page.getByRole("region", { name: "Users" })).toContainText("Ada", { timeout: 120_000 });
});

test("should keep the embed first-run card compact, turn it from preparing to ready in place, stop the loader on reduced motion, and run from its Run", async ({
  page,
  request,
}) => {
  const snapshotId = await publishSnapshot(request, "Embed first run");
  const releaseGuest = await holdGuest(page);
  await page.setViewportSize({ width: 760, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/embed/${snapshotId}`);
  test.skip(!(await page.evaluate(() => crossOriginIsolated)), "This browser does not isolate the embed page.");

  const output = page.getByRole("region", { name: "Execution output" });
  const card = output.locator("[data-slot=first-run]").filter({ visible: true });
  await expect(card).toContainText("Preparing the runtime", { timeout: 120_000 });
  await expect(card.locator("dl")).toHaveCount(0);
  await expect(card).toContainText("$.random.fullName()");
  expect(await readLoaderAnimations(card)).toEqual(new Set(["none"]));

  const selectors = {
    run: "[data-guide=run]",
    tabs: "[aria-label='Output views']",
    pill: "section[aria-label='Execution output'] output",
    card: "[data-slot=first-run]",
    cardStatus: "[data-slot=first-run-status]",
  };
  const before = await measureVisibleBoxes(page, selectors);
  expect(Object.values(before).every(Boolean)).toBe(true);

  releaseGuest();
  await waitForRun(page);
  await expect(card).toContainText("Runtime ready");
  expect(await measureVisibleBoxes(page, selectors)).toEqual(before);

  await card.getByRole("button", { name: "Run this project" }).click();
  await expect(page.getByRole("region", { name: sentinel })).toBeVisible({ timeout: 120_000 });
});

test("should show the output in run order, with Logs filters and the folding JSON view", async ({ page }) => {
  await createProject(page, "Timeline");
  await waitForRun(page);
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  const story = output.getByRole("list", { name: "Run story" });
  const logs = output.getByRole("list", { name: "Logs" });
  const storyKinds = () =>
    story.locator(":scope > li").evaluateAll((items) => items.map((item) => item.getAttribute("data-kind")));

  await expect(output.getByRole("tab", { name: "Results" })).toHaveAttribute("aria-selected", "true");
  await expect(output.getByRole("tab")).toHaveText([/^Results/, /^Story/, /^Logs/, /^Problems/]);
  await expect(output.getByRole("tab", { name: "Results" })).toContainText("1");

  await output.getByRole("tab", { name: "Story" }).click();
  await expect.poll(async () => (await storyKinds()).slice(-2)).toEqual(["query", "console"]);
  await expect(story.locator(":scope > li[data-kind=query]")).toContainText("Users");

  await output.getByRole("tab", { name: "Logs" }).click();
  const filters = output.getByRole("group", { name: "Show in Logs" });
  await expect(filters.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: /^Console/ }).click();
  await expect(logs.locator(":scope > li")).toHaveCount(1);
  await expect(logs.locator(":scope > li[data-slot=console-line]")).toContainText("Found 2 users");

  await output.getByRole("tab", { name: "Results" }).click();
  const users = output.getByRole("region", { name: "Users" });

  const footer = users.locator("[data-slot=result-sql]");
  await expect(footer).toContainText(/select/i);
  await footer.getByRole("button", { name: "Expand SQL" }).click();
  await expect(footer.getByRole("button", { name: "Collapse SQL" })).toHaveAttribute("aria-expanded", "true");
  await expect(footer).toContainText("1 statement");
  await footer.getByRole("button", { name: "Show in Logs" }).click();
  await expect(output.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  await expect(filters.getByRole("button", { name: /^SQL/ })).toHaveAttribute("aria-pressed", "true");
  await output.getByRole("tab", { name: "Results" }).click();

  await users.getByRole("group", { name: "Result view" }).getByRole("button", { name: "JSON" }).click();
  await expect(users.getByRole("table")).toHaveCount(0);
  await expect(users.getByRole("button", { name: "Collapse row 1" })).toHaveAttribute("aria-expanded", "true");
  await expect(users.getByRole("button", { name: "Collapse row 2" })).toHaveAttribute("aria-expanded", "true");

  await users.getByRole("button", { name: "Collapse row 2" }).click();
  const second = users.getByRole("button", { name: /"name": "Grace"/ });
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await second.click();
  await expect(users.getByRole("button", { name: "Collapse row 2" })).toHaveAttribute("aria-expanded", "true");

  await users.getByRole("group", { name: "Result view" }).getByRole("button", { name: "Table" }).click();
  await expect(users.getByRole("table")).toContainText("Grace");
});

test("should tell the run as Story cards and list every statement in Logs", async ({ page }) => {
  await createProject(page, "Rows");
  await waitForRun(page);
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  const story = output.getByRole("list", { name: "Run story" });
  const cards = story.locator(":scope > li");
  const files = page.getByRole("tablist", { name: "Project files" });

  await output.getByRole("tab", { name: "Story" }).click();
  await expect(cards.first()).toHaveAttribute("data-kind", "setup");
  const setup = cards.first().getByRole("button", { name: /^seed\.ts ran first: \d+ statements?, \d+ rows?/ });
  await expect(setup).toHaveAttribute("aria-expanded", "false");
  await expect(cards.first().locator("[data-slot=sql-line]")).toHaveCount(0);
  await setup.click();
  await expect(setup).toHaveAttribute("aria-expanded", "true");
  await expect(cards.first().locator("[data-slot=sql-line]").first()).toContainText(/create table/i);

  await story
    .locator(":scope > li[data-kind=query]")
    .getByRole("button", { name: /^query\.ts:\d+$/ })
    .click();
  await expect(files.getByRole("tab", { name: "query.ts" })).toHaveAttribute("aria-selected", "true");

  await output.getByRole("tab", { name: "Logs" }).click();
  await output.getByRole("group", { name: "Show in Logs" }).getByRole("button", { name: /^SQL/ }).click();
  const logs = output.getByRole("list", { name: "Logs" }).locator(":scope > li");
  await expect
    .poll(() => logs.evaluateAll((items) => items.map((item) => item.getAttribute("data-slot"))))
    .toEqual(["setup-line", "sql-line"]);
  const folded = logs.first().getByRole("button", { name: /^\d+ statements? folded$/ });
  await expect(folded).toHaveAttribute("aria-expanded", "false");
  await folded.click();
  await logs
    .first()
    .getByRole("button", { name: /^seed\.ts:\d+$/ })
    .first()
    .click();
  await expect(files.getByRole("tab", { name: "seed.ts" })).toHaveAttribute("aria-selected", "true");
  const query = logs.nth(1).getByRole("button", { name: /^SQL: select/i });
  await query.click();
  await expect(query).toHaveAttribute("aria-expanded", "true");

  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("button", { name: /Output/ })
    .click();
  await output.getByRole("tab", { name: "Story" }).click();
  await expect(cards.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("should show the Drizzle Run report: phases, machine states, and the raw JSON", async ({ page }) => {
  await createProject(page, "Report");
  await waitForRun(page);

  const output = page.getByRole("region", { name: "Execution output" });
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  await expect(output.getByRole("tab", { name: "Debug" })).toHaveCount(0);

  await turnOnDebug(page);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  await output.getByRole("tab", { name: "Debug" }).click();

  const report = output.getByRole("tabpanel", { name: "Debug" });
  await expect(report.getByRole("heading", { name: "Drizzle Run report" })).toBeVisible();
  await expect(report).toContainText(/Run 2 · \d/);
  await expect(report.getByRole("note")).toContainText("How Drizzle Run itself prepared and ran this project.");
  await expect(report.locator("dt")).toHaveText([
    "Release pair",
    "Database",
    "Guest",
    "Browser",
    "Events",
    "Runtime issues",
    "Libraries",
  ]);
  await expect(report.locator("dd").first()).toHaveText(/^orm \S+ · kit \S+$/);

  const phases = report.getByRole("region", { name: "Drizzle Run phases" }).locator("[data-slot=phase]");
  await expect
    .poll(() => phases.evaluateAll((items) => items.map((item) => item.getAttribute("data-phase"))))
    .toEqual([
      "validate",
      "resolve",
      "load_artifacts",
      "compile",
      "evaluate_schema",
      "generate_bootstrap",
      "open_database",
      "apply_bootstrap",
      "initialize_context",
      "seed",
      "run",
      "inspect",
      "plan",
      "cleanup",
    ]);

  const states = report.getByRole("region", { name: "Run machine states" });
  await expect(states).toContainText(/\d+ transitions in Drizzle Run/);
  await expect(states.getByRole("row").last()).toContainText("succeeded");

  const raw = report.getByRole("region", { name: "Report JSON" });
  await expect(raw.locator("summary")).toContainText("states, timings, events, sql, diagnostics");
  await expect(raw.locator("summary")).toContainText(/\d+ (?:B|KB|MB) · JSON/);
  await expect(raw.locator("pre")).toBeHidden();
  await raw.locator("summary").click();
  await expect(raw.locator("pre")).toBeVisible();
  const shown = JSON.parse(await raw.locator("pre").innerText()) as {
    states: unknown[];
    timings: Record<string, number>;
  };
  expect(shown.states.length).toBeGreaterThan(0);
  expect(shown.timings.total).toBeGreaterThan(0);

  const download = page.waitForEvent("download");
  await report.getByRole("button", { name: "Download report" }).click();
  expect((await download).suggestedFilename()).toBe("drizzle-run-debug.json");
  await expect(report.getByRole("button", { name: "Copy JSON" })).toBeVisible();
});

test("should show each earlier run's own output again from the run history", async ({ page }) => {
  await createProject(page, "History");
  await waitForRun(page);

  const output = page.getByRole("region", { name: "Execution output" });
  const story = output.getByRole("list", { name: "Run story" });
  const logs = output.getByRole("list", { name: "Logs" });
  const runs = output.getByRole("button", { name: /^Run history/ });

  await expect(runs).toHaveCount(0);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  await expect(runs).toHaveAccessibleName("Run history");
  await output.getByRole("tab", { name: "Story" }).click();
  await expect(story).toContainText("Found 2 users");
  await output.getByRole("tab", { name: "Logs" }).click();
  await expect(logs.getByRole("button", { name: /^query\.ts:\d+$/ }).first()).toHaveText("query.ts:4");

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText('throw new Error("second run broke");');
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(output.getByRole("status")).toHaveText(/^Failed/, { timeout: 120_000 });
  await expect(output.getByRole("tab", { name: "Problems" })).toHaveAttribute("aria-selected", "true");
  await expect(runs).toHaveAccessibleName("Run history");

  await runs.click();
  const menu = page.getByRole("dialog", { name: "Runs in this tab" });
  await expect(menu).toContainText("2 runs");
  await expect(menu.getByRole("button")).toHaveText([/^Run 2 · now.*second run broke/, /^Run 1 · now.*Users · 2 rows/]);
  await expect(menu).toContainText("Picking a run shows its output, not its code.");
  await menu.getByRole("button", { name: /^Run 1/ }).click();

  await expect(runs).toHaveAccessibleName("Run history, showing Run 1");
  await expect(output.getByRole("note")).toContainText("Run 1 from just now");
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/);
  await expect(output.getByRole("tab", { name: "Problems" })).toHaveAttribute("aria-selected", "true");
  await output.getByRole("tab", { name: "Story" }).click();
  await expect(story).toContainText("Found 2 users");
  await expect(output).toContainText("Edited since this run.");

  await output.getByRole("button", { name: "Back to latest" }).click();
  await expect(output.getByRole("status")).toHaveText(/^Failed/);
  await expect(runs).toHaveAccessibleName("Run history");
  await expect(output).toContainText("second run broke");
});

test("should show a failed run's error under its line and as a card in Problems", async ({ page, browserName }) => {
  await createProject(page, "Failed run");
  await waitForRun(page);

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  // One indented line: Monaco closes braces on its own, so a typed block would not parse.
  await page.keyboard.insertText('    throw new Error("card boom");');
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText(/^Failed · [\d.]+ m?s$/, { timeout: 120_000 });

  const pill = page.locator(".run-error-pill");
  await expect(pill).toHaveText("card boom");
  const pillLeft = (await pill.boundingBox())?.x ?? 0;
  const throwToken = page.locator(".view-line span span", { hasText: /^throw\s?$/ });
  const lineLeft = (await throwToken.boundingBox())?.x ?? 0;
  expect(Math.abs(pillLeft - lineLeft)).toBeLessThan(2);

  const card = output.getByRole("list", { name: "Problems" }).getByRole("alert");
  await expect(card).toContainText("Run error");
  await expect(card).toContainText("card boom");
  await expect(card.getByRole("button", { name: /^query\.ts:1:\d+$/ })).toBeVisible();

  await page.getByRole("tab", { name: "schema.ts" }).click();
  await expect(pill).toHaveCount(0);
  await card.getByRole("button", { name: "Open query.ts" }).click();
  await expect(page.getByRole("tab", { name: "query.ts" })).toHaveAttribute("aria-selected", "true");
  await expect(pill).toHaveText("card boom");

  if (browserName === "chromium") {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await card.getByRole("button", { name: "Copy error" }).click();
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^Run error: card boom\n {4}at query\.ts:1:\d+$/,
    );
  }
});

test("should show a syntax error once, as a located compile error, with no cleanup card", async ({ page }) => {
  await createProject(page, "Syntax error");
  await waitForRun(page);

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("const broken = ;");
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText(/^Failed · [\d.]+ m?s$/, { timeout: 120_000 });

  const cards = output.getByRole("list", { name: "Problems" }).getByRole("alert");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Compile error");
  await expect(cards).toContainText('Unexpected ";"');
  await expect(cards.getByRole("button", { name: /^query\.ts:1:\d+$/ })).toBeVisible();
});

test("should chip a transaction's line without moving the code while typing", async ({ page }) => {
  await createProject(page, "Run notes");
  await waitForRun(page);

  await replaceEditorCode(page, [
    'import { db } from "@drizzle-run/runtime/context";',
    'import { users } from "./schema";',
    "await db.transaction(async (tx) => tx.select().from(users));",
    'console.log("logged once");',
    '$.display("Users", await db.select().from(users));',
  ]);
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });

  const chip = page.locator(".view-line .run-note-eol");
  await expect(chip).toHaveText("committed · 1 query");
  await expect(page.locator(".view-line .run-note-detail")).toHaveText(/^\s·\s\d+\sms$/);
  await expect(page.locator(".run-note-zone")).toHaveCount(0);

  const below = page.locator(".view-line", { hasText: "console.log" });
  const card = output.getByText("Users", { exact: true }).first();
  const before = {
    chip: await chip.boundingBox(),
    below: await below.boundingBox(),
    card: await card.boundingBox(),
  };
  await page.locator(".view-line", { hasText: "await db.transaction" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" // more");
  await expect(page.locator(".view-line", { has: page.locator(".run-note-eol") })).toContainText("// more");
  expect((await chip.boundingBox())?.y).toBe(before.chip?.y);
  expect((await below.boundingBox())?.y).toBe(before.below?.y);
  await expect(output.getByText("Edited since this run.")).toBeVisible();
  expect((await card.boundingBox())?.y).toBe(before.card?.y);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator(".run-note-zone .run-note-chip")).toHaveText(["committed · 1 query"]);
});

test("should format the code on Run, and leave it as typed once Format on run is off", async ({ page }) => {
  await createProject(page, "Format on run");
  await waitForRun(page);

  const run = page.getByRole("button", { name: "Run", exact: true });
  const output = page.getByRole("region", { name: "Execution output" });
  const code = page.locator(".monaco-editor .view-lines");

  await replaceEditorCode(page, ["const   first=1;$.display( 'First run',[ { first } ] )"]);
  await run.click();
  await expect(output).toContainText("First run", { timeout: 120_000 });
  await expect(code).toContainText("const first = 1;");
  await expect(code).toContainText('$.display("First run", [{ first }]);');

  await page.getByRole("button", { name: "More actions" }).click();
  const toggle = page.getByRole("menuitemcheckbox", { name: "Format on run" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  // The formatted code saves after a short delay, and a reload before it would rightly warn.
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");
  await page.reload();
  await waitForRun(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  await replaceEditorCode(page, ["const   second=2;$.display( 'Second run',[ { second } ] )"]);
  await run.click();
  await expect(output).toContainText("Second run", { timeout: 120_000 });
  await expect(code).toContainText("const second=2;$.display( 'Second run',[ { second } ] )");
});

test("should keep the code as typed, and no run, when a run is cancelled while it formats", async ({ page }) => {
  let releasePrettier!: () => void;
  const prettierHeld = new Promise<void>((resolve) => {
    releasePrettier = resolve;
  });
  await page.route("**/assets/standalone-*.js", async (route) => {
    await prettierHeld;
    await route.continue();
  });
  await createProject(page, "Cancel while formatting");
  await waitForRun(page);

  const output = page.getByRole("region", { name: "Execution output" });
  const code = page.locator(".monaco-editor .view-lines");

  await replaceEditorCode(page, ["const   kept=1;$.display( 'Kept',[ { kept } ] )"]);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(output.getByText("✓ Runtime ready")).toBeVisible();

  const prettierLoaded = page.waitForResponse(/\/assets\/standalone-.*\.js$/);
  releasePrettier();
  await prettierLoaded;
  await page.waitForTimeout(1_000);
  await expect(code).toContainText("const kept=1;$.display( 'Kept',[ { kept } ] )");
  await expect(output.getByText("Edited since this run.")).toHaveCount(0);
});

test("should explain a query error in libSQL's words and open the file the hint names", async ({ page }) => {
  await createProject(page, "Query error");
  await waitForRun(page);

  await replaceEditorCode(page, [
    'import { db } from "@drizzle-run/runtime/context";',
    'import { sql } from "drizzle-orm";',
    "await db.all(sql`select * from accounts`);",
  ]);
  await page.getByRole("button", { name: "Run", exact: true }).click();

  const card = page.locator("[data-kind=problem]");
  await expect(card.getByText("Query error", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText("no such table: accounts");
  await expect(card).toContainText("The table wasn't created for this run. Check that schema.ts exports it.");
  await card.getByRole("button", { name: "Open schema.ts" }).click();
  await expect(page.getByRole("tab", { name: "schema.ts" })).toHaveAttribute("aria-selected", "true");
});

test("should switch code and output on a phone, and switch to output on run", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await createProject(page, "Phone");

  const views = page.getByRole("navigation", { name: "Workspace views" });
  await expect(views.getByRole("button", { name: "Code" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Editor" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Execution output" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await waitForRun(page);
  const targets = [
    views.getByRole("button", { name: "Output" }),
    page.getByRole("tab", { name: "query.ts" }),
    page.getByRole("button", { name: "Add helper file" }),
    page.getByRole("button", { name: "More actions" }),
    page.getByRole("button", { name: "Run", exact: true }),
    page.getByRole("button", { name: "Switch project" }),
  ];

  for (const target of targets) {
    const reach = await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hits = (offset: number) => element.contains(document.elementFromPoint(x, y + offset));

      return box.height >= 44 || (hits(-21) && hits(21));
    });

    expect(reach, String(target)).toBe(true);
  }

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(views.getByRole("button", { name: /Output/ })).toHaveAttribute("aria-current", "page", {
    timeout: 120_000,
  });
  await expect(page.getByRole("region", { name: "Users" })).toContainText("Ada");

  await views.getByRole("button", { name: "Code" }).click();
  await expect(page.getByRole("region", { name: "Editor" })).toBeVisible();

  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Debug" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("menuitem", { name: "Drizzle release…" }).click();
  const release = page.getByRole("dialog", { name: "Drizzle release" });
  await expect(release.getByRole("button", { pressed: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(release).toHaveCount(0);

  await page.getByRole("button", { name: "More actions" }).click();
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items.nth(-4)).toHaveText("What we use");
  await expect(items.nth(-3)).toHaveText("GitHub");
  await expect(items.nth(-3)).toHaveAttribute("href", "https://github.com/rphlmr/drizzle-run");
  await expect(items.nth(-2)).toHaveText("Report an issue");
  await expect(items.nth(-2)).toHaveAttribute("href", "https://github.com/rphlmr/drizzle-run/issues/new/choose");
  await expect(items.nth(-1)).toHaveText("@rphlmr");
  await expect(items.nth(-1)).toHaveAttribute("href", "https://x.com/rphlmr");
  await items.nth(-4).click();
  await expect(page.getByRole("dialog", { name: "What we use" })).toContainText("PGlite");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "What we use" })).toHaveCount(0);
});

const sentinel = "shared-link-sentinel";

async function publishSnapshot(request: APIRequestContext, name: string): Promise<string> {
  const response = await postSnapshot(request, {
    data: {
      snapshotVersion: 1,
      name,
      manifest: {
        kind: "drizzle-run",
        manifestVersion: 1,
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
        entrypoints: { schema: "schema.ts", run: "query.ts" },
        files: {
          "schema.ts":
            'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const records = sqliteTable("records", { id: integer("id").primaryKey() });\n',
          "query.ts": `$.display("${sentinel}", [{ ran: true }]);\n`,
        },
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);

  const body: { id: string } = await response.json();
  expect(body).toMatchObject({ id: expect.any(String) });

  return body.id;
}

test("should show a shared link's badge, fork and banner, without auto-run", async ({ page, request }) => {
  const snapshotId = await publishSnapshot(request, "Shared layout");
  await page.goto(`/s/${snapshotId}`);

  await expect(page.getByText("Shared snapshot", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This is a temporary copy. Shared code runs only when you press Run. Fork it to keep your edits."),
  ).toBeVisible();
  await waitForRun(page);
  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText("Not run yet");
  await expect(output.locator("[data-slot=first-run]").filter({ visible: true })).toContainText("Runtime ready");
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("region", { name: sentinel })).toHaveCount(0);
  await expect(output.getByRole("status")).toHaveText("Not run yet");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: sentinel })).toContainText("true", { timeout: 120_000 });

  await page.getByRole("button", { name: "Fork to my projects" }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Shared layout");
});

test("should choose a theme before opening a project", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/examples");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/examples/quick-start-postgresql");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/community");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("should paint the dark theme before the app loads", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 10, 10)");
});

test("should follow the system theme when storage is blocked", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage is blocked", "SecurityError");
    };
  });
  await page.goto("/");

  // Playwright's Firefox drops color scheme emulation on cross-origin isolated pages, so compare with what the page
  // reports.
  const systemDark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  await expect(page.locator("html")).toHaveAttribute("data-theme", systemDark ? "dark" : "light");
  await expect(page.getByRole("heading", { name: "Write a schema. Seed it. Run a query." })).toBeVisible();
});

test("should keep the mobile typing field at 16px without enlarging the code", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "WebKit uses the textarea; Chromium uses native EditContext.");

  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, "Mobile typing");
  await waitForRun(page);

  const input = page.locator(".monaco-editor textarea.inputarea");
  const code = page.locator(".monaco-editor .view-lines");
  await expect(input).toHaveCSS("font-size", "16px");
  await expect(code).toHaveCSS("font-size", "12.5px");

  await input.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("// Mobile typing\n");

  await expect(code).toContainText("// Mobile typing");
  await expect(input).toHaveCSS("font-size", "16px");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(input).toHaveCSS("font-size", "12.5px");
});

test("should set the editor's code size from the menu and keep it on reload", async ({ page }) => {
  await createProject(page, "Code size");
  await waitForRun(page);
  const code = page.locator(".monaco-editor .view-lines");
  await expect(code).toHaveCSS("font-size", "12.5px");
  await expect(code).toHaveCSS("line-height", "22px");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitemradio", { name: "14 px", exact: true }).click();

  await expect(code).toHaveCSS("font-size", "14px");
  await expect(code).toHaveCSS("line-height", "25px");
  // Monaco draws the margin in a later frame than the lines.
  const firstLineNumber = page.locator(".monaco-editor .line-numbers").filter({ hasText: /^1$/ });
  const firstLine = page.locator(".monaco-editor .view-line").filter({ hasText: "@drizzle-run/runtime/context" });
  await expect
    .poll(async () => {
      const [lineNumber, line] = await Promise.all([firstLineNumber.boundingBox(), firstLine.boundingBox()]);

      return { top: (lineNumber?.y ?? 0) - (line?.y ?? -1), height: lineNumber?.height };
    })
    .toEqual({ top: 0, height: 25 });

  await page.reload();
  await waitForRun(page);
  await expect(code).toHaveCSS("font-size", "14px");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitemradio", { name: /^Default/ }).click();
  await expect(code).toHaveCSS("font-size", "12.5px");
  await expect(code).toHaveCSS("line-height", "22px");
});

test("should duplicate the project from the header, open the copy, and offer the way back", async ({ page }) => {
  await createProject(page, "Original");
  const projectUrl = page.url();

  await page.getByRole("group", { name: "Project actions" }).getByRole("button", { name: "Duplicate" }).click();

  await expect(page).not.toHaveURL(projectUrl);
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Original copy");
  const toast = page.getByRole("status").filter({ hasText: "Duplicated as" });
  await expect(toast).toContainText("Duplicated as Original copy");
  await toast.getByRole("link", { name: "Open the original" }).click();
  await expect(page).toHaveURL(projectUrl);
  await expect(toast).toHaveCount(0);
});

test("should ask for a project name in the dialog, not in a browser bubble", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  const name = dialog.getByLabel("Name", { exact: true });

  await name.fill("   ");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();

  await expect(dialog.getByRole("alert")).toHaveText("Give the project a name.");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await name.fill("Named");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("should turn the seed off and on from the seed tab", async ({ page }) => {
  await createProject(page, "Seed switch");
  await waitForRun(page);
  const seedTab = page.getByRole("tab", { name: /^seed\.ts/ });
  const seedSwitch = page.getByRole("switch", { name: "Seed on each run" });

  await expect(seedSwitch).toHaveCount(0);
  await seedTab.click();
  await expect(seedSwitch).toBeChecked();
  await expect(seedTab).toHaveText("seed.ts");

  await seedSwitch.click();

  await expect(seedSwitch).not.toBeChecked();
  await expect(seedTab).toHaveText("seed.tsOff");
  await expect(page.getByText("Off: runs skip this file and start with empty tables.")).toBeVisible();
  await expect(page.getByRole("button", { name: "File actions" })).toHaveCount(0);

  await seedSwitch.click();
  await expect(seedSwitch).toBeChecked();
  await expect(seedTab).toHaveText("seed.ts");
});

test("should keep files and prepare again on a release switch", async ({ page }) => {
  await createProject(page, "Release switch");
  // Hidden text has no innerText, so wait until the editor shows.
  await waitForRun(page);

  const editor = page.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText("Users");
  const before = await editor.innerText();

  const chip = page.getByRole("contentinfo").getByRole("button", { name: /^Drizzle version/ });
  await expect(chip).toContainText("Drizzle");
  await chip.click();
  const picker = page.getByRole("dialog", { name: "Drizzle version" });
  await expect(picker).toContainText("Tested ORM and Kit pairs");
  const [chipBox, pickerBox] = await Promise.all([chip.boundingBox(), picker.boundingBox()]);
  expect(chipBox).not.toBeNull();
  expect((pickerBox?.y ?? Infinity) + (pickerBox?.height ?? 0)).toBeLessThanOrEqual(chipBox?.y ?? 0);
  await picker.getByRole("group", { name: "RC" }).getByRole("button").first().click();
  await expect(chip).toContainText("1.0.0");
  await waitForRun(page);
  await expect.poll(() => editor.innerText()).toBe(before);

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
});

test("should show the capability messages", async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "WebAssembly", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "SharedArrayBuffer", { configurable: true, value: undefined });
  });
  await createProject(page, "Capabilities");

  const appMessage = page.getByRole("alert").filter({ hasText: "Drizzle Run can't run in this browser" });
  await expect(appMessage).toContainText("WebAssembly", { timeout: 120_000 });
  await expect(appMessage.getByRole("button", { name: /Copy link/ })).toBeVisible();

  const snapshotId = await publishSnapshot(request, "Capability embed");
  // Without WebAssembly the store cannot keep the new project, so the page warns before it leaves.
  const warnings = await answerLeaveWarnings(page, "accept", () => page.goto(`/embed/${snapshotId}`));
  expect(warnings.map((warning) => warning.type())).toEqual(["beforeunload"]);

  const embedMessage = page.getByRole("alert").filter({ hasText: "This browser can't run the playground" });
  await expect(embedMessage).toContainText("WebAssembly", { timeout: 120_000 });
  await expect(embedMessage.getByRole("link", { name: /Open in a new tab/ })).toHaveCount(0);
});

for (const width of [1280, 375]) {
  test(`no horizontal scroll with a long name and many helpers at ${width} px`, async ({ page }) => {
    const projectId = `wide-project-${width}`;
    const name = "A very long project name ".repeat(5).slice(0, 120);
    const now = new Date().toISOString();
    const helpers = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `helper-with-a-long-name-${index + 1}.ts`,
        `export const value${index + 1} = ${index + 1};\n`,
      ]),
    );
    const record = {
      version: 1,
      id: projectId,
      name,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      trust: "trusted" as const,
      manifest: {
        kind: "drizzle-run",
        manifestVersion: 1,
        target: { dialect: "sqlite" },
        dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
        entrypoints: { schema: "schema.ts", run: "query.ts" },
        files: {
          "schema.ts":
            'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const records = sqliteTable("records", { id: integer("id").primaryKey() });\n',
          "query.ts": '$.display("Wide", [{ ok: true }]);\n',
          ...helpers,
        },
      },
    };

    await page.setViewportSize({ width, height: 812 });
    await storeProject(page, record);
    await page.goto(`/p/${projectId}`);

    await expect(page.getByRole("button", { name: "Switch project" })).toContainText(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("should ask for a new pair before importing an export on a removed Next pair", async ({ page }) => {
  const { manifest } = makeStoredRecord("unused", "Unused", removedNext);
  await page.goto("/projects");

  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Choose file")
    .setInputFiles({
      name: "old-pair.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ version: 1, name: "Imported old pair", manifest })),
    });

  const dialog = page.getByRole("dialog", { name: "Choose a Drizzle release" });
  await expect(dialog).toContainText("orm 1.0.0-rc.3 · kit 1.0.0-rc.3");
  await expect(dialog.getByRole("button", { name: "Don't import" })).toBeVisible();
  await dialog.getByRole("button", { name: "Use this release" }).click();

  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Imported old pair");
  await expect(page.getByRole("button", { name: /^Drizzle version: orm 1\.0\.0-rc\.5/ })).toBeVisible();
});

test("should report a mixed backup in one banner that follows the release chooser", async ({ page }) => {
  const { manifest } = makeStoredRecord("unused", "Unused", removedNext);
  const readable = makeStoredRecord("unused-readable", "Readable", {
    "drizzle-orm": "1.0.0-rc.5",
    "drizzle-kit": "1.0.0-rc.5",
  });
  const backup = [
    { version: 1, name: "Readable", manifest: readable.manifest },
    { version: 1, name: "Old one", manifest },
    { version: 1, name: "Old two", manifest },
    { version: 1, name: "Unreadable" },
  ];
  await page.goto("/projects");

  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Choose file")
    .setInputFiles({
      name: "drizzle-run-projects.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });

  // The chooser is modal, so the banner behind it is out of the accessibility tree until it closes.
  const banner = page.locator("[role=alert]").filter({ hasText: /^Imported/ });
  await expect(banner).toContainText("Imported 1 project, and 2 more once a release is chosen.");
  await expect(banner).toContainText("Project 4 of 4 could not be read");
  await expect(page.locator("[role=alert], output").filter({ hasText: "could not be read" })).toHaveCount(1);

  const dialog = page.getByRole("dialog", { name: "Choose a Drizzle release" });
  await dialog.getByRole("button", { name: "Don't import" }).click();
  await expect(banner).toContainText("Imported 1 project, and 1 more once a release is chosen.");
  await expect(banner).toContainText("1 project left out, as you chose.");
  await dialog.getByRole("button", { name: "Use this release" }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("alert").filter({ hasText: "Imported 2 projects." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Old two", exact: true })).toBeVisible();
});

test("should state the helper path rule as the check does, with no renaming note for a new file", async ({ page }) => {
  await createProject(page, "Helper rule");

  await page.getByRole("button", { name: "Add helper file" }).click();
  const dialog = page.getByRole("dialog", { name: "New helper file" });
  await expect(dialog).toContainText(
    "Use a relative path ending in .ts, .tsx, .mts, .js, .jsx, .mjs, .json, or .sql, in lowercase.",
  );
  await expect(dialog).not.toContainText("Renaming");

  await dialog.getByRole("textbox", { name: "File path" }).fill("SEED.TS");
  await dialog.getByRole("button", { name: "Save file" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Use a relative .ts, .tsx, .mts, .js, .jsx, .mjs, .json, or .sql path.",
  );
});

test("should ask for a new pair for a project on a removed Next pair", async ({ page }) => {
  await storeProject(page, makeStoredRecord("removed-pair-project", "Removed pair", removedNext));
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Choose a Drizzle release" });
  await expect(dialog).toContainText("orm 1.0.0-rc.3 · kit 1.0.0-rc.3");
  await expect(dialog.getByRole("radio", { name: /^RC, newest, orm 1\.0\.0-rc\.5/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use this release" }).click();

  await expect(page).toHaveURL(/\/p\/removed-pair-project$/);
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Removed pair");
  await expect(page.getByRole("button", { name: /^Drizzle version: orm 1\.0\.0-rc\.5/ })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");

  await page.reload();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Removed pair");
  await expect(dialog).toHaveCount(0);
});

test("should ask for a new pair for each removed side of a side-by-side project", async ({ page }) => {
  await storeProject(page, makeStoredPairRecord("removed-side-project", "Removed side", removedNext));
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Choose a Drizzle release" });
  await expect(dialog).toContainText("uses orm 1.0.0-rc.3 · kit 1.0.0-rc.3 on side 2 (rc.3), which");
  await expect(dialog.getByText("Release for side 2 (rc.3)")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /^RC, newest, orm 1\.0\.0-rc\.5/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Use this release" }).click();

  await expect(page).toHaveURL(/\/p\/removed-side-project$/);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Removed side");
  await expect(page.getByRole("contentinfo")).toContainText("Saved in this browser");

  await page.reload();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Removed side");
  await expect(dialog).toHaveCount(0);
});

test("should open a project on an older Legacy version on the Legacy pair without asking", async ({ page }) => {
  await storeProject(page, makeStoredRecord("older-legacy-project", "Older Legacy", olderLegacy));
  await page.goto("/p/older-legacy-project");

  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Older Legacy");
  await expect(page.getByRole("button", { name: /^Drizzle version: orm 0\.45\.4/ })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Choose a Drizzle release" })).toHaveCount(0);
});

test("should say why for a shared link on a removed Next pair, and open it with a chosen release", async ({ page }) => {
  await serveSnapshot(page, "removed-next-link", removedNext);
  await page.goto("/s/removed-next-link");

  const panel = page.getByRole("region", { name: "Choose a Drizzle release" });
  await expect(panel).toContainText("was shared with orm 1.0.0-rc.3 · kit 1.0.0-rc.3");
  await expect(panel).toContainText("can't run as published");
  await expect(panel.getByRole("radio", { name: /^RC, newest, orm 1\.0\.0-rc\.5/ })).toBeChecked();
  await expect(page.getByRole("link", { name: "Back to projects" })).toBeVisible();
  await panel.getByRole("button", { name: "Open with this release" }).click();

  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("note")).toContainText("It was shared with orm 1.0.0-rc.3 · kit 1.0.0-rc.3");
  await expect(page.getByRole("button", { name: /^Drizzle version: orm 1\.0\.0-rc\.5/ })).toBeVisible();
});

test("should open a shared link on an older Legacy version directly", async ({ page }) => {
  await serveSnapshot(page, "older-legacy-link", olderLegacy);
  await page.goto("/s/older-legacy-link");

  await expect(page.getByRole("button", { name: /^Drizzle version: orm 0\.45\.4/ })).toBeVisible();
  await expect(page.getByRole("note")).not.toContainText("It was shared with");
  await expect(page.getByRole("region", { name: "Choose a Drizzle release" })).toHaveCount(0);
});

test("should link and serve the logo favicon", async ({ page }) => {
  await page.goto("/");

  for (const [href, type] of [
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/"],
  ] as const) {
    await expect(page.locator(`link[rel="icon"][href="${href}"]`)).toHaveCount(1);
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(type);
  }
});

test("should switch to the phone layout at 780 px, in the layout and the styles alike", async ({ page }) => {
  await page.setViewportSize({ width: 779, height: 800 });
  await createProject(page, "Boundary");

  const views = page.getByRole("navigation", { name: "Workspace views" });
  const headerBackground = () =>
    page.getByRole("banner").evaluate((header) => getComputedStyle(header).backgroundColor);
  await expect(views).toBeVisible();
  expect(await headerBackground()).not.toBe("rgba(0, 0, 0, 0)");

  await page.setViewportSize({ width: 780, height: 800 });
  await expect(views).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Project files" })).toBeVisible();
  expect(await headerBackground()).toBe("rgba(0, 0, 0, 0)");
});

test("should show the focus ring on buttons and switches, and an accent border on inputs, on keyboard focus", async ({
  page,
}) => {
  await createProject(page, "Focus rings");
  await waitForRun(page);

  /** The focused element's outline when it is the wanted primitive, else undefined. */
  const ringOn = (slot: string) =>
    page.evaluate((wanted) => {
      const active = document.activeElement;

      if (active?.getAttribute("data-slot") !== wanted) {
        return undefined;
      }

      const style = getComputedStyle(active);

      return `${style.outlineStyle} ${style.outlineWidth}`;
    }, slot);

  // Tab stays inside the editor, so the search starts from the output gear's popover.
  const openOutputSettings = async () => {
    await page.getByRole("button", { name: "Output settings" }).focus();
    await page.keyboard.press("Enter");
    const popover = page.getByRole("dialog", { name: "Output" });
    await expect(popover).toBeVisible();
    // Tab before the popover takes focus leaves it, and it closes.
    await expect.poll(() => popover.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  };

  for (const [slot, start] of [
    ["button", () => page.locator("body").click({ position: { x: 1, y: 1 } })],
    ["switch", openOutputSettings],
  ] as const) {
    await start();
    // The popover may hand focus to its switch as it opens.
    let ring: string | undefined = await ringOn(slot);

    for (let press = 0; press < 40 && ring === undefined; press += 1) {
      await page.keyboard.press("Tab");
      ring = await ringOn(slot);
    }

    expect(ring, `a ${slot} takes keyboard focus`).toBeDefined();
    // Buttons transition every property, so the outline width settles after a few frames.
    await expect.poll(() => ringOn(slot), { message: `a ${slot} shows the focus halo` }).toBe("solid 3px");
  }

  await page.getByRole("button", { name: "Add helper file" }).click();
  // A Tab before the dialog focuses its field would leave from the page instead.
  await expect(page.getByRole("textbox", { name: "File path" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");

  const inputFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement;

      if (active?.getAttribute("data-slot") !== "input") {
        return undefined;
      }

      const style = getComputedStyle(active);
      const accent = document.createElement("span");
      accent.style.color = "var(--accent-text)";
      document.body.append(accent);
      const accentColor = getComputedStyle(accent).color;
      accent.remove();

      return { outline: style.outlineColor, accentBorder: style.borderTopColor === accentColor };
    });

  await expect
    .poll(inputFocus, { message: "the input shows an accent border, no ring" })
    .toEqual({ outline: "rgba(0, 0, 0, 0)", accentBorder: true });
});

test("should ask before a link or Back leaves an edited example, and keep the edits when declined", async ({
  page,
}) => {
  await page.goto("/examples");
  await page.locator('a[href="/examples/filters-and-joins"]').first().click();
  await expect(page).toHaveURL(/\/examples\/filters-and-joins$/);
  await waitForRun(page);
  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// my edit");
  await expect(editor).toContainText("// my edit");
  const examplesLink = page.getByRole("link", { name: "Examples /" });
  const leaveDialog = page.getByRole("dialog", { name: "Leave without saving?" });

  await examplesLink.click();
  await expect(leaveDialog).toContainText("Your edits to this copy are not saved anywhere.");
  await expect(leaveDialog.getByRole("button", { name: "Stay", exact: true })).toBeFocused();
  await leaveDialog.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(leaveDialog).toBeHidden();
  await page.evaluate(() => history.back());
  await expect(leaveDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(leaveDialog).toBeHidden();
  await expect(page).toHaveURL(/\/examples\/filters-and-joins$/);
  await expect(editor).toContainText("// my edit");

  await examplesLink.click();
  await leaveDialog.getByRole("button", { name: "Leave without saving", exact: true }).click();
  await expect(page).toHaveURL(/\/examples$/);
});

test("should keep an edited example in My projects when Fork and leave is chosen", async ({ page }) => {
  await page.goto("/examples/filters-and-joins");
  await waitForRun(page);
  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// kept by the fork");
  await expect(editor).toContainText("// kept by the fork");
  const leaveDialog = page.getByRole("dialog", { name: "Leave without saving?" });

  await page.getByRole("link", { name: "Examples /" }).click();
  await expect(leaveDialog).toContainText("Fork it to keep them in My projects.");
  await leaveDialog.getByRole("button", { name: "Fork and leave", exact: true }).click();
  await expect(page).toHaveURL(/\/examples$/);

  await page.goto("/projects");
  await page.getByRole("link", { name: "Filters, joins, and counts", exact: true }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(editor).toContainText("// kept by the fork");
});

test("should fail a run over the output budget with its cause, not a stopped process", async ({ page }) => {
  await page.goto("/projects");

  const result = await runStoredProject(page, "Output budget", {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "query.ts": 'for (let line = 0; line < 5000; line++) {\n  console.log("line", line);\n}\n',
    },
  });

  expect(result.outcome).toBe("failed");
  expect(result.error?.message).toContain("The run sent more than 4000 logs");
});

for (const { label, value } of [
  { label: "ASCII", value: '"x".repeat(3 * 1024 * 1024)' },
  { label: "non-ASCII", value: '"é".repeat(1.5 * 1024 * 1024)' },
]) {
  test(`should fail a run that returns ${label} text over 2 MiB with its cause, not a stopped process`, async ({
    page,
  }) => {
    await page.goto("/projects");

    const result = await runStoredProject(page, "Large return", {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect: "sqlite" },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: {
        "schema.ts":
          'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
        "query.ts": `export default ${value};\n`,
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.error?.message).toContain("Log or return less of it");
  });
}

test("should fail a run that leaves a promise rejection unhandled with its cause, not a broken pipe", async ({
  page,
}) => {
  await page.goto("/projects");

  const result = await runStoredProject(page, "Floating rejection", {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "query.ts": 'void Promise.reject(new Error("floating"));\n\nexport default 1;\n',
    },
  });

  expect(result.outcome).toBe("failed");
  expect(result.error?.message).toBe("floating");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNHANDLED_ERROR" }));
});

test("should fail a seed whose timer throws at once, with the timer's error and the seed phase", async ({ page }) => {
  await page.goto("/projects");

  const result = await runStoredProject(page, "Throwing timer", {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "seed.ts":
        'await new Promise((resolve) => setTimeout(() => {\n  throw new Error("timer failed");\n  resolve(undefined);\n}, 10));\n',
      "query.ts": "export default 1;\n",
    },
  });

  expect(result.outcome).toBe("failed");
  expect(result.error).toMatchObject({ message: "timer failed", phase: "seed" });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNHANDLED_ERROR" }));
  expect(result.timings.total).toBeLessThan(10_000);
});

test("should keep a run that catches a rejection a few ticks after it happened", async ({ page }) => {
  await page.goto("/projects");

  const result = await runStoredProject(page, "Late catch", {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "query.ts":
        'const late = Promise.reject(new Error("late"));\n\nawait new Promise((resolve) => setTimeout(resolve, 20));\n\nlet caught = "";\n\ntry {\n  await late;\n} catch (cause) {\n  caught = cause instanceof Error ? cause.message : "";\n}\n\nexport default caught;\n',
    },
  });

  expect(result.outcome).toBe("succeeded");
  expect(result.value).toEqual({ type: "primitive", value: "late" });
  expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "UNHANDLED_ERROR" }));
});
