import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { readSetting } from "./settings";

test.use({ guideSeen: false });

function getGuideRail(page: Page) {
  return page.getByRole("complementary", { name: "Guide" });
}

function getEditorLines(page: Page) {
  return page.locator(".monaco-editor .view-lines");
}

/** Opens My first project from the SQLite starter and walks the first-run guide to its last stage. */
async function finishFirstRunGuide(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();

  await expect(page).toHaveURL(/\/p\/[^?]+\?guide=first-run-sqlite/);
  await expect(getGuideRail(page).getByRole("heading", { name: "First run" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("banner")).toContainText("My first project");
  await expect(getGuideRail(page)).toContainText("The three project files");
  await expect(page.locator("[data-slot=editor-bar]")).toContainText(
    "Read-only for 3 more steps. Skip the guide to edit now.",
  );
  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(run).toBeDisabled();
  await run.locator("..").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
    "This step has nothing to run. Read it, then go to the next step.",
  );

  await getGuideRail(page).getByRole("button", { name: "Next step" }).click();
  await expect(getGuideRail(page)).toContainText("No code changes in this step");
  await expect(getGuideRail(page).getByRole("button", { name: /^Run/ })).toBeEnabled({ timeout: 120_000 });
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getGuideRail(page)).toContainText("Ada and Grace are inserted by", { timeout: 120_000 });

  await getGuideRail(page).getByRole("button", { name: "Next step" }).click();
  await expect(getGuideRail(page)).toContainText("Filter the users");
  await expect(getEditorLines(page)).toContainText('like(users.name, "A%")');
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getGuideRail(page)).toContainText("Grace is no longer returned", { timeout: 120_000 });
  await getGuideRail(page).getByRole("button", { name: "Finish guide" }).click();

  await expect(getGuideRail(page)).toContainText("Editor unlocked");
}

test("should open My first project from a starter, walked by the first-run guide", async ({ page }) => {
  await finishFirstRunGuide(page);
  await expect.poll(() => readSetting(page, "guide-seen")).toBe(true);
  await getGuideRail(page).getByRole("button", { name: "Close guide" }).click();
  await expect(getGuideRail(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/guide=/);
  await expect(getEditorLines(page)).toContainText('like(users.name, "A%")');
  await expect(page.getByText("Saved in this browser")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await expect(getGuideRail(page)).toHaveCount(0);
});

test("should leave a finished first-run guide after an edit without asking, since the project is saved", async ({
  page,
}) => {
  await finishFirstRunGuide(page);
  const editor = getEditorLines(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// my edit");
  await expect(editor).toContainText("// my edit");
  await expect(page.getByText("Saved in this browser")).toBeVisible();

  await page.getByRole("button", { name: "Switch project" }).click();
  await page
    .getByRole("dialog", { name: "Your projects" })
    .getByRole("link", { name: /^My projects/ })
    .click();

  await expect(page).toHaveURL(/\/projects$/);
});

test("should unlock the project on Skip guide and edit, and skip the guide for later starters", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^PostgreSQL/ }).click();

  await expect(getGuideRail(page)).toBeVisible({ timeout: 120_000 });
  await getGuideRail(page).getByRole("button", { name: "Skip guide and edit" }).click();
  await expect(getGuideRail(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/guide=/);
  await expect.poll(() => readSetting(page, "guide-seen")).toBe(true);
  await expect(page.getByText("Saved in this browser")).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: /^PostgreSQL/ }).click();
  await expect(page.getByRole("banner")).toContainText("My PostgreSQL project");
  await expect(page).not.toHaveURL(/guide=/);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await expect(getGuideRail(page)).toHaveCount(0);
});

test("should reopen My first project from a starter instead of creating another", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page).toHaveURL(/\/p\/[^?]+\?guide=first-run-sqlite/);
  const firstUrl = page.url();
  await expect(page.getByText("Saved in this browser")).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page).toHaveURL(/\/p\/[^?]+\?guide=first-run-sqlite/);
  expect(page.url()).toBe(firstUrl);

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: /My first project/ })).toHaveCount(1);
});

test("should keep edits made outside the first-run guide when a starter reopens My first project", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page).toHaveURL(/\/p\/[^?]+\?guide=first-run-sqlite/);
  await expect(page.getByText("Saved in this browser")).toBeVisible();
  const plainUrl = page.url().replace(/\?.*$/, "");

  await page.goto(plainUrl);
  await expect(getGuideRail(page)).toHaveCount(0);
  const editor = getEditorLines(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// my own work");
  await expect(editor).toContainText("// my own work");
  await expect(page.getByText("Saved in this browser")).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: /^SQLite/ }).click();
  await expect(page).toHaveURL(plainUrl);
  await expect(getGuideRail(page)).toHaveCount(0);
  await expect(editor).toContainText("// my own work");
  await expect.poll(() => readSetting(page, "guide-seen")).toBe(true);
});

test("should skip the first-run guide for starters once any guide is finished", async ({ page }) => {
  await page.goto("/examples/transactions");
  const rail = getGuideRail(page);

  for (const next of ["Next step", "Next step", "Finish guide"]) {
    await expect(rail.getByRole("button", { name: /^Run/ })).toBeEnabled({ timeout: 120_000 });
    await rail.getByRole("button", { name: /^Run/ }).click();
    await rail.getByRole("button", { name: next }).click({ timeout: 120_000 });
  }

  await expect.poll(() => readSetting(page, "guide-seen")).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: /^PostgreSQL/ }).click();
  await expect(page.getByRole("banner")).toContainText("My PostgreSQL project");
  await expect(page).not.toHaveURL(/guide=/);
});
