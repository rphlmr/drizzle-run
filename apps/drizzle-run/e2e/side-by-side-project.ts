import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures";
import { countLiveWorkers, installLifecycleInstrumentation, type LifecycleWindow } from "./lifecycle-instrumentation";

/** The page's Run both button: the header's or the embed's, never a guide step's. */
export function getRunBothButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Run both/ }).and(page.locator(':not([aria-label="Guide steps"] *)'));
}

/** Creates a PostgreSQL side-by-side project from New project, on Legacy and the newest release. */
export async function createSideBySide(page: Page, name: string, files: RegExp): Promise<void> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });

  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("radio", { name: /^Side by side/ }).click();

  const create = dialog.getByRole("button", { name: "Create side by side" });
  await expect(dialog.getByRole("radio", { name: /^Separate files/ })).toBeChecked();
  await expect(create).toBeEnabled();

  await dialog.getByRole("radio", { name: files }).click();
  await create.click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
}

/** Opens a project from the Switch project dialog, without reloading the page. */
export async function switchToProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("dialog").getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText(name);
}

/** Creates a one-version SQLite project from the Switch project dialog, without reloading the page. */
export async function createOneVersionProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "SQLite" }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText(name);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
}

/**
 * Check that both sides terminate their execution workers after every run and project exit.
 *
 * Repeats `visits` times to detect workers accumulating across projects. Worker creation counts ensure that an
 * empty instrumentation result cannot pass the disposal assertions.
 */
export async function verifySecondSideDisposal(page: Page, { visits }: { visits: number }): Promise<void> {
  await installLifecycleInstrumentation(page);
  await createSideBySide(page, "Disposal pair", /^Separate files/);
  await createOneVersionProject(page, "Disposal single");
  await expect
    .poll(() => countLiveWorkers(page, "drizzle-run-execution"), {
      message: "An idle project must have no execution workers",
    })
    .toBe(0);

  for (let visit = 1; visit <= visits; visit++) {
    await switchToProject(page, "Disposal pair");
    await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
    const workersBeforeRun = await page.evaluate(
      () => (window as LifecycleWindow).__drizzleRunLifecycleWorkers?.length ?? 0,
    );
    await getRunBothButton(page).click();
    await expect(page.locator("[data-slot=run-pill]")).toHaveText([/^Succeeded/, /^Succeeded/], { timeout: 120_000 });
    expect(await page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleWorkers?.length)).toBe(
      workersBeforeRun + 2,
    );
    await expect
      .poll(() => countLiveWorkers(page, "drizzle-run-execution"), {
        message: `Visit ${visit} must terminate both completed execution workers`,
      })
      .toBe(0);

    await switchToProject(page, "Disposal single");
    await expect
      .poll(() => countLiveWorkers(page, "drizzle-run-execution"), {
        message: `Visit ${visit} must leave no execution workers after project exit`,
      })
      .toBe(0);
  }

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
  await expect.poll(() => countLiveWorkers(page, "drizzle-run-execution")).toBe(0);
}
