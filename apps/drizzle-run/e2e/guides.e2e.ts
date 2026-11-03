import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { replaceEditorCode } from "./editor";
import { answerLeaveWarnings, expect, test } from "./fixtures";
import { readSetting } from "./settings";

/** The id of the transactions guide's version: its progress is saved under it. */
const transactionsGuideId: string = JSON.parse(
  readFileSync(resolve("apps/drizzle-run/guides/transactions/guide.json"), "utf8"),
).id;

function getGuideRail(page: Page) {
  return page.getByRole("complementary", { name: "Guide" });
}

function getEditorLines(page: Page) {
  return page.locator(".monaco-editor .view-lines");
}

function getOutputRegion(page: Page) {
  return page.getByRole("region", { name: "Execution output" });
}

async function openGuide(page: Page, slug: string, query = "") {
  await page.goto(`/examples/${slug}${query}`);
  await expect(page.getByRole("button", { name: /^Run/ }).first()).toBeEnabled({ timeout: 120_000 });
}

async function typeAtStart(page: Page, text: string) {
  const editor = page.locator(".monaco-editor").first();
  const editorBox = await editor.boundingBox();

  // Long lines can put the editor's center under the output panel.
  await editor.click({ position: { x: 80, y: (editorBox?.height ?? 200) / 2 } });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.insertText(text);
}

for (const { slug, starter, stepCount } of [
  { slug: "joins-explained", starter: "filters-and-joins", stepCount: 7 },
  { slug: "nested-sql-results", starter: "files-with-comments-and-tags", stepCount: 7 },
  { slug: "prepared-queries", starter: "prepared-product-search", stepCount: 5 },
  { slug: "subqueries", starter: "author-report", stepCount: 6 },
]) {
  test(`should complete ${slug} and open its editable starter`, async ({ page }) => {
    await openGuide(page, slug);
    const rail = getGuideRail(page);

    for (let step = 1; step < stepCount; step += 1) {
      await expect(rail).toContainText(`Guide · step ${step} of ${stepCount}`);
      await rail.getByRole("button", { name: /^Run/ }).click();
      await expect(getOutputRegion(page).getByRole("status")).toHaveText(new RegExp(`^Step ${step} run`), {
        timeout: 120_000,
      });
      await expect(rail).toContainText("What changed");
      await rail.getByRole("button", { name: "Next step" }).click();
    }

    await expect(rail).toContainText(`Guide · step ${stepCount} of ${stepCount}`);
    await expect(rail).not.toContainText("Try it yourself");
    await expect(rail.locator(`a[href="/examples/${starter}"]`).first()).toBeVisible();
    await rail.getByRole("button", { name: "Finish guide" }).click();
    await expect(rail).toContainText("Guide · complete");
    await page.goto(`/examples/${starter}`);
    await expect(page.getByRole("button", { name: "Fork to my projects" })).toBeVisible();
    await expect(getGuideRail(page)).toHaveCount(0);
  });
}

test("should compare SQL-like and RQB results and finish without an exercise", async ({ page }) => {
  await openGuide(page, "select-vs-relational-queries");
  const rail = getGuideRail(page);
  const sqlLike = page.getByRole("region", { name: /^SQL-like, Drizzle / });
  const rqb = page.getByRole("region", { name: /^RQB, Drizzle / });

  await expect(rail).toContainText("Guide · step 1 of 5");
  await rail.getByRole("button", { name: /^Run/ }).click();
  await expect(sqlLike.getByRole("region", { name: "Joined rows", exact: true })).toContainText("Linus", {
    timeout: 120_000,
  });
  await expect(rqb.getByRole("region", { name: "Authors with posts", exact: true })).toContainText("Ada");
  await expect(sqlLike.getByRole("region", { name: "Authors with posts", exact: true })).toHaveCount(0);

  await rail.getByRole("button", { name: "Next step" }).click();
  await expect(rail).toContainText("Why does Ada appear twice?");
  await rail.getByRole("button", { name: "Next step" }).click();
  await expect(rail).toContainText("Keep Linus, even without a post");
  await rail.getByRole("button", { name: "Next step" }).click();
  await expect(rail).toContainText("Build the same nested result");
  await rail.getByRole("button", { name: /^Run/ }).click();
  for (const side of [sqlLike, rqb]) {
    await expect(
      side.getByRole("region", { name: "Authors with posts, the result this step points at", exact: true }),
    ).toContainText("Linus", { timeout: 120_000 });
  }

  await rail.getByRole("button", { name: "Next step" }).click();
  await expect(rail).toContainText("Choose the result your page needs");
  await expect(rail).not.toContainText("Try it yourself");
  await rail.getByRole("button", { name: "Finish guide" }).click();
  await expect(rail).toContainText("Guide · complete");
});

