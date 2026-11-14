import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { readOfficialExamples } from "./official-examples";
import { callStore } from "./store";

const examples = readOfficialExamples();

function getCard(page: Page, slug: string) {
  return page.locator(`article[data-example-slug="${slug}"]`);
}

for (const width of [1280, 390]) {
  test(`should scroll long query lines inside the quick look at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/examples?q=insert+validators");
    await page.getByRole("button", { name: "Quick look: Insert validators" }).click();
    const code = page.getByRole("dialog").getByRole("region", { name: "Starting query code" });
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

test("should show related example and documentation links in the quick look", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/examples?q=reusable+helpers");
  await page.getByRole("button", { name: "Quick look: Write reusable, typed SQL helpers" }).click();
  const resources = page.getByRole("dialog").getByRole("region", { name: "Related resources" });
  await expect(resources.getByRole("link", { name: /The SQLite version/ })).toHaveAttribute(
    "href",
    "/examples/reusable-helpers-sqlite",
  );
  const docs = resources.getByRole("link", { name: /Compose SQL expressions/ });
  await expect(docs).toHaveAttribute("href", "https://orm.drizzle.team/docs/sql");
  await expect(docs).toHaveAttribute("target", "_blank");
});

test("should group examples by section and list a whole section on its own page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/examples");
  const nav = page.getByRole("navigation", { name: "Gallery sections" });
  await expect(nav.getByRole("link", { name: /^Overview/ })).toHaveAttribute("aria-current", "page");

  const querying = page.getByRole("region", { name: "Querying" });
  await expect(querying.locator("article")).toHaveCount(3);
  await querying.getByRole("link", { name: /^See all \d+ ›$/ }).click();
  await expect(page).toHaveURL(/\?section=querying$/);
  await expect(nav.getByRole("link", { name: /^Querying/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("list", { name: "Querying" }).locator("article")).toHaveCount(6);

  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
  await expect(page).toHaveURL(/\/examples$/);
  await expect(page.getByRole("region", { name: "Collections" })).toBeVisible();
});

test("should open the reader's database and remember it", async ({ page }) => {
  await page.goto("/examples");
  const database = page.getByRole("group", { name: "Database" });
  const start = page.getByRole("region", { name: "Start here" });
  await expect(database.getByRole("button", { name: "PostgreSQL" })).toHaveAttribute("aria-pressed", "true");
  await expect(start.getByRole("link", { name: "Quick start", exact: true })).toHaveAttribute(
    "href",
    "/examples/quick-start-postgresql",
  );
  await expect(getCard(page, "filters-and-joins")).toContainText("SQLite only");

  await database.getByRole("button", { name: "SQLite" }).click();
  await expect(start.getByRole("link", { name: "Quick start", exact: true })).toHaveAttribute(
    "href",
    "/examples/quick-start-sqlite",
  );
  await expect(getCard(page, "filters-and-joins")).not.toContainText("only");

  await page.reload();
  await expect(database.getByRole("button", { name: "SQLite" })).toHaveAttribute("aria-pressed", "true");
});

test("should search titles, guide steps and code, and say when nothing matches", async ({ page }) => {
  await page.goto("/examples");
  const search = page.getByRole("searchbox", { name: "Search examples and guides" });
  await expect(page.getByRole("region", { name: "Collections" })).toBeVisible();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();

  await search.fill("both changes or neither");
  await expect(page).toHaveURL(/q=both/);
  const step = page.getByRole("region", { name: "Guide steps" });
  await expect(step).toContainText("Step 6 · Keep both changes or neither");
  await expect(step.getByRole("link", { name: "Drizzle in five minutes" })).toHaveAttribute(
    "href",
    "/examples/drizzle-in-five-minutes?step=6",
  );

  await search.fill("leftJoin(");
  const code = page.getByRole("region", { name: "Used in code" });
  await expect(code.locator("article").first()).toContainText("leftJoin(");

  await search.fill("onConflictDoNothing");
  await expect(page.getByText("Nothing for “onConflictDoNothing” yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Request an example ↗" })).toBeVisible();

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(/\/examples$/);
});

test("should open a card directly and return to the same gallery position", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/examples");
  const main = page.getByRole("main");
  const card = getCard(page, "nested-sql-results").first();
  await card.scrollIntoViewIfNeeded();
  await main.evaluate((element) => {
    element.scrollTop += 120;
  });
  const scrollTop = await main.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  await card.getByRole("link", { name: "Build nested results with SQL" }).click();
  await expect(page).toHaveURL(/\/examples\/nested-sql-results$/);
  await expect(page.getByRole("complementary", { name: "Guide" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/examples$/);
  await expect.poll(() => page.getByRole("main").evaluate((element) => element.scrollTop)).toBe(scrollTop);
});

test("should open the quick look with Space and close it with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/examples");
  const link = getCard(page, "drizzle-in-five-minutes").getByRole("link", { name: "Drizzle in five minutes" });
  await link.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog", { name: "Drizzle in five minutes" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Start guide/ })).toHaveAttribute(
    "href",
    "/examples/drizzle-in-five-minutes",
  );
  await expect(page).toHaveURL(/\/examples$/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("should switch the version of a two-database example in the quick look", async ({ page }) => {
  await page.goto("/examples");
  await page.getByRole("button", { name: "Quick look: Quick start" }).click();
  const dialog = page.getByRole("dialog", { name: "Quick start" });
  await expect(dialog.getByRole("link", { name: /Open example/ })).toHaveAttribute(
    "href",
    "/examples/quick-start-postgresql",
  );
  await dialog.getByRole("group", { name: "Version" }).getByRole("button", { name: "SQLite" }).click();
  await expect(dialog.getByRole("link", { name: /Open example/ })).toHaveAttribute(
    "href",
    "/examples/quick-start-sqlite",
  );
});

test("should show the quick look as a bottom sheet and the sections as chips on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/examples");
  const nav = page.getByRole("navigation", { name: "Gallery sections" });
  await expect(nav).toHaveCSS("flex-direction", "row");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Quick look: Quick start" }).click();
  const dialog = page.getByRole("dialog", { name: "Quick start" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width).toBe(390);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
});

test("should list a collection in order and count what the reader finished", async ({ page }) => {
  await page.goto("/examples");
  await page.getByRole("link", { name: "Safe writes" }).click();
  await expect(page).toHaveURL(/\?collection=safe-writes$/);
  const list = page.getByRole("list", { name: "Safe writes" });
  await expect(list.locator("article h3")).toHaveText([
    "Transactions and savepoints",
    "Enforce product rules with CHECK",
    "Insert validators",
  ]);
});

test("should pick up opened examples and guides in progress, and mark finished guides done", async ({ page }) => {
  const completed = examples.find(({ slug }) => slug === "helper-apis-postgresql")!;
  const started = examples.find(({ slug }) => slug === "drizzle-in-five-minutes")!;
  const guide = completed.guide!;
  const startedGuide = started.guide!;
  await page.goto("/examples");
  await expect(page.getByRole("region", { name: "Pick up where you left off" })).toHaveCount(0);
  await callStore(page, "writeSetting", `guide:${guide.id}`, {
    guideId: guide.id,
    stepId: guide.steps.at(-1)!.id,
    completed: guide.steps.map(({ id }) => id),
    finished: true,
  });
  await callStore(page, "writeSetting", `guide:${startedGuide.id}`, {
    guideId: startedGuide.id,
    stepId: startedGuide.steps[2].id,
    completed: [startedGuide.steps[0].id, startedGuide.steps[1].id],
    finished: false,
  });

  await page.goto("/examples/insert-validators");
  await expect(page.getByText("Temporary copy, not saved")).toBeVisible();
  await page.goBack();

  const pickUp = page.getByRole("region", { name: "Pick up where you left off" });
  await expect(pickUp.locator("article[data-example-slug]")).toHaveCount(2);
  await expect(getCard(page, "insert-validators").first().locator("[data-slot=example-status]")).toHaveText("Viewed");
  await expect(pickUp.locator('[data-example-slug="drizzle-in-five-minutes"] [data-slot=example-status]')).toHaveText(
    `2/${startedGuide.steps.length} steps`,
  );
  await pickUp.getByRole("button", { name: "Quick look: Drizzle in five minutes" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: /Continue at step 3/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/examples?section=relational-queries");
  await expect(getCard(page, completed.slug).locator("[data-slot=example-status]")).toHaveText("Done");
  await expect(page.getByRole("region", { name: "Pick up where you left off" })).toHaveCount(0);
});
