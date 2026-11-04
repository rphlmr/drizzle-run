import { expect, test } from "./fixtures";
import { readOfficialExamples } from "./official-examples";
import { callStore } from "./store";

const examples = readOfficialExamples();

for (const width of [1280, 390]) {
  test(`should scroll long query lines inside the preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/examples?q=insert+validators");
    await page.locator('[data-example-slug="insert-validators"]').click();
    const code = page.getByRole("region", { name: "Starting query code" });
    await expect(code.locator("span[class*='mtk']").first()).toBeVisible();
    await expect(code).toHaveCSS("white-space", "pre");
    await expect.poll(() => code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await code.scrollIntoViewIfNeeded();
    await code.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("should show related example and documentation links in the preview", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/examples?q=reusable+helpers");
  await page.locator('[data-example-slug="reusable-helpers"]').click();
  const resources = page.getByRole("region", { name: "Related resources" });
  await expect(resources.getByRole("link", { name: /The SQLite version/ })).toHaveAttribute(
    "href",
    "/examples/reusable-helpers-sqlite",
  );
  const docs = resources.getByRole("link", { name: /Compose SQL expressions/ });
  await expect(docs).toHaveAttribute("href", "https://orm.drizzle.team/docs/sql");
  await expect(docs).toHaveAttribute("target", "_blank");
  await resources.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("related-resources.png") });
});

for (const theme of ["light", "dark"] as const) {
  test(`should clearly distinguish selected topics in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await page.goto("/examples");
    const topics = page.getByRole("group", { name: "Topic", exact: true });
    const helpers = topics.getByRole("button", { name: "Helpers", exact: true });
    await helpers.click();
    await expect(helpers).toHaveAttribute("aria-pressed", "true");
    await expect(helpers).toHaveCSS("background-color", theme === "light" ? "rgb(10, 10, 10)" : "rgb(243, 244, 246)");
    await expect(helpers).toHaveCSS("color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(10, 10, 10)");
  });
}

test("should keep filters and results in place when selecting topics and starting from filtered results", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/examples");
  const search = page.getByRole("searchbox", { name: "Search examples and guides" });
  const list = page.getByRole("region", { name: "Browse examples" });
  const searchTop = await search.evaluate((element) => element.getBoundingClientRect().top);
  const listTop = await list.evaluate((element) => element.getBoundingClientRect().top);
  await page.getByRole("group", { name: "Topic" }).getByRole("button", { name: "Helpers", exact: true }).click();
  await expect.poll(() => search.evaluate((element) => element.getBoundingClientRect().top)).toBe(searchTop);
  await expect.poll(() => list.evaluate((element) => element.getBoundingClientRect().top)).toBe(listTop);
  await page.getByRole("button", { name: "SQLite quick start Preview ↓" }).click();
  await expect(page).toHaveURL(/\/examples$/);
  const row = page.locator('[data-example-slug="quick-start-sqlite"]');
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeInViewport();
  await expect(page.getByRole("region", { name: "Example preview" })).toContainText("SQLite quick start");
});

test("should color the selected example's query and retain it when the theme changes", async ({ page }) => {
  await page.goto("/examples");
  await page.locator('[data-example-slug="quick-start-postgresql"]').click();
  const query = page.getByRole("region", { name: "Query preview" }).locator("code");
  await expect(query).toContainText("import { db }");
  await expect(query.locator("span[class*='mtk']").first()).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(query).toContainText("import { db }");
  await expect(query.locator("span[class*='mtk']").first()).toBeVisible();
  await page.locator('[data-example-slug="quick-start-sqlite"]').click();
  await expect(query.locator("span[class*='mtk']").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "SQLite quick start" })).toBeVisible();
});

