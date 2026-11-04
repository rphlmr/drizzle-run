import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectRecord, storeProjects } from "./data";
import { expect, test } from "./fixtures";
import { getRunBothButton } from "./side-by-side-project";

const examplesDirectory = resolve("apps/drizzle-run/examples");
const examples = readdirSync(examplesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const metadata: {
      title: string;
      dialect?: string;
      releasePair: string;
      sides?: { name: string; dialect?: string }[];
    } = JSON.parse(readFileSync(resolve(examplesDirectory, entry.name, "example.json"), "utf8"));

    return {
      slug: entry.name,
      title: metadata.title,
      dialects: new Set((metadata.sides ?? [{ dialect: undefined }]).map((side) => side.dialect ?? metadata.dialect)),
      ormVersion: /^orm-(.+)__kit-/.exec(metadata.releasePair)?.[1],
      sideNames: metadata.sides?.map((side) => side.name),
      guided: existsSync(resolve("apps/drizzle-run/guides", entry.name, "guide.json")),
    };
  });

test("zero projects: the welcome page creates a starter in one click", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Write a schema. Seed it. Run a query.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Drizzle in five minutes" })).toHaveAttribute(
    "href",
    "/examples/drizzle-in-five-minutes",
  );
  const strip = page.getByRole("list", { name: "More official examples" });
  const stripTitles = (await strip.getByRole("link").allInnerTexts()).map((text) => text.replace(/^Official\s*/, ""));
  expect(stripTitles.toSorted()).toEqual(
    examples
      .filter((example) => example.slug !== "drizzle-in-five-minutes" && !example.slug.startsWith("quick-start-"))
      .map((example) => example.title)
      .toSorted(),
  );
  await expect(page.getByRole("link", { name: "All examples →" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText([
    "Examples & Guides",
    "My projects",
    "Community",
  ]);
  await expect(page.getByRole("contentinfo")).toContainText("Made by @rphlmr. Follow on X for updates.");
  await expect(page.getByRole("contentinfo")).toContainText("Runs real Drizzle ORM and Kit in your browser.");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "@rphlmr" })).toHaveAttribute(
    "href",
    "https://x.com/rphlmr",
  );
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/rphlmr/drizzle-run",
  );
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Report an issue" })).toHaveAttribute(
    "href",
    "https://github.com/rphlmr/drizzle-run/issues/new/choose",
  );

  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("My SQLite project");
  await expect(page.getByRole("contentinfo")).toContainText("SQLite");
});

