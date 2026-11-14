import type { APIRequestContext, Locator, Page } from "@playwright/test";

import type { PlaygroundPreview } from "../src/embed-loader/index";
import { turnOnDebug } from "./debug";
import { appOrigin, blogOrigin, expect, test, SELECT_TO_DOCUMENT_END } from "./fixtures";
import { signInWithGitHub } from "./github";
import { postSnapshot } from "./publish";
import { createSideBySide, getRunBothButton, verifySecondSideDisposal } from "./side-by-side-project";

// Several runtimes at once in WebKit left a side stuck preparing past its 2 minute wait, so this file's tests run
// one after another on one worker.
test.describe.configure({ mode: "default" });

function getLegacySide(page: Page): Locator {
  return page.getByRole("region", { name: "Drizzle orm 0.45.4 · kit 0.31.11" });
}

function getRcSide(page: Page): Locator {
  return page.getByRole("region", { name: "Drizzle orm 1.0.0-rc.5 · kit 1.0.0-rc.5" });
}

/** A box's rendered width, rounded to whole pixels. */
async function getWidthPx(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.width ?? 0);
}

/** The center of a box, where a pointer grabs it. */
async function getCenter(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();

  return { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
}

/** A side's name in its pane head, which renames the side. */
function getSideNameButton(page: Page, label: string): Locator {
  return page.getByRole("button", { name: `${label}. Rename this side`, exact: true });
}

/** The SQLite starter schema, typed over a schema written for PostgreSQL. Unindented: Monaco indents after a brace. */
const SQLITE_SCHEMA_LINES = [
  'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";',
  'export const users = sqliteTable("users", {',
  'id: integer("id").primaryKey(),',
  'name: text("name").notNull(),',
  "});",
];

/** Replaces a side's open file with these lines. */
async function replaceSideCode(page: Page, side: Locator, lines: readonly string[]): Promise<void> {
  await side.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");

  // One line at a time: Firefox inserts a multi-line text into Monaco twice.
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      await page.keyboard.press("Enter");
    }

    await page.keyboard.insertText(line);
  }

  // Monaco may auto-close a bracket a line opened, depending on timing; what it adds stays after the cursor.
  await page.keyboard.press(SELECT_TO_DOCUMENT_END);
  await page.keyboard.press("Delete");
}

/** The plain rc.5 row of a release picker, not its Effect row. */
const PLAIN_RC_ROW = /^RC, orm 1\.0\.0-rc\.5 · kit 1\.0\.0-rc\.5(?!, with Effect)/;

/** A side's run status, in the embed's pane head. */
function getSidePill(side: Locator): Locator {
  return side.locator("[data-side-pill]");
}

/** A side's run status, in its output bar, as a one-version project's output shows it. */
function getOutputPill(side: Locator): Locator {
  return side.locator("[data-slot=run-pill]");
}

test("should create a side-by-side project and run both sides, each with its own output", async ({ page }) => {
  await createSideBySide(page, "Orders playground", /^Separate files/);

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitemradio", { name: "12 px", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitemradio", { name: "14 px", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "16 px", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Orders playground");
  const sideBySideTag = page.getByRole("banner").getByText("Side by side", { exact: true });
  await sideBySideTag.hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText("Every run runs both sides");
  await expect(getOutputPill(getLegacySide(page))).toHaveText("Not run yet");
  await expect(getOutputPill(getRcSide(page))).toHaveText("Not run yet");

  await getRunBothButton(page).click();

  for (const side of [getLegacySide(page), getRcSide(page)]) {
    await expect(getOutputPill(side)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    await expect(side.getByRole("region", { name: "Users" })).toContainText("Ada");
  }

  await getLegacySide(page).locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// only on 0.45\n");
  await expect(getLegacySide(page).locator(".monaco-editor .view-lines")).toContainText("only on 0.45");
  await expect(getRcSide(page).locator(".monaco-editor .view-lines")).not.toContainText("only on 0.45");
  await expect(page.getByRole("button", { name: "File actions" })).toHaveCount(0);
});

test("should run PostgreSQL on one side and SQLite on the other, each with its own schema", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });

  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Two databases");
  await dialog.getByRole("radio", { name: /^Side by side/ }).click();
  await dialog
    .getByRole("radiogroup", { name: "Database of the second side" })
    .getByRole("radio", { name: "SQLite" })
    .click();
  await dialog.getByRole("radio", { name: /^Shared files/ }).click();
  await dialog.getByRole("button", { name: "Create side by side" }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });

  await expect(page.getByRole("contentinfo").first()).toContainText("PostgreSQL vs SQLite");
  await expect(page.getByRole("tab", { name: /^schema\.ts/ })).toHaveAccessibleName(/Differs per side/);
  await expect(page.getByRole("tab", { name: /^query\.ts/ })).not.toHaveAccessibleName(/Differs per side/);
  const [postgres, sqlite] = [
    page.getByRole("region", { name: /^rc\.5 \(Postgres\), Drizzle orm 1\.0\.0-rc\.5/ }),
    page.getByRole("region", { name: /^rc\.5 \(SQLite\), Drizzle orm 1\.0\.0-rc\.5/ }),
  ];
  await expect(postgres.locator(".monaco-editor .view-lines")).toBeVisible();

  await getRunBothButton(page).click();

  for (const side of [postgres, sqlite]) {
    await expect(getOutputPill(side)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    await expect(side.getByRole("region", { name: "Users" })).toContainText("Ada");
  }
});