test("should combine search with topics, database, kind and comparisons on desktop and phone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/examples");
  await page.getByRole("searchbox", { name: "Search examples and guides" }).fill("typed helpers");
  await page
    .getByRole("group", { name: "Topic", exact: true })
    .getByRole("button", { name: "JSON", exact: true })
    .click();
  await page.getByLabel("Database", { exact: true }).selectOption("postgresql");
  await page.getByLabel("Kind", { exact: true }).selectOption("guided");
  await page
    .getByRole("group", { name: "Topic", exact: true })
    .getByRole("button", { name: "JSON", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Topic", exact: true })
    .getByRole("button", { name: "Comparisons", exact: true })
    .click();

  const cards = page.getByRole("list", { name: "Example list" }).getByRole("button");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Typed helpers: SQL-like vs RQB (PostgreSQL)");
  await expect(page.getByRole("region", { name: "Featured example" })).toHaveCount(0);
  await expect(page).toHaveURL(/topic=Comparisons/);
  await page.reload();
  await expect(page.getByRole("searchbox")).toHaveValue("typed helpers");
  await expect(cards).toHaveCount(1);
  await page.screenshot({ path: "/tmp/drizzle-gallery-desktop.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  const filterToggle = page.getByRole("button", { name: "Filters (3)", exact: true });
  await expect(filterToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Progress", { exact: true })).toBeHidden();
  const collapsedHeight = await page
    .getByRole("list", { name: "Example list" })
    .evaluate((element) => element.clientHeight);
  await filterToggle.click();
  await expect(
    page.getByRole("group", { name: "Topic", exact: true }).getByRole("button", { name: "Comparisons", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Progress", { exact: true })).toBeVisible();
  const expandedHeight = await page
    .locator('ul[aria-label="Example list"]')
    .evaluate((element) => element.clientHeight);
  expect(expandedHeight).toBe(collapsedHeight);
  await page.screenshot({ path: "/tmp/drizzle-gallery-filters-sheet.png" });
  await page.getByRole("button", { name: "Show 1 results", exact: true }).click();
  await expect(filterToggle).toBeFocused();
  await filterToggle.click();
  await page.keyboard.press("Escape");
  await expect(filterToggle).toBeFocused();
  await expect(cards).toHaveCount(1);
  await expect(page.getByLabel("Progress", { exact: true })).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/drizzle-gallery-phone.png" });

  await page.getByRole("searchbox").fill("missingwordthatdoesnotexist");
  await expect(page.getByText("No example matches these filters yet.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/examples$/);
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Clear filters" })).toBeDisabled();
});

test("should persist a plain example visit and refresh progress after returning to the gallery", async ({ page }) => {
  await page.goto("/examples?kind=example&progress=not_viewed&q=insert+validators");
  const card = page.getByRole("list", { name: "Example list" }).getByRole("button");
  await expect(card).toHaveCount(1);
  await card.click();
  await page.getByRole("region", { name: "Example preview" }).getByRole("link", { name: "Open example" }).click();
  await expect(page.getByText("Temporary copy, not saved")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("No example matches these filters yet.")).toBeVisible();

  await page.getByLabel("Progress", { exact: true }).selectOption("viewed");
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-slot=example-status]")).toHaveText("Viewed");
  await page.reload();
  await expect(card.locator("[data-slot=example-status]")).toHaveText("Viewed");
});

test("should preserve completed guides on a direct revisit and distinguish viewed from in progress", async ({
  page,
}) => {
  const completed = examples.find(({ slug }) => slug === "helper-apis-postgresql")!;
  const started = examples.find(({ slug }) => slug === "helper-apis-sqlite")!;
  const guide = completed.guide!;
  const startedGuide = started.guide!;
  await page.goto("/examples");
  await callStore(page, "writeSetting", `guide:${guide.id}`, {
    guideId: guide.id,
    stepId: guide.steps.at(-1)!.id,
    completed: guide.steps.map(({ id }) => id),
    finished: true,
  });
  await callStore(page, "writeSetting", `guide:${startedGuide.id}`, {
    guideId: startedGuide.id,
    stepId: startedGuide.steps[0].id,
    completed: [],
    finished: false,
  });

  await page.goto(`/examples/${completed.slug}`);
  await expect(page.getByRole("complementary", { name: "Guide" })).toBeVisible();
  await page.goto("/examples?progress=completed");
  const cards = page.getByRole("list", { name: "Example list" }).getByRole("button");
  await expect(cards).toHaveCount(1);
  await expect(cards.locator("[data-slot=guide-status]")).toHaveText("Completed");

  await page.getByLabel("Progress", { exact: true }).selectOption("viewed");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(started.title);
  await expect(cards.locator("[data-slot=guide-status]")).toHaveText("Viewed");

  await callStore(page, "writeSetting", `guide:${startedGuide.id}`, {
    guideId: startedGuide.id,
    stepId: startedGuide.steps[1].id,
    completed: [startedGuide.steps[0].id],
    finished: false,
  });
  await page.goto("/examples?progress=in_progress");
  await expect(cards).toHaveCount(1);
  await expect(cards.locator("[data-slot=guide-status]")).toHaveText("In progress");
});

test("should open examples and guides with Enter on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const slug of ["quick-start-sqlite", "drizzle-in-five-minutes"]) {
    await page.goto("/examples");
    const logo = page.getByRole("link", { name: "Drizzle Run home" });
    const leftBefore = await logo.evaluate((element) => element.getBoundingClientRect().left);
    const row = page.locator(`[data-example-slug="${slug}"]`);
    await row.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(row).toBeFocused();
    await expect(row).toHaveCSS("outline-offset", "-2px");
    await page.screenshot({ path: `/tmp/drizzle-gallery-focus-${slug}.png` });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/examples/${slug}$`));
    await expect.poll(() => logo.evaluate((element) => element.getBoundingClientRect().left)).toBe(leftBefore);
    if (slug === "drizzle-in-five-minutes") {
      await expect(page.getByRole("complementary", { name: "Guide" })).toBeVisible();
    } else {
      await expect(page.getByText("Temporary copy, not saved")).toBeVisible();
    }
  }
});

test("should navigate matching examples with arrow keys and keep selection visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/examples?topic=Helpers");
  const list = page.getByRole("list", { name: "Example list" });
  const rows = list.getByRole("button");
  const preview = page.getByRole("region", { name: "Example preview" });
  await expect(rows.first()).toBeVisible();
  await rows.first().focus();
  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(preview.getByRole("heading", { level: 2 })).toHaveText(
    await rows.nth(1).locator("span").first().innerText(),
  );
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await expect(rows.last()).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("ArrowDown");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
  await expect(rows.first()).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Tab");
  await expect(rows.first()).not.toBeFocused();
  expect(await page.getByRole("main").evaluate((element) => element.scrollTop)).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(list).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(preview).toBeVisible();
  await page.getByRole("button", { name: "Back to examples" }).click();
  await expect(rows.nth(1)).toBeFocused();
});

test("should keep the page fixed while the catalog and preview scroll independently", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/examples");
  const list = page.getByRole("list", { name: "Example list" });
  const preview = page.getByRole("region", { name: "Example preview" });
  await expect(list.getByRole("button")).toHaveCount(examples.length);
  const initialPreview = await preview.boundingBox();
  await list.evaluate((element) => {
    element.scrollTop = 600;
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(600);
  const before = await list.evaluate((element) => element.scrollTop);
  const visibleIndex = await list.getByRole("button").evaluateAll((buttons) =>
    buttons.findIndex((button) => {
      const bounds = button.getBoundingClientRect();
      const viewport = button.closest("ul")!.getBoundingClientRect();

      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }),
  );
  expect(visibleIndex).toBeGreaterThanOrEqual(0);
  const visible = list.getByRole("button").nth(visibleIndex);
  const title = await visible.locator("span").first().innerText();
  await visible.click();
  await expect(preview.getByRole("heading", { level: 2 })).toHaveText(title);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(before);
  expect(await preview.boundingBox()).toEqual(initialPreview);
  expect(await page.getByRole("main").evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await preview.locator('[data-slot="gallery-preview-content"]').evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(before);
  await expect(preview.getByRole("link", { name: /Start guide|Open example/ })).toBeVisible();
});

test("should reveal the selected row when a top preview button is clicked, including repeated selections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/examples");
  const list = page.getByRole("list", { name: "Example list" });
  const preview = page.getByRole("region", { name: "Example preview" });
  await expect(list.getByRole("button")).toHaveCount(examples.length);

  const startingPoints = page.getByRole("region", { name: "Starting points" });
  expect(await startingPoints.evaluate((element) => element.clientHeight)).toBeLessThan(150);
  const postgres = startingPoints.getByRole("button", { name: "PostgreSQL quick start Preview ↓", exact: true });
  const sqlite = startingPoints.getByRole("button", { name: "SQLite quick start Preview ↓", exact: true });
  expect((await postgres.boundingBox())?.y).toBe((await sqlite.boundingBox())?.y);
  await page.screenshot({ path: "/tmp/drizzle-gallery-compact-starters.png" });

  for (const [buttonName, title] of [
    ["Preview guide ↓", "Drizzle in five minutes"],
    ["Preview guide ↓", "Drizzle in five minutes"],
    ["PostgreSQL quick start Preview ↓", "PostgreSQL quick start"],
    ["SQLite quick start Preview ↓", "SQLite quick start"],
  ]) {
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    await expect(preview.getByRole("heading", { level: 2 })).toHaveText(title);
    await expect(list.getByRole("button", { pressed: true })).toBeInViewport({ ratio: 1 });
    expect(await page.getByRole("main").evaluate((element) => element.scrollTop)).toBe(0);
  }
});

test("should preview on phone without recording a visit and return to the same list position", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/examples?topic=Helpers");
  const list = page.getByRole("list", { name: "Example list" });
  const row = list.getByRole("button").first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole("region", { name: "Example preview" })).toBeVisible();
  await expect(list).toBeHidden();
  await page.getByRole("button", { name: "Back to examples" }).click();
  await expect(list).toBeVisible();
  await expect(page.getByRole("region", { name: "Example preview" })).toBeHidden();
  await page.getByRole("button", { name: "Filters (1)", exact: true }).click();
  await page.getByLabel("Progress", { exact: true }).selectOption("viewed");
  await page.getByRole("button", { name: "Show 0 results", exact: true }).click();
  await expect(page.getByText("No example matches these filters yet.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});