test("the home stays the welcome page with saved projects, and lists none of them", async ({ page }) => {
  await storeProjects(
    page,
    Array.from({ length: 3 }, (_, index) => projectRecord(index)),
  );

  await expect(
    page.getByRole("heading", {
      name: "Write a schema. Seed it. Run a query.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^Stored/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /import/i })).toHaveCount(0);

  await expect(page.getByRole("link", { name: "My projects →" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My projects" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Stored 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /import/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Drizzle Run home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("what we use: the footer opens the credits, each linking to its official site, then the source", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("button", { name: "What we use" }).click();

  const dialog = page.getByRole("dialog", { name: "What we use" });
  await expect(dialog.getByRole("link")).toHaveText([
    /^pglite\.dev/,
    /^sqlite\.org\/wasm/,
    /^quickjs-wasi/,
    /^stately\.ai/,
    "Drizzle ORM and Drizzle Kit",
    /^Source on GitHub/,
  ]);
  const hrefs = await dialog.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs).toEqual([
    "https://pglite.dev",
    "https://sqlite.org/wasm/",
    "https://www.npmjs.com/package/quickjs-wasi",
    "https://stately.ai/docs/xstate",
    "https://orm.drizzle.team",
    "https://github.com/rphlmr/drizzle-run",
  ]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("reduced motion holds the drizzle rain still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const names = await page
    .locator(".animate-drizzle")
    .evaluateAll((drops) => drops.map((drop) => getComputedStyle(drop).animationName));
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names)).toEqual(new Set(["none"]));
  await expect(page.locator(".animate-marquee")).toHaveCSS("animation-name", "none");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      page
        .locator(".animate-drizzle")
        .first()
        .evaluate((drop) => getComputedStyle(drop).animationName),
    )
    .toBe("drizzle");
});

test("my projects: 45 projects with search, filter, and pages", async ({ page }) => {
  await storeProjects(
    page,
    Array.from({ length: 45 }, (_, index) => projectRecord(index)),
    "/projects",
  );

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My projects 45");

  const footer = page.getByText(/^Showing \d+ to \d+ of \d+$/);
  await expect(footer).toHaveText("Showing 1 to 20 of 45");
  await expect(page.getByRole("link", { name: "Stored 1", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Open Stored / })).toHaveCount(20);

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(footer).toHaveText("Showing 41 to 45 of 45");
  await expect(page).toHaveURL(/page=3/);

  await page.getByRole("group", { name: "Database" }).getByRole("button", { name: "SQLite" }).click();
  await expect(footer).toHaveText("Showing 1 to 15 of 15");

  await page.getByRole("searchbox", { name: "Search projects" }).fill("stored 4");
  await expect(page.getByRole("link", { name: /^Stored 4/ })).toHaveCount(3);

  await page.getByRole("button", { name: "Name" }).click();
  await expect(page).toHaveURL(/sort=name-desc/);

  await page.getByRole("checkbox", { name: "Select Stored 40" }).click();
  await page.getByRole("group", { name: "Selected projects" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByRole("heading", { name: "My projects 44" })).toBeVisible();

  await page.getByRole("link", { name: "Open Stored 43", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/00000000-0000-4000-8000-000000000042$/);
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Stored 43");
});

test("new project: imports an exported project file from the modal", async ({ page }) => {
  const exported = { ...projectRecord(7), name: "Imported transfers" };
  await page.goto("/projects");

  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog).toContainText("Or import a project file");

  await dialog.getByLabel("Choose file").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{ not json"),
  });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Choose file").setInputFiles({
    name: "transfers.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Imported transfers");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/p\//);

  await page.getByRole("button", { name: "Switch project" }).click();
  const switcher = page.getByRole("dialog", { name: "Your projects" });
  await expect(switcher.getByRole("button", { name: "Import project JSON" })).toHaveCount(0);
  await switcher.getByRole("link", { name: /^My projects/ }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("link", { name: "Imported transfers", exact: true })).toBeVisible();
});

test("new project: imports an Export all backup, all of its projects at once", async ({ page }) => {
  const backup = [
    { ...projectRecord(8), name: "Backup one" },
    { ...projectRecord(9), name: "Backup two" },
  ];
  await page.goto("/projects");

  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Choose file").setInputFiles({
    name: "drizzle-run-projects.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("link", { name: "Backup one", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Backup two", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Imported 2 projects." })).toBeVisible();
});

test("phone: my projects fits 375 px with a project list", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await storeProjects(
    page,
    Array.from({ length: 5 }, (_, index) => projectRecord(index)),
    "/projects",
  );

  await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Examples & Guides" }).click();
  await expect(page.getByRole("heading", { name: "Examples & guides", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Write a schema. Seed it. Run a query.",
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("gallery filters by topic and database", async ({ page }) => {
  await page.goto("/examples");

  await expect(page.getByText("Start here")).toBeVisible();
  await page.getByRole("group", { name: "Database" }).getByRole("button", { name: "SQLite" }).click();
  await expect(page).toHaveURL(/db=sqlite/);

  const cards = page.getByRole("list", { name: "Example list" }).getByRole("link");
  await expect(cards).toHaveCount(examples.filter((example) => example.dialects.has("sqlite")).length);

  for (const card of await cards.all()) {
    await expect(card).toContainText("SQLite");
  }
});

for (const scrollTop of [0, 140]) {
  test(`gallery filters retain control and column positions at scroll ${scrollTop}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/examples");
    await expect(page.getByText("Start here")).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const main = page.getByRole("main");
    const database = page.getByRole("group", { name: "Database" });
    const readPositions = () =>
      page.locator("main h1, main fieldset, main fieldset button").evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width } = element.getBoundingClientRect();

          return { x, y, width };
        }),
      );

    await main.evaluate((element, top) => {
      element.scrollTop = top;
    }, scrollTop);
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    const initialPositions = await readPositions();
    await database.getByRole("button", { name: "SQLite", exact: true }).click();
    await expect(page).toHaveURL(/db=sqlite/);
    await expect(page.getByRole("list", { name: "Example list" }).getByRole("link")).toHaveCount(
      examples.filter((example) => example.dialects.has("sqlite")).length,
    );
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    await expect.poll(readPositions).toEqual(initialPositions);

    await database.getByRole("button", { name: "Any database", exact: true }).click();
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(scrollTop);
    await expect.poll(readPositions).toEqual(initialPositions);
  });
}

for (const example of examples.filter((item) => !item.guided && item.sideNames === undefined)) {
  test(`official example ${example.slug} opens, runs, and saves`, async ({ page }) => {
    await page.goto(`/examples/${example.slug}`);

    await expect(page.getByText("Temporary copy, not saved")).toBeVisible();
    await expect(page.getByRole("tab", { name: "query.ts" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText(/^Succeeded/)).toBeVisible({
      timeout: 120_000,
    });

    await page.getByRole("button", { name: "Fork to my projects" }).click();
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText(example.title);
    await expect(page).toHaveURL(/\/p\//);
  });
}

for (const example of examples.filter((item) => !item.guided && item.sideNames !== undefined)) {
  test(`official side-by-side example ${example.slug} opens, runs both sides, and saves`, async ({ page }) => {
    const sideNames = example.sideNames ?? [];

    await page.goto("/examples");
    const card = page.getByRole("list", { name: "Example list" }).getByRole("link", { name: example.title });
    await expect(card).toContainText(sideNames.join(" vs "));
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/examples/${example.slug}$`));

    await expect(page.getByText("Temporary copy, not saved")).toBeVisible();
    const runBoth = getRunBothButton(page);
    await expect(runBoth).toBeEnabled({ timeout: 120_000 });
    const sides = sideNames.map((name) => page.getByRole("region", { name: `${name}, Drizzle ` }));
    expect(sides).toHaveLength(2);

    await runBoth.click();

    for (const side of sides) {
      await expect(side.locator("[data-slot=run-pill]")).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    }

    await page.getByRole("button", { name: "Fork to my projects" }).click();
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText(example.title);
    await expect(page).toHaveURL(/\/p\//);
  });
}

test("site pages crossfade into each other, but not on a filter change or into an example", async ({ page }) => {
  await page.addInitScript(() => {
    const transitions = { count: 0 };
    Object.assign(window, { siteTransitions: transitions });
    const start = document.startViewTransition?.bind(document);

    if (start) {
      document.startViewTransition = (...args: Parameters<typeof start>) => {
        transitions.count += 1;
        return start(...args);
      };
    }
  });
  const countTransitions = () =>
    page.evaluate(() => (window as unknown as { siteTransitions: { count: number } }).siteTransitions.count);

  await storeProjects(page, [projectRecord(0)], "/projects");
  test.skip(!(await page.evaluate(() => "startViewTransition" in document)), "No View Transitions in this browser");
  const nav = page.getByRole("navigation", { name: "Main" });

  await nav.getByRole("link", { name: "Community" }).click();
  await expect(page.getByRole("searchbox", { name: "Search community shares" })).toBeVisible();
  await expect.poll(countTransitions).toBe(1);

  await page.getByRole("group", { name: "Topic" }).getByRole("button", { name: "Bug repros" }).click();
  await expect(page).toHaveURL(/topic=bug-repros/);
  await nav.getByRole("link", { name: "Examples & Guides" }).click();
  await expect.poll(countTransitions).toBe(2);

  await page.locator('a[href="/examples/filters-and-joins"]').first().click();
  await expect(page).toHaveURL(/\/examples\/filters-and-joins$/);
  await page.waitForTimeout(500);
  expect(await countTransitions()).toBe(2);
});