test("should give each side its Results and Logs, with Debug, run history and the seed switch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSideBySide(page, "Parity playground", /^Separate files/);
  const legacy = getLegacySide(page);
  const rc = getRcSide(page);

  await expect(legacy.getByRole("tablist", { name: "0.45 output" }).getByRole("tab")).toHaveText([
    "Results",
    "Story",
    "Logs",
    "Problems",
  ]);

  await turnOnDebug(page);
  await getRunBothButton(page).click();

  for (const side of [legacy, rc]) {
    await expect(getOutputPill(side)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    await side.getByRole("tab", { name: "Logs" }).click();
    await expect(side.getByRole("tabpanel", { name: "Logs" })).toContainText(/select/i);
    await side.getByRole("tab", { name: "Debug" }).click();
    await expect(side.getByRole("tabpanel", { name: "Debug" })).toBeVisible();
    await expect(side.locator(".run-note-zone")).toHaveCount(0);
  }

  await getRunBothButton(page).click();
  for (const side of [legacy, rc]) {
    await side.getByRole("button", { name: "Run history" }).click();
    await expect(page.getByRole("dialog", { name: "Runs in this tab" })).toContainText("2 runs", { timeout: 120_000 });
    await page.keyboard.press("Escape");
  }

  await legacy.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// only on 0.45\n");
  await expect(legacy.getByText("Edited since this run.")).toBeVisible();
  await expect(rc.getByText("Edited since this run.")).toHaveCount(0);

  const seedTab = page.getByRole("tab", { name: /^seed\.ts/ });
  const seedSwitch = page.getByRole("switch", { name: "Seed on each run" });

  await expect(seedSwitch).toHaveCount(0);
  await seedTab.click();
  await expect(seedSwitch).toHaveCount(1);
  await seedSwitch.click();
  await expect(seedSwitch).not.toBeChecked();
  await expect(seedTab).toContainText("Off");
  await expect(page.getByText("Off: runs skip this file and start with empty tables.")).toBeVisible();
  await expect(page.getByRole("button", { name: "File actions" })).toHaveCount(0);
  await seedSwitch.click();
  await expect(seedSwitch).toBeChecked();
  await expect(seedTab).not.toContainText("Off");
});

test("should share files only on one release line, and show an edit to a shared file on both sides", async ({
  page,
}) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Shared playground");
  await dialog.getByRole("radio", { name: /^Side by side/ }).click();

  const shared = dialog.getByRole("radio", { name: /^Shared files/ });
  await expect(shared).toBeDisabled();
  await expect(dialog.getByText("Not for Legacy next to RC: each side writes its own code.")).toBeVisible();

  await dialog.getByRole("button", { name: /^First side:/ }).click();
  await page.getByRole("group", { name: "First side" }).getByRole("radio", { name: PLAIN_RC_ROW }).click();
  await page.keyboard.press("Escape");
  await shared.click();
  await dialog.getByRole("button", { name: "Create side by side" }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });

  const firstSide = page.getByRole("region", { name: /^rc\.5 \(1\), Drizzle / });
  const secondSide = page.getByRole("region", { name: /^rc\.5 \(2\), Drizzle / });
  await expect(firstSide.getByText("Shared file")).toBeVisible();
  await secondSide.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// on both sides\n");
  await expect(firstSide.locator(".monaco-editor .view-lines")).toContainText("on both sides");
});

