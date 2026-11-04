import { expect, test } from "./fixtures";
import { readOfficialExamples } from "./official-examples";
import { callStore } from "./store";

const examples = readOfficialExamples();

test("should combine search with topics, database, kind and layout on desktop and phone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/examples");
  await page.getByRole("searchbox", { name: "Search examples and guides" }).fill("typed helpers");
  await page
    .getByRole("group", { name: "Topic", exact: true })
    .getByRole("button", { name: "JSON", exact: true })
    .click();
  await page.getByRole("group", { name: "Database" }).getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Guided", exact: true }).click();
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Side by side", exact: true }).click();

  const cards = page.getByRole("list", { name: "Example list" }).getByRole("link");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("href", "/examples/helper-apis-postgresql");
  await expect(page.getByRole("region", { name: "Featured example" })).toHaveCount(0);
  await expect(page).toHaveURL(/layout=side_by_side/);
  await page.reload();
  await expect(page.getByRole("searchbox")).toHaveValue("typed helpers");
  await expect(cards).toHaveCount(1);
  await page.screenshot({ path: "/tmp/drizzle-gallery-desktop.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("group", { name: "Layout" })).toBeVisible();
  await expect(page.getByLabel("Progress", { exact: true })).toBeVisible();
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
  const card = page.getByRole("list", { name: "Example list" }).getByRole("link");
  await expect(card).toHaveCount(1);
  await card.click();
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
  const cards = page.getByRole("list", { name: "Example list" }).getByRole("link");
  await expect(cards).toHaveCount(1);
  await expect(cards.locator("[data-slot=guide-status]")).toHaveText("Completed");

  await page.getByLabel("Progress", { exact: true }).selectOption("viewed");
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute("href", `/examples/${started.slug}`);
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