test("should apply each step's edit in a guided example, run it, and show what changed", async ({ page }) => {
  await openGuide(page, "transactions");
  await expect(getGuideRail(page)).toContainText("Guide · step 1 of 3");
  await expect(getGuideRail(page).getByRole("heading", { name: "Transactions keep all or nothing" })).toBeVisible();
  await expect(page.locator("[data-slot=editor-bar]")).toContainText(
    "Read-only while the guide runs. Pause it to experiment.",
  );
  await expect(page.getByRole("button", { name: "Fork to my projects" })).toHaveCount(0);
  await page.locator("[data-slot=release]").hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
    "The release is fixed while the guide runs. Pause the guide to change it.",
  );

  await typeAtStart(page, "// my own line\n");
  await expect(getEditorLines(page)).not.toContainText("my own line");

  await expect(page.getByRole("button", { name: /^Run step 1/ })).toBeEnabled();
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getGuideRail(page)).toContainText("What changed", { timeout: 120_000 });
  await expect(getGuideRail(page)).toContainText("Ada ended at 70, Grace at 80.");
  await expect(getOutputRegion(page)).toContainText("Step 1 run");

  await getGuideRail(page).getByRole("button", { name: "Next step" }).click();
  await expect(page).toHaveURL(/step=2/);
  await expect(getGuideRail(page)).toContainText("Keep the savepoint's update");
  await expect(getGuideRail(page).locator("[data-slot=guide-edits]")).toContainText("Changes in this step");
  await expect(getEditorLines(page)).not.toContainText("Changed our mind");
  await expect(getOutputRegion(page).locator("[data-slot=output-note]")).toContainText("Results from step 1.");

  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getOutputRegion(page).locator("[data-slot=output-note]")).toContainText(
    "Balances: 1 row changed, 1 unchanged.",
    {
      timeout: 120_000,
    },
  );
  await expect(getOutputRegion(page)).toContainText("vs step 1");
  await expect(getOutputRegion(page).locator("[data-changed]")).toHaveCount(1);
  await expect(getGuideRail(page)).toContainText("released");

  await getGuideRail(page).getByRole("button", { name: "Next step" }).click();
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getGuideRail(page)).toContainText("kept her at 70", { timeout: 120_000 });
  await getGuideRail(page).getByRole("button", { name: "Finish guide" }).click();

  await expect(getGuideRail(page)).toContainText("Guide · complete");
  await expect(getGuideRail(page)).toContainText("Editor unlocked");
  await expect(getGuideRail(page).getByRole("link", { name: /Next guide/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fork to my projects" })).toBeVisible();
  await expect(page.locator("[data-slot=editor-bar]")).toContainText("Guide complete. The editor is unlocked.");
  await expect.poll(() => readSetting(page, `guide:${transactionsGuideId}`)).toMatchObject({ finished: true });

  await typeAtStart(page, "// my own line\n");
  await expect(getEditorLines(page)).toContainText("my own line");

  // The example is a temporary copy, so leaving it with an edit warns first.
  const warnings = await answerLeaveWarnings(page, "accept", () => page.goto("/examples"));
  expect(warnings.map((warning) => warning.type())).toEqual(["beforeunload"]);
  const card = page
    .getByRole("list", { name: "Example list" })
    .getByRole("link", { name: /Transactions and savepoints/ });
  await expect(card).toContainText("Open guide →");
  await expect(card.locator("[data-slot=guide-progress]")).toContainText("Guide done");
});

test("should finish the guide with an editable query that finds Grace's seeded post", async ({ page }) => {
  await page.goto("/examples/drizzle-in-five-minutes?step=7");
  const rail = getGuideRail(page);

  await expect(rail).toContainText("Find Grace's posts yourself");
  await expect(rail.getByRole("button", { name: "Finish guide" })).toBeEnabled({ timeout: 120_000 });
  await expect(getEditorLines(page)).toContainText("eq(posts.authorId, 1)");
  await rail.getByRole("button", { name: "Finish guide" }).click();
  await expect(rail).toContainText("Editor unlocked");

  await replaceEditorCode(
    page,
    `import { desc, eq } from "drizzle-orm";
import { db } from "@drizzle-run/runtime/context";
import { posts } from "./schema";

const gracePosts = await db
  .select({ id: posts.id, title: posts.title })
  .from(posts)
  .where(eq(posts.authorId, 2))
  .orderBy(desc(posts.id));

$.display("Grace's posts", gracePosts);
`.split("\n"),
  );
  await page.getByRole("button", { name: /^Run/ }).first().click();

  const result = getOutputRegion(page).getByRole("region", { name: "Grace's posts" });
  await expect(result).toContainText("Ships", { timeout: 120_000 });
  await expect(result).not.toContainText("Hello");
  await expect(result).not.toContainText("Notes");
});

test("should unlock the editor on pausing a guide, and restore the step on Resume guide", async ({ page }) => {
  await openGuide(page, "drizzle-in-five-minutes", "?step=2");
  await expect(getGuideRail(page)).toContainText("Publish Ada's next post");

  await getGuideRail(page).getByRole("button", { name: "Pause guide and experiment" }).click();
  await expect(getGuideRail(page)).toContainText("Guide paused");
  await expect(getGuideRail(page)).toContainText("Edits are not kept");
  await expect(page.locator("[data-slot=editor-bar]")).toHaveCount(0);
  await typeAtStart(page, "// my own line\n");
  await expect(getEditorLines(page)).toContainText("my own line");

  await getGuideRail(page).getByRole("button", { name: "Resume guide" }).click();
  await expect(getGuideRail(page)).toContainText("Guide · step 2 of 7");
  await expect(getEditorLines(page)).not.toContainText("my own line");
  await expect(page.locator("[data-slot=editor-bar]")).toContainText("Read-only");
});

test("should open the step an embed links to by its step id", async ({ page }) => {
  await openGuide(page, "transactions", "?step=02-savepoint");

  await expect(getGuideRail(page)).toContainText("Guide · step 2 of 3");
  await expect(getGuideRail(page)).toContainText("Keep the savepoint's update");
});

test("should go back to a finished step by clicking it in the guide rail", async ({ page }) => {
  await openGuide(page, "drizzle-in-five-minutes", "?step=2");
  const firstStep = getGuideRail(page).getByRole("button", { name: /^Go back to step 1:/ });

  await expect(getGuideRail(page)).toContainText("Guide · step 2 of 7");
  await expect(getGuideRail(page).getByRole("navigation", { name: "Read more in the Drizzle docs" })).toBeVisible();
  await firstStep.click();

  await expect(page).toHaveURL(/step=1/);
  await expect(getGuideRail(page)).toContainText("Guide · step 1 of 7");
  await expect(getGuideRail(page).getByRole("button", { name: /^Go back to step/ })).toHaveCount(0);
});

test("should cancel a running step when the learner goes back to a finished step", async ({ page }) => {
  await openGuide(page, "drizzle-in-five-minutes", "?step=3");
  const rail = getGuideRail(page);

  await rail.getByRole("button", { name: /^Run/ }).click();
  await expect(rail.getByRole("button", { name: "Cancel" })).toBeVisible();
  await rail.getByRole("button", { name: /^Go back to step 2:/ }).click();

  await expect(page).toHaveURL(/step=2/);
  await expect(rail).toContainText("Guide · step 2 of 7");
  await expect(rail.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: /^Run/ })).toBeEnabled({ timeout: 120_000 });
  await rail.getByRole("button", { name: /^Run/ }).click();
  await expect(getOutputRegion(page).getByRole("region", { name: "Published post" })).toContainText(
    "Learning Drizzle",
    { timeout: 120_000 },
  );
  await expect(getOutputRegion(page).getByRole("region", { name: "Users with posts" })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Next step" })).toBeEnabled();
});