test("should keep every file tab of the guided editor bar in view at 1280 px, and the title on one line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/examples/relational-queries");
  await expect(getRunBothButton(page)).toBeVisible();

  const header = page.locator("header").first();
  const tabs = page.getByRole("tablist", { name: "Project files" });
  await expect(tabs.getByRole("tab")).toHaveText(["query.ts", "schema.ts", "seed.ts"]);
  await expect(header.getByRole("tablist", { name: "Project files" })).toHaveCount(0);
  expect(await tabs.evaluate((list) => list.scrollWidth > list.clientWidth)).toBe(false);
  const title = header.getByText("Migrate relational queries to v1", { exact: true });
  const fit = {
    headerScroll: await header.evaluate((element) => element.scrollWidth > element.clientWidth),
    titleOneLine: await title.evaluate((element) => getComputedStyle(element).whiteSpace === "nowrap"),
  };
  expect(fit).toEqual({ headerScroll: false, titleOneLine: true });
});

test("should center the guide handle in its gap, and reset the guide and both sides on a double click", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/examples/relational-queries");
  await expect(getRunBothButton(page)).toBeVisible();

  const guide = page.getByRole("complementary", { name: "Guide" });
  const guideHandle = page.getByRole("separator", { name: "Resize guide" });
  const sidesHandle = page.getByRole("separator", { name: "Resize the two sides" });
  const drag = async (locator: Locator, byPx: number) => {
    const { x, y } = await getCenter(locator);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + byPx, y, { steps: 5 });
    await page.mouse.up();
  };

  const guideBox = await guide.boundingBox();
  const editorBarBox = await page.locator("[data-slot=files-bar]").boundingBox();
  const handleBox = await guideHandle.boundingBox();
  const gapCenter = ((guideBox?.x ?? 0) + (guideBox?.width ?? 0) + (editorBarBox?.x ?? 0)) / 2;

  expect(Math.abs((handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2 - gapCenter)).toBeLessThan(4);

  const drawnGuidePx = await getWidthPx(guide);

  await drag(guideHandle, 80);
  await expect.poll(() => getWidthPx(guide)).toBe(drawnGuidePx + 80);
  await guideHandle.dblclick();
  await expect.poll(() => getWidthPx(guide)).toBe(drawnGuidePx);

  const legacySide = getLegacySide(page);
  const halfPx = await getWidthPx(legacySide);

  await drag(sidesHandle, -120);
  await expect.poll(() => getWidthPx(legacySide)).toBeLessThan(halfPx - 100);
  await sidesHandle.dblclick();
  await expect.poll(() => getWidthPx(legacySide)).toBe(halfPx);
});

test("should dispose the second side's runtime once a side-by-side project closes", async ({ page }) => {
  await verifySecondSideDisposal(page, { visits: 1 });
});

test("should fork a one-version project as side by side and keep the original", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^PostgreSQL/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  const original = page.url();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Fork as side by side…" }).click();
  const dialog = page.getByRole("dialog", { name: "Fork as side by side" });

  await expect(dialog.getByRole("radio", { name: /^Legacy, orm 0\.45\./ })).toBeChecked();
  await expect(dialog.locator("label", { hasText: "Same as this project" }).getByRole("radio")).toBeEnabled();
  await dialog.getByRole("radio", { name: /^Separate files/ }).click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    "My PostgreSQL project, rc.5 vs 0.45",
  );
  await dialog.getByRole("button", { name: "Fork as side by side" }).click();

  await expect(page).not.toHaveURL(original);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(getRcSide(page)).toBeVisible();
  await expect(getLegacySide(page)).toBeVisible();

  await page.getByRole("button", { name: "Switch project" }).click();
  const switcher = page.getByRole("dialog", { name: "Your projects" });
  await expect(switcher).toContainText("My PostgreSQL project, rc.5 vs 0.45");
  await expect(switcher).toContainText(/My PostgreSQL project(?!,)/);
});

