import { deployedSearchIndexing } from "../../../playwright.deployed.config";
import { expect, test } from "./fixtures";

test("should hide previews, next and workers.dev hosts from search engines", async ({ page, baseURL }) => {
  const hidden = deployedSearchIndexing === "off" || new URL(baseURL ?? "").hostname.endsWith(".workers.dev");
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);

  if (hidden) {
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
  } else {
    expect(response?.headers()["x-robots-tag"] ?? "").not.toContain("noindex");
  }
});

test("should create a project, prepare the runtime from R2 and run it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("Deployed release");
  await page.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "SQLite" }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();

  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toBeEnabled({ timeout: 180_000 });
  await run.click();

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  await expect(output.getByRole("region", { name: "Users" })).toBeVisible();
});