test("should cancel both sides of a running relations step when the learner goes back to the select", async ({
  page,
}) => {
  await openGuide(page, "drizzle-in-five-minutes", "?step=4");
  const rail = getGuideRail(page);
  const rqb = page.getByRole("region", { name: /^RQB, Drizzle / });

  await rail.getByRole("button", { name: /^Run/ }).click();
  await expect(rail.getByRole("button", { name: "Cancel" })).toBeVisible();
  await rail.getByRole("button", { name: /^Go back to step 3:/ }).click();

  await expect(page).toHaveURL(/step=3/);
  await expect(rqb).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(1);
  await expect(rail.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: /^Run/ })).toBeEnabled({ timeout: 120_000 });
  await rail.getByRole("button", { name: /^Run/ }).click();
  await expect(getOutputRegion(page).getByRole("region", { name: "Ada's posts" })).toContainText("Notes", {
    timeout: 120_000,
  });
  await expect(rail.getByRole("button", { name: "Next step" })).toBeEnabled();
});

test("should open two sides on the relations step, run both, then keep the SQL-like side", async ({ page }) => {
  await openGuide(page, "drizzle-in-five-minutes", "?step=4");
  const sqlLike = page.getByRole("region", { name: /^SQL-like, Drizzle / });
  const rqb = page.getByRole("region", { name: /^RQB, Drizzle / });

  await expect(getGuideRail(page)).toContainText("Guide · step 4 of 7");
  await expect(sqlLike.locator(".monaco-editor .view-lines")).toContainText("the left join keeps him");
  await expect(rqb.locator(".monaco-editor .view-lines")).toContainText("db.query.users.findMany");
  await expect(page.getByRole("button", { name: "Fork to my projects" })).toHaveCount(0);

  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(sqlLike.getByRole("region", { name: "Users with posts" })).toContainText("Linus", { timeout: 120_000 });
  await expect(rqb.getByRole("region", { name: "Users with posts" })).toContainText("Linus", { timeout: 120_000 });
  await expect(sqlLike.getByRole("region", { name: "Users with posts" })).toHaveAttribute("data-highlighted", "true");
  await expect(
    sqlLike.getByRole("region", { name: "Users with posts, the result this step points at", exact: true }),
  ).toBeVisible();
  await expect(rqb.getByRole("region", { name: "Users with posts" })).toHaveAttribute("data-highlighted", "true");

  await getGuideRail(page).getByRole("button", { name: "Next step" }).click();
  await expect(page).toHaveURL(/step=5/);
  await expect(sqlLike).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(1);
  const files = page.getByRole("tablist", { name: "Project files" });
  await expect(getEditorLines(page)).toContainText(".returning()");
  await expect(getGuideRail(page)).toContainText("Without .where(), an update or delete affects every row");
  await expect(getGuideRail(page).getByRole("link", { name: "ESLint safeguards" })).toHaveAttribute(
    "href",
    "https://orm.drizzle.team/docs/eslint-plugin",
  );
  await files.getByRole("tab", { name: "schema.ts" }).click();
  await expect(getEditorLines(page)).toContainText("defineRelations");
  // The step highlights once the editor is ready, after Run enables, so wait one more render.
  await expect(getGuideRail(page).getByRole("button", { name: /^Run/ })).toBeEnabled({ timeout: 120_000 });
  await page.evaluate(() => new Promise((settle) => requestAnimationFrame(() => setTimeout(settle))));
  await expect(files.getByRole("tab", { name: "schema.ts" })).toHaveAttribute("aria-selected", "true");
  await expect(getEditorLines(page)).toContainText("defineRelations");
  await files.getByRole("tab", { name: "query.ts" }).click();
  await expect(page.locator(".monaco-editor .guide-highlight").first()).toBeVisible();

  await expect(getGuideRail(page).getByRole("button", { name: /^Run/ })).toBeEnabled({ timeout: 120_000 });
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getOutputRegion(page).getByRole("region", { name: "Renamed" })).toContainText("Hello, Drizzle", {
    timeout: 120_000,
  });
  await expect(getOutputRegion(page).getByRole("region", { name: "Renamed" })).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await getGuideRail(page).getByRole("button", { name: "Next step" }).click();
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();
  await expect(getOutputRegion(page).getByRole("region", { name: "After rollback" })).toContainText("Ships", {
    timeout: 120_000,
  });
  await expect(getOutputRegion(page).getByRole("region", { name: "After rollback" })).not.toContainText(
    "Hello, Drizzle",
  );
  await expect(getOutputRegion(page).getByRole("region", { name: "After commit" })).toContainText("Hello, Drizzle");
  await expect(getOutputRegion(page).getByRole("region", { name: "After commit" })).not.toContainText("Ships");

  await getGuideRail(page)
    .getByRole("button", { name: /^Go back to step 4:/ })
    .click();
  await expect(page).toHaveURL(/step=4/);
  await expect(rqb.locator(".monaco-editor .view-lines")).toContainText("db.query.users.findMany");
});