test("should fork a PostgreSQL project into PostgreSQL vs SQLite, mark the schema to rewrite, and run both", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^PostgreSQL/ }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Fork as side by side…" }).click();
  const dialog = page.getByRole("dialog", { name: "Fork as side by side" });

  await dialog
    .getByRole("radiogroup", { name: "Database of the new side" })
    .getByRole("radio", { name: "SQLite" })
    .click();
  await expect(dialog).toContainText("schema.ts is still written for PostgreSQL");
  await expect(dialog.getByRole("radio", { name: /^RC, orm 1\.0\.0-rc\.5/ }).first()).toBeChecked();
  await dialog.getByRole("radio", { name: /^Shared files/ }).click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    "My PostgreSQL project, rc.5 (Postgres) vs rc.5 (SQLite)",
  );
  await dialog.getByRole("button", { name: "Fork as side by side" }).click();
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole("contentinfo").first()).toContainText("PostgreSQL vs SQLite");

  const sqlite = page.getByRole("region", { name: /^rc\.5 \(SQLite\), Drizzle/ });
  const postgres = page.getByRole("region", { name: /^rc\.5 \(Postgres\), Drizzle/ });
  const schemaTab = page.getByRole("tab", { name: /^schema\.ts/ });
  await schemaTab.click();
  await expect(schemaTab.locator("[data-slot=tab-error]")).toBeVisible({ timeout: 60_000 });
  await expect(schemaTab).toContainText("TypeScript errors on rc.5 (SQLite)");

  await replaceSideCode(page, sqlite, SQLITE_SCHEMA_LINES);
  await expect(schemaTab.locator("[data-slot=tab-error]")).toHaveCount(0, { timeout: 60_000 });

  await getRunBothButton(page).click();

  for (const side of [postgres, sqlite]) {
    await expect(getOutputPill(side)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    await expect(side.getByRole("region", { name: "Users" })).toContainText("Ada");
  }
});

test("should move one side of a pair to the other database, rewrite its schema, and run both", async ({ page }) => {
  await createSideBySide(page, "Move a side to SQLite", /^Separate files/);

  await getRcSide(page)
    .getByRole("button", { name: /^RC, orm 1\.0\.0-rc\.5 · kit 1\.0\.0-rc\.5, PostgreSQL\./ })
    .click();
  const popover = page.getByRole("dialog", { name: "Change this side’s version" });
  await popover
    .getByRole("radiogroup", { name: "Database of this side" })
    .getByRole("radio", { name: "SQLite" })
    .click();
  await expect(popover.getByRole("radio", { name: /^Keep this side’s files/ })).toBeChecked();
  await expect(popover).toContainText("schema.ts stays written for PostgreSQL");
  await popover.getByRole("button", { name: /^Move this side to SQLite rc\.5/ }).click();

  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole("contentinfo").first()).toContainText("PostgreSQL vs SQLite");
  const sqlite = page.getByRole("region", { name: /^rc\.5, Drizzle orm 1\.0\.0-rc\.5/ });
  await expect(
    sqlite.getByRole("button", { name: /^RC, orm 1\.0\.0-rc\.5 · kit 1\.0\.0-rc\.5, SQLite\./ }),
  ).toBeVisible();

  const schemaTab = page.getByRole("tab", { name: /^schema\.ts/ });
  await schemaTab.click();
  await expect(schemaTab.locator("[data-slot=tab-error]")).toBeVisible({ timeout: 60_000 });
  await replaceSideCode(page, sqlite, SQLITE_SCHEMA_LINES);
  await expect(schemaTab.locator("[data-slot=tab-error]")).toHaveCount(0, { timeout: 60_000 });

  await getRunBothButton(page).click();

  for (const side of [getLegacySide(page), sqlite]) {
    await expect(getOutputPill(side)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
    await expect(side.getByRole("region", { name: "Users" })).toContainText("Ada");
  }
});

test("should change a side's version from a bottom sheet on a phone", async ({ page }) => {
  await createSideBySide(page, "Change a side on a phone", /^Separate files/);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tablist", { name: "Side" })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Change rc.5’s version…" }).click();
  const sheet = page.getByRole("dialog", { name: "Change this side’s version" });
  await expect(sheet.getByRole("radiogroup", { name: "Database of this side" })).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Change rc.5’s version…" }).click();
  await sheet.getByRole("radiogroup", { name: "Database of this side" }).getByRole("radio", { name: "SQLite" }).click();
  await sheet.getByRole("button", { name: /^Move this side to SQLite rc\.5/ }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu")).toContainText("PostgreSQL vs SQLite");
});

