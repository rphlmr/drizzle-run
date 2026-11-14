import type { APIRequestContext, Page } from "@playwright/test";

import { projectRecord, storeProjects } from "./data";
import { appOrigin, expect, test } from "./fixtures";
import { signInWithGitHub } from "./github";

const origin = appOrigin;

/** A name no other run uses, so the search finds only this test's share in the shared e2e database. */
function makeUniqueName(label: string) {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

/** Publishes a snapshot and lists it signed in, as the Share dialog does. */
async function listShare(request: APIRequestContext, name: string, topic = "playground"): Promise<string> {
  await signInWithGitHub(request);
  const response = await request.post(`${origin}/api/playgrounds`, {
    headers: { Origin: origin, "Idempotency-Key": crypto.randomUUID() },
    data: {
      description: "Shared from the Community e2e spec.",
      snapshot: {
        snapshotVersion: 1,
        name,
        manifest: {
          kind: "drizzle-run",
          manifestVersion: 1,
          target: { dialect: "sqlite" },
          dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
          entrypoints: { schema: "schema.ts", run: "query.ts" },
          files: {
            "schema.ts":
              'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";\n\nexport const users = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() });\n',
            "query.ts": '$.display("Users", [{ id: 1, name: "Ada" }]);\n',
          },
        },
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);

  const { id }: { id: string } = await response.json();
  const listed = await request.put(`${origin}/api/playgrounds/${id}/listing`, {
    headers: { Origin: origin },
    data: { topic, description: "Shared from the Community e2e spec." },
  });
  expect(listed.ok(), await listed.text()).toBe(true);

  return id;
}

async function search(page: Page, name: string): Promise<void> {
  await page.getByRole("searchbox", { name: "Search community shares" }).fill(name);
  await expect(page.getByRole("list", { name: "Community shares" }).getByRole("listitem")).toHaveCount(1);
}

test("should open a listed share as a temporary copy after the notice, which can be turned off", async ({
  page,
  request,
}) => {
  const first = makeUniqueName("Community first");
  const second = makeUniqueName("Community second");
  const firstId = await listShare(request, first);
  const secondId = await listShare(request, second, "bug-repros");

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Community" }).click();
  await expect(page).toHaveURL(/\/community$/);
  await expect(page.getByRole("heading", { name: "Community shares" })).toBeVisible();
  // The page crossfades in under a view transition, which covers it until it ends. Headless Firefox holds it about
  // 500 ms, long enough for a fill to reach the page before React has mounted it.
  await page.waitForFunction(() => document.activeViewTransition === null);

  await search(page, first);
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(first).replaceAll("%20", "\\+")}`));
  const card = page.getByRole("listitem").filter({ hasText: first });
  await expect(card).toContainText("orm 0.45.4");
  await card.getByText("orm 0.45.4", { exact: true }).hover();
  await expect(page.locator("[data-slot=tooltip-content]")).toHaveText("ORM 0.45.4 with Kit 0.31.11");

  await card.getByRole("link", { name: `Open a copy of ${first}` }).click();
  const notice = page.getByRole("dialog", { name: `Open “${first}”?` });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("note")).toContainText("Not an official example");
  await notice.getByRole("button", { name: "Cancel" }).click();
  await expect(notice).toBeHidden();
  await expect(page).toHaveURL(/\/community/);

  await card.getByRole("link", { name: `Open a copy of ${first}` }).click();
  await notice.getByRole("checkbox", { name: "Don't show this again for community shares" }).click();
  await notice.getByRole("button", { name: "Open a copy" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${firstId}$`));
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText("Temporary copy, not saved");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByText("Your results land here")).toBeVisible();

  await page.goto("/community?topic=bug-repros");
  await search(page, second);
  await page.getByRole("link", { name: `Open a copy of ${second}` }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${secondId}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("should show the notice and who listed it when a listed link opens directly, except to its owner", async ({
  page,
  request,
}) => {
  const name = makeUniqueName("Community direct");
  const id = await listShare(request, name);
  const notice = page.getByRole("dialog", { name: `Open “${name}”?` });

  await page.goto(`/s/${id}`);
  await expect(notice).toContainText("Shared by @octocat");
  await notice.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/community$/);

  await page.goto(`/s/${id}`);
  await notice.getByRole("button", { name: "Open a copy" }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByRole("note").filter({ hasText: "Listed in Community by" })).toContainText(
    "Listed in Community by @octocat.",
  );
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  await signInWithGitHub(page.request);
  await page.goto(`/s/${id}`);
  await expect(page.getByRole("note").filter({ hasText: "Listed in Community by" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await expect(notice).toHaveCount(0);
});

test("should send the filters to the Worker and say so for a reported share", async ({ page, request }) => {
  const name = makeUniqueName("Community report");
  await listShare(request, name, "bug-repros");

  await page.goto("/community");
  await page.getByRole("group", { name: "Topic" }).getByRole("button", { name: "Bug repros" }).click();
  await page.getByRole("group", { name: "Database" }).getByRole("button", { name: "PostgreSQL" }).click();
  await page.getByRole("searchbox", { name: "Search community shares" }).fill(name);
  await expect(page.getByText("No share matches these filters.")).toBeVisible();
  await expect(page).toHaveURL(/topic=bug-repros/);
  await expect(page).toHaveURL(/db=postgresql/);

  await page.getByRole("group", { name: "Database" }).getByRole("button", { name: "SQLite" }).click();
  await expect(page.getByRole("list", { name: "Community shares" }).getByRole("listitem")).toHaveCount(1);

  const listReads: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/community") {
      listReads.push(sent.url());
    }
  });
  await page.getByRole("button", { name: `Report ${name}` }).click();
  const confirm = page.getByRole("dialog", { name: "Report this share?" });
  await confirm.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name }).getByRole("status")).toHaveText("Reported");
  // A report changes no list, so the shares shown stay without a reload.
  expect(listReads).toEqual([]);

  await page.reload();
  const card = page.getByRole("listitem").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Reported");
});