test("should keep both side names whole in the relations step's pane heads on a laptop screen", async ({ page }) => {
  for (const width of [1536, 1440, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await openGuide(page, "drizzle-in-five-minutes", "?step=4");

    for (const name of ["SQL-like", "RQB"]) {
      const sideName = page
        .getByRole("region", { name: new RegExp(`^${name}, Drizzle `) })
        .getByText(name, { exact: true });

      // scrollWidth rounds, so both widths are measured to the subpixel: a name a fraction of a pixel short still
      // draws an ellipsis.
      await expect
        .poll(
          () =>
            sideName.evaluate((element) => {
              const text = document.createRange();
              text.selectNodeContents(element);

              return text.getBoundingClientRect().width <= element.getBoundingClientRect().width + 0.01;
            }),
          { message: `${name} at ${width} px` },
        )
        .toBe(true);
    }
  }
});

test("should keep every output tab whole beside a guide step's run pill on a laptop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGuide(page, "drizzle-in-five-minutes", "?step=3");
  await getGuideRail(page).getByRole("button", { name: /^Run/ }).click();

  const output = getOutputRegion(page);
  const tabs = output.getByRole("tablist", { name: "Output views" });

  await expect(output.locator("[data-slot=run-pill]")).toHaveAttribute("data-short", "Step 3 run", {
    timeout: 120_000,
  });
  await expect(output.locator("[data-slot=run-pill] [data-duration]")).toBeHidden();
  await expect
    .poll(() =>
      tabs.evaluate((element) => {
        const lastTab = element.lastElementChild;

        return lastTab !== null && lastTab.getBoundingClientRect().right <= element.getBoundingClientRect().right;
      }),
    )
    .toBe(true);
});