test("should run one release on both sides, label them (1) and (2), and keep the names set from the pane head", async ({
  page,
}) => {
  await signInWithGitHub(page.request);
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Select vs relational queries");
  await dialog.getByRole("radio", { name: /^Side by side/ }).click();

  await dialog.getByRole("button", { name: /^First side:/ }).click();
  const first = page.getByRole("group", { name: "First side" });
  await expect(first.locator("label", { hasText: "Other side" })).toContainText("RC");
  await first.getByRole("radio", { name: PLAIN_RC_ROW }).click();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("textbox", { name: "Name of the first side" })).toHaveAttribute(
    "placeholder",
    "Name, optional",
  );
  await dialog.getByRole("radio", { name: /^Separate files/ }).click();
  await dialog.getByRole("button", { name: "Create side by side" }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });

  await expect(getSideNameButton(page, "rc.5 (1)")).toBeVisible();
  await expect(getSideNameButton(page, "rc.5 (2)")).toBeVisible();
  await expect(page.getByRole("region", { name: /^rc\.5 \(2\), Drizzle orm 1\.0\.0-rc\.5/ })).toBeVisible();
  await expect(page.getByText("rc.5 on both sides").first()).toBeVisible();

  await getSideNameButton(page, "rc.5 (2)").click();
  const nameField = page.getByRole("textbox", { name: "Name of this side" });
  await nameField.fill("Ignored");
  await nameField.press("Escape");
  await expect(getSideNameButton(page, "rc.5 (2)")).toBeVisible();
  await getSideNameButton(page, "rc.5 (2)").click();
  await nameField.fill("  RQB ");
  await nameField.press("Enter");
  await expect(getSideNameButton(page, "RQB")).toBeVisible();

  await page.getByRole("button", { name: "Name this side", exact: true }).click();
  await nameField.fill("Classic");
  await nameField.press("Enter");
  const classic = page.getByRole("region", { name: /^Classic, Drizzle orm 1\.0\.0-rc\.5/ });
  const rqb = page.getByRole("region", { name: /^RQB, Drizzle orm 1\.0\.0-rc\.5/ });
  await expect(classic).toBeVisible();

  await getRunBothButton(page).click();
  await expect(getOutputPill(classic)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
  await expect(getOutputPill(rqb)).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
  await expect(classic.getByRole("tablist", { name: "Classic output" })).toBeVisible();

  await page.reload();
  await expect(getSideNameButton(page, "Classic")).toBeVisible({ timeout: 120_000 });
  await expect(getSideNameButton(page, "RQB")).toBeVisible();

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog");
  await share.getByRole("radio", { name: "Link only" }).click();
  await share.getByRole("checkbox", { name: /secrets/ }).click();
  await share.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(share.getByText("Your link is ready.")).toBeVisible({ timeout: 60_000 });
  const url = await share.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  await share.getByRole("button", { name: /Embed in a page/ }).click();
  await share.getByText("Show code", { exact: true }).click();
  await expect(share.locator("pre")).toContainText('"name": "Classic"');
  await expect(share.locator("pre")).toContainText('"name": "RQB"');
  await page.keyboard.press("Escape");

  await page.goto(new URL(url).pathname);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole("region", { name: /^Classic, Drizzle/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /^RQB, Drizzle/ })).toBeVisible();
});