test("should open a share clicked before the search pause ends", async ({ page, request }) => {
  const name = makeUniqueName("Community pause");
  const shareId = await listShare(request, name);

  await page.goto("/community");
  await search(page, name);

  const { promise: shareRequested, resolve: markShareRequested } = Promise.withResolvers<void>();
  const { promise: release, resolve: releaseShare } = Promise.withResolvers<void>();
  await page.route(`**/api/playgrounds/${shareId}`, async (route) => {
    markShareRequested();
    await release;
    await route.continue();
  });
  await page.getByRole("searchbox", { name: "Search community shares" }).pressSequentially(" ");
  await page.getByRole("link", { name: `Open a copy of ${name}` }).click();
  await shareRequested;
  // Longer than the search pause, so a late search would land while the share still loads.
  await page.waitForTimeout(1_000);
  releaseShare();

  await expect(page).toHaveURL(new RegExp(`/s/${shareId}$`));
  await expect(page.getByRole("dialog", { name: `Open “${name}”?` })).toBeVisible();
});

test("should ask only a signed-out visitor to sign in before listing a share", async ({ page }) => {
  await page.goto("/community");
  await expect(page.getByText("Add yours: sign in with GitHub, share a project")).toBeVisible();

  await signInWithGitHub(page.request);
  await page.reload();
  await expect(page.getByText("Add yours: share a project")).toBeVisible();
});