test("should show one side at a time on a phone during the relations step", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openGuide(page, "drizzle-in-five-minutes", "?step=4");

  const sheet = page.getByRole("region", { name: "Guide" });
  const sides = page.getByRole("tablist", { name: "Side" });
  const sqlLike = page.getByRole("region", { name: /^SQL-like, Drizzle / });
  const rqb = page.getByRole("region", { name: /^RQB, Drizzle / });

  await expect(sheet).toContainText("Step 4 of 7");
  await expect(sqlLike).toBeVisible();
  await expect(rqb).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await sheet.getByRole("button", { name: /^Run/ }).click();
  await expect(sheet).toContainText("Step 4 of 7 done", { timeout: 120_000 });
  await sides.getByRole("tab", { name: /^RQB/ }).click();
  await expect(rqb).toBeVisible();
  await expect(sqlLike).toBeHidden();
});

test("should tell guided examples and examples apart in the gallery", async ({ page }) => {
  await page.goto("/examples");
  const featured = page.getByRole("region", { name: "Featured example" }).getByRole("link");

  await expect(featured).toContainText("Start here");
  await expect(featured).toContainText("Guided · 7 steps");
  await expect(featured).toContainText("Start guide →");
  await expect(page.getByRole("region", { name: "Featured example" }).getByRole("heading")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Kind" }).getByRole("button")).toHaveText([
    "Any kind",
    "Guided",
    "Examples",
  ]);

  const cards = page.getByRole("list", { name: "Example list" }).getByRole("link");
  const pair = cards.first().getByText(/^orm \S+/);
  // A web font swapping in moves the list out from under the pointer.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await pair.hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(/^ORM .+ with Kit .+$/);

  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Guided" }).click();
  await expect(page).toHaveURL(/kind=guided/);
  await expect(cards).toHaveCount(9);

  for (const card of await cards.all()) {
    await expect(card).toContainText(/Guided · \d steps/);
    await expect(card).toContainText("Start guide →");
  }

  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Examples" }).click();
  await expect(page).toHaveURL(/kind=example/);
  await expect(cards.first()).toBeVisible();

  for (const card of await cards.all()) {
    await expect(card).toContainText("Example");
    await expect(card).not.toContainText("Guided ·");
    await expect(card).toContainText("Open example →");
  }
});

