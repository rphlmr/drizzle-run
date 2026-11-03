import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { callStore } from "./store";

/** The version id an official example or guide folder declares. */
function readVersionId(file: string): string {
  return JSON.parse(readFileSync(resolve(`apps/drizzle-run/${file}`), "utf8")).id;
}

/** Fork the open official page, and return the id of the project it opened. */
async function forkProject(page: Page): Promise<string | undefined> {
  const fork = page.getByRole("button", { name: "Fork to my projects" }).filter({ visible: true }).first();
  await expect(fork).toBeEnabled({ timeout: 60_000 });
  await fork.click();
  await expect(page).toHaveURL(/\/p\//);

  return new URL(page.url()).pathname.split("/").at(-1);
}

/** The source of a stored project, once the store has it. */
async function readStoredSource(page: Page, projectId: string | undefined) {
  const projects = await callStore(page, "loadProjects");

  return projects.find((project) => project.id === projectId)?.source;
}

test("should store the example version a forked official example came from", async ({ page }) => {
  await page.goto("/examples/filters-and-joins");

  const projectId = await forkProject(page);

  await expect
    .poll(() => readStoredSource(page, projectId))
    .toEqual({ kind: "example", id: readVersionId("examples/filters-and-joins/example.json") });
});
