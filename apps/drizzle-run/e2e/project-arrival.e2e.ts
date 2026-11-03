import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { readSetting } from "./settings";

const introTitle = "Your project lives in this browser";

/** Creates an empty SQLite project from the projects page; the intro, when it shows, covers the header. */
async function createProject(page: Page, name: string): Promise<void> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "SQLite" }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New project" })).toHaveCount(0);
  // Leaving while the first save is still on its way would rightly warn. The intro hides the footer from roles.
  await expect(page.getByText("Saved in this browser")).toBeVisible();
}

/** Forks an official example from the header's project actions. */
async function forkExample(page: Page, slug: string): Promise<void> {
  await page.goto(`/examples/${slug}`);
  await page
    .getByRole("group", { name: "Project actions" })
    .getByRole("button", { name: "Fork to my projects" })
    .click();
  await expect(page).toHaveURL(/\/p\//);
}

test("should keep the docs of a forked official example, and open the example again from them", async ({ page }) => {
  await forkExample(page, "filters-and-joins");

  const toast = page.getByRole("status").filter({ hasText: "Forked to My projects." });
  await expect(toast.getByRole("link", { name: "Open the original" })).toHaveAttribute(
    "href",
    "/examples/filters-and-joins",
  );
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toHaveCount(0);

  await page
    .getByRole("group", { name: "Project actions" })
    .getByRole("button", { name: "Docs from the example" })
    .click();
  const docs = page.getByRole("dialog", { name: "Docs" });
  const links = docs.getByRole("region", { name: "Example" }).getByRole("link");
  await expect(links).toHaveText([/Filters/, /Joins/]);
  await expect(links.nth(0)).toHaveAttribute("href", "https://orm.drizzle.team/docs/sqlite/operators");
  await expect(links.nth(1)).toHaveAttribute("href", "https://orm.drizzle.team/docs/sqlite/joins");
  await expect(docs).toContainText("From the version you forked, so they match your code.");

  await docs.getByRole("link", { name: "Open the example again" }).click();
  await expect(page).toHaveURL(/\/examples\/filters-and-joins$/);
  await expect(page.getByText("Temporary copy, not saved")).toBeVisible();
});

test("should open the docs as a bottom sheet on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await forkExample(page, "filters-and-joins");

  await page.getByRole("button", { name: "Docs from the example" }).click();
  const sheet = page.getByRole("dialog", { name: "Docs" });
  await expect(sheet.getByRole("region", { name: "Example" }).getByRole("link")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test.describe("the intro", () => {
  test.use({ projectIntro: "unseen" });

  test("should open a new project on the intro until it is muted", async ({ page }) => {
    await createProject(page, "First");
    const intro = page.getByRole("dialog", { name: introTitle });
    await expect(intro).toContainText("To send it to someone, press Share. That link works for everyone.");
    await intro.getByRole("button", { name: "Got it" }).click();
    await expect(intro).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText("First");
    await expect.poll(() => readSetting(page, "project-intro")).toBe("seen");

    await createProject(page, "Second");
    await intro.getByRole("checkbox", { name: "Don't show this again" }).click();
    await intro.getByRole("button", { name: "Got it" }).click();
    await expect.poll(() => readSetting(page, "project-intro")).toBe("muted");

    await createProject(page, "Third");
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Third");
    await expect(intro).toHaveCount(0);
  });

  test("should open the first Fork ever on the intro instead of its toast", async ({ page }) => {
    await forkExample(page, "filters-and-joins");

    const intro = page.getByRole("dialog", { name: introTitle });
    await expect(intro).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Forked to My projects." })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(intro).toHaveCount(0);
    await expect.poll(() => readSetting(page, "project-intro")).toBe("seen");
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

    await expect(page.getByText("Saved in this browser", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible();
    await expect(intro).toHaveCount(0);
  });
});

test("should explain a /p/ link copied from another browser, with ways to go on", async ({ page }) => {
  await page.goto("/p/00000000-0000-4000-9000-999999999999");

  await expect(
    page.getByRole("heading", { level: 1, name: "This link only works in the browser that made it" }),
  ).toBeVisible();
  await expect(page.getByText("Ask them for a Share link. It works for everyone.")).toBeVisible();
  await page.getByText("Browse examples").click();
  await expect(page).toHaveURL(/\/examples/);
});