test("should show the guide as a bottom sheet over the code on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openGuide(page, "drizzle-in-five-minutes", "?step=2");

  const sheet = page.getByRole("region", { name: "Guide" });
  await expect(sheet).toContainText("Step 2 of 7");
  await expect(sheet.getByRole("heading", { name: "Publish Ada's next post" })).toBeVisible();
  await expect(page.getByText("Guide · step 2 of 7")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await sheet.getByRole("button", { name: "Collapse guide" }).click();
  await expect(sheet.getByRole("heading", { name: "Publish Ada's next post" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Expand guide" }).click();

  await sheet.getByRole("button", { name: /^Run/ }).click();
  await expect(sheet).toContainText("Step 2 of 7 done", { timeout: 120_000 });
  await expect(sheet.getByRole("button", { name: "Next step" })).toBeEnabled();
});

test("should make the rail clamp(340px, 28vw, 440px) wide, and wrap step code instead of cutting it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openGuide(page, "transactions", "?step=3");

  const width = async () => (await getGuideRail(page).boundingBox())?.width ?? 0;
  // 28vw at 1280 px.
  expect(await width()).toBeCloseTo(358.4, 0);

  const editorBox = await page.getByRole("region", { name: "Editor" }).boundingBox();
  const outputBox = await getOutputRegion(page).boundingBox();
  expect(editorBox?.width ?? 0).toBeGreaterThan(300);
  expect(outputBox?.width ?? 0).toBeGreaterThan(300);
  expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeLessThanOrEqual(outputBox?.x ?? 0);
  await expect(getOutputRegion(page).getByRole("tab", { name: /Problems/ })).toBeInViewport({ ratio: 1 });

  const lines = getGuideRail(page).locator("[data-slot=guide-edits] li");
  const long = lines.filter({ hasText: '.where(eq(accounts.owner, "Ada")).returning();' });
  await expect(long).toHaveCount(1);
  const cut = await lines.evaluateAll((items) =>
    items
      .filter((item) => {
        const spans = [item, ...item.querySelectorAll("span:not(.sr-only)")];

        return spans.some(
          (span) => span.scrollWidth > span.clientWidth || getComputedStyle(span).textOverflow === "ellipsis",
        );
      })
      .map((item) => item.textContent),
  );
  expect(cut).toEqual([]);
  expect((await long.boundingBox())?.height ?? 0).toBeGreaterThan(40);

  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(width).toBe(340);
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect.poll(width).toBe(440);

  await getGuideRail(page).getByRole("button", { name: "Collapse guide" }).click();
  await expect.poll(width).toBeLessThan(80);
  await getGuideRail(page).getByRole("button", { name: "Expand guide" }).click();
  await expect.poll(width).toBe(440);
});

test("should resize the guide rail and the AI chat dock from their drawn width, keeping 640 px for the code", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await openGuide(page, "transactions");

  const guide = getGuideRail(page);
  const guideHandle = page.getByRole("separator", { name: "Resize guide" });
  const workArea = page.locator("[data-slot=resizable-panel-group]");
  const getWidthPx = async (locator: ReturnType<typeof page.locator>) =>
    Math.round((await locator.boundingBox())?.width ?? 0);

  await expect.poll(() => getWidthPx(guide)).toBe(440);
  await guideHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => getWidthPx(guide)).toBe(440);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => getWidthPx(guide)).toBe(472);
  await page.keyboard.press("End");
  await expect.poll(() => getWidthPx(guide)).toBe(948); // (1920 - 2 × 12 padding) / 2
  await page.keyboard.press("Home");
  await expect.poll(() => getWidthPx(guide)).toBe(440);

  await page.getByRole("button", { name: /Ask AI/ }).click();
  const dock = page.getByRole("region", { name: "AI chat" });
  const dockHandle = page.getByRole("separator", { name: "Resize AI chat" });

  await expect.poll(() => getWidthPx(dock)).toBe(360);
  await dockHandle.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => getWidthPx(dock)).toBe(360);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => getWidthPx(dock)).toBe(392);

  const handleBox = await dockHandle.boundingBox();
  const handleX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
  const handleY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;

  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX - 100, handleY, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => getWidthPx(dock)).toBe(492);

  await guideHandle.focus();
  await page.keyboard.press("End");
  await dockHandle.focus();
  await page.keyboard.press("End");
  await expect.poll(() => getWidthPx(workArea)).toBe(640);
  await page.keyboard.press("Home");
  await expect.poll(() => getWidthPx(dock)).toBe(360);
});