test("should publish a project to Community in one step, and unlist it without editing the project", async ({
  page,
}) => {
  const name = makeUniqueName("Listed from the dialog");
  await signInWithGitHub(page.request);

  const project = { ...projectRecord(0), id: crypto.randomUUID(), name };
  await storeProjects(page, [project], `/p/${project.id}`);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await dialog.getByRole("textbox", { name: /Description/ }).fill("Listed by the e2e spec.");
  await expect(dialog.getByRole("radio", { name: "Community" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "How something works" })).toBeChecked();
  await dialog.getByRole("radio", { name: "A Drizzle bug" }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Publish to Community", exact: true }).click();
  await expect(dialog.getByText("Published to Community.")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText(/Listed under @octocat/)).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "A Drizzle bug" })).toBeChecked();
  const shareUrl = await dialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "In Community", exact: true })).toBeVisible();

  const community = await page.context().newPage();
  await community.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          sessionStorage.setItem("copied-text", text);
        },
      },
    });
  });
  await community.goto("/community");
  await community.getByRole("searchbox", { name: "Search community shares" }).fill(name);
  await expect(community.getByText("No share matches these filters.")).toBeVisible();
  await community.goto("/community?topic=bug-repros");
  await search(community, name);
  const card = community.getByRole("listitem").filter({ hasText: name });
  await expect(card).toContainText("Listed by the e2e spec.");
  await expect(card).toContainText("@octocat");
  await card.getByRole("button", { name: `Copy the link to ${name}` }).click();
  await expect(card.getByRole("button", { name: `Copy the link to ${name}` })).toHaveText("Copied");
  expect(await community.evaluate(() => sessionStorage.getItem("copied-text"))).toBe(shareUrl);
  await expect(card.getByRole("link", { name: `Open a copy of ${name}` })).toHaveAttribute(
    "href",
    new URL(shareUrl).pathname,
  );
  await expect(community).toHaveURL(/\/community\?/);

  await page.getByRole("button", { name: "In Community", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Share", exact: true })).toBeVisible();
  await expect(dialog.getByRole("note")).toContainText("Shows your latest code");
  await dialog.getByRole("radio", { name: "Link only" }).click();
  await expect(dialog.getByText(/Pick Community to let others find and fork it/)).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole("radio", { name: "Link only" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Shared", exact: true })).toBeVisible();

  await community.reload();
  await expect(community.getByRole("searchbox", { name: "Search community shares" })).toHaveValue(name);
  await expect(community.getByText("No share matches these filters.")).toBeVisible();

  await community.goto(new URL(shareUrl).pathname);
  await expect(community.locator("[data-slot=share-description]")).toHaveText("Listed by the e2e spec.");
});

test("should show updated code in Community without listing the share again", async ({ page }) => {
  const name = makeUniqueName("Listed then pushed");
  await signInWithGitHub(page.request);

  const project = { ...projectRecord(0), id: crypto.randomUUID(), name };
  await storeProjects(page, [project], `/p/${project.id}`);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Publish to Community", exact: true }).click();
  await expect(dialog.getByText("Published to Community.")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// pushed to Community\n");
  await page.getByRole("button", { name: "Update share", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Update share" })).toBeVisible();
  await expect(dialog).toContainText("The link, its embeds and its Community card show your current code.");
  await dialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await dialog.getByRole("button", { name: "Update share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Share updated." })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "In Community", exact: true }).click();
  await expect(dialog.getByText(/Listed under @octocat/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "In Community", exact: true })).toHaveText("In Community");
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "Local. Where this project is kept" }),
  ).toBeVisible();

  await page.goto("/community");
  await search(page, name);
  await page.getByRole("link", { name: `Open a copy of ${name}` }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("pushed to Community", { timeout: 120_000 });
});

test("should keep the account menu open while the Community page finishes its first load", async ({ page }) => {
  const { promise: release, resolve: releaseShares } = Promise.withResolvers<void>();
  await page.route("**/api/community*", async (route) => {
    await release;
    await route.continue();
  });

  await page.goto("/community");
  await expect(page.getByRole("list", { name: "Loading community shares" })).toBeVisible();
  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Account/ })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  releaseShares();

  await expect(page.getByRole("searchbox", { name: "Search community shares" })).toBeVisible();
  await expect(menu).toBeVisible();
});