test("should open both sides of a share link, idle", async ({ page }) => {
  await signInWithGitHub(page.request);
  await createSideBySide(page, "Shared link", /^Separate files/);

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Share / })).toBeVisible();
  await dialog.getByRole("radio", { name: "Link only" }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(dialog.getByText("Your link is ready.")).toBeVisible({ timeout: 60_000 });
  const url = await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  await dialog.getByRole("button", { name: /Embed in a page/ }).click();
  await dialog.getByText("Show code", { exact: true }).click();
  await expect(dialog.locator("pre")).toContainText('"drizzleOrm": "0.45.4"');
  await expect(dialog.locator("pre")).toContainText('"drizzleOrm": "1.0.0-rc.5"');
  await page.keyboard.press("Escape");

  await page.goto(new URL(url).pathname);
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(getOutputPill(getLegacySide(page))).toHaveText("Not run yet");
  await expect(getOutputPill(getRcSide(page))).toHaveText("Not run yet");
  await expect(getLegacySide(page).locator(".monaco-editor .view-lines")).toContainText("db.select()");

  await getRunBothButton(page).click();
  await expect(getOutputPill(getLegacySide(page))).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
  await expect(getOutputPill(getRcSide(page))).toHaveText(/^Succeeded · \d/, { timeout: 120_000 });
});

test("should open a side-by-side share listed in Community as a side-by-side copy", async ({ page }) => {
  const name = `Listed side by side ${crypto.randomUUID().slice(0, 8)}`;
  await signInWithGitHub(page.request);
  await createSideBySide(page, name, /^Separate files/);

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Description/ }).fill("Both releases, listed by the e2e spec.");
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Publish to Community", exact: true }).click();
  await expect(dialog.getByText("Published to Community.")).toBeVisible({ timeout: 60_000 });
  const id = new URL(await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue()).pathname
    .split("/")
    .at(-1);
  await page.keyboard.press("Escape");
  // Signed out, as a visitor: the owner of a share skips its Community notice.
  await page.context().clearCookies();

  await page.goto("/community?db=sqlite");
  await page.getByRole("searchbox", { name: "Search community shares" }).fill(name);
  await expect(page.getByText("No share matches these filters.")).toBeVisible();
  await page.getByRole("group", { name: "Database" }).getByRole("button", { name: "PostgreSQL" }).click();
  const card = page.getByRole("list", { name: "Community shares" }).getByRole("listitem").filter({ hasText: name });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Side by side");
  await expect(card.getByRole("list", { name: "Versions" }).getByRole("listitem")).toHaveText([
    "orm 0.45.4",
    "orm 1.0.0-rc.5",
  ]);
  await card.getByRole("list", { name: "Versions" }).hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
    "ORM 0.45.4 with Kit 0.31.11, and ORM 1.0.0-rc.5 with Kit 1.0.0-rc.5",
  );

  await card.getByRole("link", { name: `Open a copy of ${name}` }).click();
  const notice = page.getByRole("dialog", { name: `Open “${name}”?` });
  await expect(notice.getByRole("list", { name: "Versions" }).getByRole("listitem")).toHaveText([
    "0.45 PostgreSQL orm 0.45.4 · kit 0.31.11",
    "rc.5 PostgreSQL orm 1.0.0-rc.5 · kit 1.0.0-rc.5",
  ]);
  await expect(notice.getByRole("note")).toContainText("It opens as your own side-by-side copy");
  await notice.getByRole("button", { name: "Open a copy" }).click();

  await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText("Temporary copy, not saved");
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(getOutputPill(getLegacySide(page))).toHaveText("Not run yet");
  await expect(getOutputPill(getRcSide(page))).toHaveText("Not run yet");
});