test("should stack the editor over the output while the guide and the AI chat are both open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGuide(page, "drizzle-in-five-minutes");

  const editor = page.getByRole("region", { name: "Editor" });
  const output = getOutputRegion(page);
  const isStacked = async () => {
    const editorBox = await editor.boundingBox();
    const outputBox = await output.boundingBox();

    return (editorBox?.y ?? 0) + (editorBox?.height ?? 0) <= (outputBox?.y ?? 0);
  };

  await expect.poll(isStacked).toBe(false);

  await page.getByRole("button", { name: /Ask AI/ }).click();
  await expect(page.getByRole("region", { name: "AI chat" })).toBeVisible();
  await expect.poll(isStacked).toBe(true);

  await expect(page.getByRole("separator", { name: "Resize guide" })).toBeHidden();
  await expect(page.getByRole("separator", { name: "Resize AI chat" })).toBeHidden();

  const helperColumns = () =>
    output
      .locator("[data-slot=first-run] dl")
      .evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(" ").length);
  await expect.poll(helperColumns).toBe(2);

  await page.getByRole("region", { name: "AI chat" }).getByRole("button", { name: "Close chat" }).click();
  await expect.poll(isStacked).toBe(false);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.getByRole("button", { name: /Ask AI/ }).click();
  await expect.poll(isStacked).toBe(true);
  await page.getByRole("region", { name: "AI chat" }).getByRole("button", { name: "Close chat" }).click();
  await expect.poll(isStacked).toBe(false);
});
