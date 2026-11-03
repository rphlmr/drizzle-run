import type { Dialect } from "@drizzle-run/core/catalog";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { postSnapshot } from "./publish";

function makeProject(dialect: Dialect) {
  const core = dialect === "postgresql" ? "pg" : "sqlite";

  return {
    snapshotVersion: 1,
    name: "Query plans run",
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: {
        "schema.ts": `import { ${core}Table, integer, text } from "drizzle-orm/${core}-core";
          export const users = ${core}Table("users", { id: integer("id").primaryKey(), name: text("name").notNull() });
          export const posts = ${core}Table("posts", {
            id: integer("id").primaryKey(),
            authorId: integer("author_id").notNull().references(() => users.id),
            title: text("title").notNull(),
          });`,
        "query.ts": `import { eq } from "drizzle-orm";
          import { db } from "@drizzle-run/runtime/context";
          import { posts, users } from "./schema";
          await db.insert(users).values([{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }]);
          await db.insert(posts).values([{ id: 1, authorId: 1, title: "Notes" }, { id: 2, authorId: 2, title: "Kernels" }]);
          const rows = await db.select().from(posts).where(eq(posts.authorId, 1));
          $.display("Ada's posts", rows);`,
      },
    },
  };
}

/** Opens a published project, turns Query plans on at the given size, and runs it once. */
async function runWithPlans(page: Page, id: string, size: { option: string; chip: string }): Promise<boolean> {
  await page.goto(`/s/${id}`);

  const run = page.getByRole("button", { name: "Run", exact: true });
  const incompatible = page.getByText(/can't run in this browser/);
  await expect
    .poll(async () => ((await run.count()) > 0 && (await run.isEnabled())) || (await incompatible.isVisible()), {
      timeout: 120_000,
    })
    .toBe(true);

  if (await incompatible.isVisible()) {
    return false;
  }

  await page.getByRole("button", { name: "Output settings" }).click();
  const settings = page.getByRole("dialog", { name: "Output" });
  await settings.getByRole("switch", { name: "Query plans" }).click();
  await settings.getByRole("radio", { name: size.option }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Output settings, query plans on" })).toBeVisible();

  await run.click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
  await page.getByRole("tab", { name: /^Logs\b/ }).click();
  await expect(page.locator("[data-slot=plans-hint]")).toHaveText(size.chip, { useInnerText: true });

  return true;
}

test("should read each query of a Postgres run with Query plans, open its steps and show the index it tried", async ({
  page,
  request,
}) => {
  const response = await postSnapshot(request, { data: makeProject("postgresql") });
  expect(response.ok(), await response.text()).toBe(true);
  const { id }: { id: string } = await response.json();

  if (!(await runWithPlans(page, id, { option: "100k rows", chip: "Plans as if tables held 100k rows" }))) {
    return;
  }

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByText(/^Planning pass · tables filled to 100k posts, 10k users/)).toBeVisible({
    timeout: 60_000,
  });

  const plan = output.getByRole("button", { name: /Grows with posts/ });
  await expect(plan).toHaveCount(1);
  await plan.click();
  await expect(plan).toHaveAttribute("aria-expanded", "true");
  await expect(output.getByRole("list", { name: "Plan steps, from postgres" })).toContainText("posts");
  await expect(output.getByText("Total cost")).toBeVisible();
  await expect(output.getByRole("button", { name: "Copy EXPLAIN" })).toBeVisible();
  await expect(output.getByRole("region", { name: "Drizzle Run tried an index on posts.author_id" })).toContainText(
    "Postgres would use it.",
  );
});

test("should say the reading cannot hold for a SQLite run with Query plans at seed data", async ({ page, request }) => {
  const response = await postSnapshot(request, { data: makeProject("sqlite") });
  expect(response.ok(), await response.text()).toBe(true);
  const { id }: { id: string } = await response.json();

  if (!(await runWithPlans(page, id, { option: "Seed data", chip: "Plans at seed data" }))) {
    return;
  }

  const output = page.getByRole("region", { name: "Execution output" });
  await expect(output.getByText(/^Planning pass · tables kept at seed data/)).toBeVisible({ timeout: 60_000 });

  const plan = output.getByRole("button", { name: /Grows with posts/ });
  await plan.click();
  await expect(output.getByRole("list", { name: "Plan steps, from sqlite" })).toContainText("SCAN");
  await expect(output.getByText("Time", { exact: true })).toBeVisible();
  await expect(output.getByText(/under a millisecond/)).toBeVisible();
  await expect(output.locator("[data-slot=index-try]")).toHaveCount(0);
});

test("should put the plans notice in the rows' place on a phone, and keep planned rows' SQL to one line", async ({
  page,
  request,
}) => {
  const response = await postSnapshot(request, { data: makeProject("sqlite") });
  expect(response.ok(), await response.text()).toBe(true);
  const { id }: { id: string } = await response.json();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/s/${id}`);

  const run = page.locator("button[data-guide=run]");
  const incompatible = page.getByText(/can't run in this browser/);
  await expect
    .poll(async () => ((await run.count()) > 0 && (await run.isEnabled())) || (await incompatible.isVisible()), {
      timeout: 120_000,
    })
    .toBe(true);

  if (await incompatible.isVisible()) {
    return;
  }

  const output = page.getByRole("region", { name: "Execution output" });
  await run.click();
  await expect(output.getByRole("status")).toHaveText(/^Succeeded/, { timeout: 120_000 });
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("button", { name: /Output/ })
    .click();
  await output.getByRole("tab", { name: /^Logs\b/ }).click();
  const timeline = output.getByRole("list", { name: "Logs" }).filter({ visible: true });
  await expect(timeline).toHaveCount(1);

  await output.getByRole("button", { name: "Output settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Query plans" });
  await sheet.getByRole("switch", { name: "Query plans" }).click();
  await sheet.getByRole("radio", { name: "Seed data" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);

  const notice = output.locator("[data-slot=plans-notice]").filter({ visible: true });
  await expect(notice).toContainText("Run again to plan each query");
  await expect(timeline).toHaveCount(0);

  await run.click();
  await expect(output.locator("[data-slot=plans-hint]").filter({ visible: true })).toHaveText("Plans at seed data", {
    timeout: 120_000,
    useInnerText: true,
  });
  await expect(notice).toHaveCount(0);
  const plan = output.getByRole("button", { name: /Grows with posts/ });
  await expect(plan).toBeVisible({ timeout: 60_000 });

  await expect(output.locator("[data-slot=plans-legend]")).toBeHidden();

  const planned = output
    .locator("li[data-slot=sql-line]")
    .filter({ has: page.getByRole("button", { name: /Grows with posts/ }) })
    .locator("[data-slot=sql-text]");
  const line = await planned.evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      oneLine: element.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) + 1,
    };
  });
  expect(line).toEqual({ whiteSpace: "nowrap", textOverflow: "ellipsis", oneLine: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