/** A PostgreSQL pair whose rc.5 side throws after its queries, published through the app API. */
async function publishPair(request: APIRequestContext): Promise<string> {
  const schema =
    'import { pgTable, integer, text } from "drizzle-orm/pg-core";\n\nexport const users = pgTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() });\n';
  const query =
    'import { db } from "@drizzle-run/runtime/context";\nimport { users } from "./schema";\n\nawait db.insert(users).values([{ id: 1, name: "Ada" }, { id: 2, name: "Alan" }]);\nconst rows = await db.select().from(users);\n';
  const response = await postSnapshot(request, {
    data: {
      snapshotVersion: 1,
      name: "Embedded side by side",
      manifest: {
        kind: "drizzle-run-pair",
        manifestVersion: 1,
        entrypoints: { schema: "schema.ts", run: "query.ts" },
        files: {},
        sides: [
          {
            target: { dialect: "postgresql" },
            dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
            files: { "schema.ts": schema, "query.ts": `${query}$.display("Users", rows);\n` },
          },
          {
            target: { dialect: "postgresql" },
            dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
            files: { "schema.ts": schema, "query.ts": `${query}throw new Error("rc.5 side broke");\n` },
          },
        ],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);

  const { id }: { id: string } = await response.json();

  return id;
}

/** A PostgreSQL pair whose seed imports `drizzle-orm`, which a side-by-side seed may not, published through the API. */
async function publishSeedProblemPair(request: APIRequestContext): Promise<string> {
  const schema =
    'import { pgTable, integer } from "drizzle-orm/pg-core";\n\nexport const users = pgTable("users", { id: integer("id").primaryKey() });\n';
  const response = await postSnapshot(request, {
    data: {
      snapshotVersion: 1,
      name: "Embedded seed problem",
      manifest: {
        kind: "drizzle-run-pair",
        manifestVersion: 1,
        entrypoints: { schema: "schema.ts", seed: "seed.ts", run: "query.ts" },
        files: { "seed.ts": 'import { sql } from "drizzle-orm";\n\nexport default sql`select 1`;\n' },
        sides: [
          {
            target: { dialect: "postgresql" },
            dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
            files: { "schema.ts": schema, "query.ts": "export {};\n" },
          },
          {
            target: { dialect: "postgresql" },
            dependencies: { "drizzle-orm": "1.0.0-rc.5", "drizzle-kit": "1.0.0-rc.5" },
            files: { "schema.ts": schema, "query.ts": "export {};\n" },
          },
        ],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);

  const { id }: { id: string } = await response.json();

  return id;
}

test("should show a refused seed on a shared page as a banner to dismiss, and keep both sides open", async ({
  page,
  request,
}) => {
  const id = await publishSeedProblemPair(request);
  await page.goto(`/s/${id}`);

  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await getRunBothButton(page).click();

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "seed.ts seeds both sides, so it may only use drizzle-seed or db." });
  await expect(alert).toBeVisible();
  await expect(getLegacySide(page)).toBeVisible();
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toBeHidden();
  await expect(getRunBothButton(page)).toBeEnabled();
});

test("should show a seed that cannot seed both sides inside the embed, not as a load failure", async ({
  page,
  request,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The embed route runs only where Document-Isolation-Policy does.");
  const id = await publishSeedProblemPair(request);
  await page.goto(`/embed/${id}`);

  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await getRunBothButton(page).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "seed.ts seeds both sides, so it may only use drizzle-seed or db." }),
  ).toBeVisible();
  await expect(getRunBothButton(page)).toBeVisible();
});

test("should keep a side-by-side embed read only, run both sides, and show one side at a time under 760 px", async ({
  page,
  request,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The embed route runs only where Document-Isolation-Policy does.");
  const id = await publishPair(request);
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.goto(`/embed/${id}`);

  const legacy = page.getByRole("region", { name: "0.45 side" });
  const rc = page.getByRole("region", { name: "rc.5 side" });
  await expect(getRunBothButton(page)).toBeEnabled({ timeout: 120_000 });
  await expect(legacy).toBeVisible();
  await expect(rc).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Side" })).toHaveCount(0);
  await expect(legacy.getByRole("region", { name: "0.45 output" })).toContainText("Your results land here");
  await expect(legacy.getByText("Read only", { exact: true })).toBeVisible();
  await expect(rc.getByText("1.0.0-rc.5", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open full playground" })).toHaveAttribute("href", `/s/${id}`);
  await expect(page.getByRole("link", { name: "Open full playground" })).toHaveAttribute("target", "_blank");
  await expect(legacy.getByRole("tablist", { name: "0.45 output" }).getByRole("tab")).toHaveText([
    "Results",
    "Story",
    "Logs",
  ]);

  await legacy.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("typed-into-embed");
  await expect(legacy.locator(".monaco-editor .view-lines")).not.toContainText("typed-into-embed");

  await getRunBothButton(page).click();
  await expect(getSidePill(legacy)).toHaveText(/^✓ \d/, { timeout: 120_000 });
  await expect(getSidePill(rc)).toHaveText(/^Failed/, { timeout: 120_000 });
  await expect(legacy.getByRole("region", { name: "Users" })).toContainText("Ada");
  await expect(rc.getByRole("tab", { name: "Story" })).toHaveAttribute("aria-selected", "true");
  await expect(rc.getByRole("alert")).toContainText("rc.5 side broke");

  await page.setViewportSize({ width: 600, height: 760 });
  const sides = page.getByRole("tablist", { name: "Side" });
  await expect(sides.getByRole("tab", { name: /^0\.45/ })).toContainText("✓");
  await expect(sides.getByRole("tab", { name: /^rc\.5/ })).toContainText("Failed");
  await expect(legacy).toBeVisible();
  await expect(rc).toBeHidden();
  await sides.getByRole("tab", { name: /^rc\.5/ }).click();
  await expect(legacy).toBeHidden();
  await expect(rc.getByRole("alert")).toContainText("rc.5 side broke");
  await expect(rc.getByRole("status").filter({ hasText: /^rc\.5 failed/ })).toBeVisible();
  // The editor lays out again once its side shows, so the check waits for that.
  await expect
    .poll(() =>
      rc.locator(".monaco-editor").evaluate((editor) => {
        const right = editor.getBoundingClientRect().right;
        const lines = editor.querySelectorAll(".view-line").length;
        const numbered = editor.querySelectorAll(".line-numbers").length;
        const sideways = [...editor.querySelectorAll<HTMLElement>(".view-line > span")].some(
          (line) => line.getBoundingClientRect().right > right,
        );

        return numbered > 1 && lines > numbered && !sideways;
      }),
    )
    .toBe(true);

  // With both guests warm the run can end between two polls, so a DOM observer set up before the click catches the
  // button turning into Cancel.
  const sawRunning = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const observer = new MutationObserver(() => {
          const running = [...document.querySelectorAll("button[data-state=running]")].some(
            (button) => button.textContent?.trim() === "Cancel",
          );

          if (running) {
            observer.disconnect();
            resolve(true);
          }
        });

        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      }),
  );
  await getRunBothButton(page).click();
  expect(await sawRunning).toBe(true);
  await expect(getRunBothButton(page)).toHaveText("Run both", { timeout: 120_000 });
  await expect(sides.getByRole("tab", { name: /^0\.45/ })).toContainText("✓");
  await expect(rc.getByRole("alert")).toContainText("rc.5 side broke");
});

test("should show a side-by-side share's title and both releases on the click-to-load cover", async ({
  page,
  request,
}) => {
  const id = await publishPair(request);
  const preview = {
    title: "Side-by-side fixture",
    runtime: [
      { drizzleOrm: "0.45.4", database: "PostgreSQL" },
      { drizzleOrm: "1.0.0-rc.5", database: "PostgreSQL" },
    ],
  } satisfies PlaygroundPreview;
  const url = new URL("/", blogOrigin);
  url.searchParams.append("snapshotId", id);
  url.searchParams.set("baseUrl", appOrigin);
  url.searchParams.append("preview", JSON.stringify(preview));
  const appRequests: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).origin === appOrigin) {
      appRequests.push(sent.url());
    }
  });
  await page.goto(url.href);
  await expect(page.locator("html[data-fixture-ready='true']")).toHaveCount(1);

  const placeholder = page.locator("[data-drizzle-run-embed]");
  await expect(placeholder.getByRole("heading", { name: "Side-by-side fixture" })).toBeVisible();
  await expect(placeholder.locator(".chip")).toHaveText(["0.45.4", "1.0.0-rc.5", "PostgreSQL"]);
  expect(appRequests).toEqual([]);

  await placeholder.getByRole("button", { name: "Load playground in Drizzle Run" }).click();
  await expect(page.locator("iframe[data-drizzle-run-frame]")).toHaveCount(1);
});

test("should list each side's libraries from its pane head", async ({ page }) => {
  await createSideBySide(page, "Side libraries", /^Separate/);

  const libraries = page.getByRole("dialog", { name: "Libraries" });

  await getLegacySide(page).getByRole("button", { name: "Libraries", exact: true }).click();
  await expect(libraries.locator("dt", { hasText: "drizzle-zod" })).toBeVisible();
  await expect(libraries.locator("dt", { hasText: /^typebox$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(libraries).toBeHidden();

  await getRcSide(page).getByRole("button", { name: "Libraries", exact: true }).click();
  await expect(libraries.locator("dt", { hasText: /^typebox$/ })).toBeVisible();
  await expect(libraries.locator("dt", { hasText: "drizzle-zod" })).toHaveCount(0);
});
