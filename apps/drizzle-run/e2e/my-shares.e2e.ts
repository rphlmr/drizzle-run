import type { APIRequestContext, Page } from "@playwright/test";

import { projectRecord, storeProjects } from "./data";
import { appOrigin, expect, test } from "./fixtures";
import { signInWithGitHub, useGitHubAccount } from "./github";
import { callStore } from "./store";

/** Publishes a snapshot as the signed-in account and returns its link id. */
async function publishShare(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`${appOrigin}/api/playgrounds`, {
    headers: { Origin: appOrigin, "Idempotency-Key": crypto.randomUUID() },
    data: {
      description: null,
      snapshot: {
        snapshotVersion: 1,
        name,
        manifest: {
          kind: "drizzle-run",
          manifestVersion: 1,
          target: { dialect: "sqlite" },
          dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
          entrypoints: { schema: "schema.ts", run: "query.ts" },
          files: { "schema.ts": "export {};\n", "query.ts": "export {};\n" },
        },
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);

  return ((await response.json()) as { id: string }).id;
}

/** A share as `GET /api/me/shares` lists it. */
function makeMyShare({ title, updatedAt }: { title: string; updatedAt: string }) {
  return {
    id: crypto.randomUUID(),
    title,
    description: null,
    pairs: [{ dialect: "postgresql", orm: "1.0.0-rc.5", kit: "1.0.0-rc.5", guestFlavor: "slim" }],
    createdAt: updatedAt,
    updatedAt,
    listing: null,
  };
}

/** Signs in as a login of its own, so no other test's shares or session show. */
async function signInAsNewAccount(page: Page): Promise<void> {
  await useGitHubAccount(page.context(), `shares-${crypto.randomUUID().slice(0, 8)}`);
  await signInWithGitHub(page.request);
}

test("should show the signed-in account's shares in the My shares tab, newest first, with who can find each one", async ({
  page,
}) => {
  // A login of its own, so the shared e2e database holds no other share of this account.
  const login = `shares-${crypto.randomUUID().slice(0, 8)}`;
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  const listedId = await publishShare(page.request, "Listed share");
  // The listing's round trip keeps the next share's creation time strictly later.
  const listed = await page.request.put(`${appOrigin}/api/playgrounds/${listedId}/listing`, {
    headers: { Origin: appOrigin },
    data: { topic: "bug-repros", description: null },
  });
  expect(listed.ok(), await listed.text()).toBe(true);
  await publishShare(page.request, "Newer share");

  await storeProjects(page, [projectRecord(0)], "/projects");
  const tabs = page.getByRole("navigation", { name: "My projects and shares" });
  await expect(tabs.getByRole("link", { name: "My projects" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("table", { name: "My shares" })).toHaveCount(0);
  await tabs.getByRole("link", { name: "My shares" }).click();
  await expect(page).toHaveURL(/\/projects\/shares$/);
  await expect(tabs.getByRole("link", { name: "My shares" })).toHaveAttribute("aria-current", "page");

  const table = page.getByRole("table", { name: "My shares" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").nth(1)).toContainText("Newer share");
  await expect(table.getByRole("row").nth(1)).toContainText("Link only");
  await expect(table.getByRole("row").nth(1)).toContainText("SQLiteorm 0.45.4 · kit 0.31.11Legacy");
  await expect(table.getByRole("row").nth(2)).toContainText("Listed share");
  await expect(table.getByRole("row").nth(2)).toContainText("In Community · Bug repro");
  await expect(table.getByRole("row").nth(1)).toContainText("Not in this browser");
  await expect(table.getByRole("button", { name: "Copy the link to Newer share" })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search shares" });
  await search.fill("LISTED");
  await expect(page).toHaveURL(/\?q=LISTED$/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row").nth(1)).toContainText("Listed share");
  await search.fill("no such share");
  await expect(page.getByText("No share matches “no such share”.")).toBeVisible();
  await search.fill("");
  await expect(table.getByRole("row")).toHaveCount(3);

  await table.getByRole("button", { name: "Actions for Listed share" }).click();
  await page.getByRole("menuitem", { name: "Open the shared page" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${listedId}$`));

  await page.goto("/projects/shares");
  await table.getByRole("button", { name: "Listed share", exact: true }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.getByRole("button", { name: "In Community", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.goBack();
  await expect(table.getByRole("link", { name: "Listed share", exact: true })).toHaveAttribute("href", /^\/p\//);
});

test("should open, unlist and stop a share from My shares, and forget its link in the project it came from", async ({
  page,
}) => {
  await signInAsNewAccount(page);
  const name = `Managed share ${crypto.randomUUID().slice(0, 8)}`;
  const project = { ...projectRecord(0), id: crypto.randomUUID(), name };
  await storeProjects(page, [project], `/p/${project.id}`);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /secrets/ }).click();
  await dialog.getByRole("button", { name: "Publish to Community", exact: true }).click();
  await expect(dialog.getByText("Published to Community.")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "In Community", exact: true })).toBeVisible();

  await page.goto("/projects");
  await page.getByRole("checkbox", { name: `Select ${name}` }).click();
  await page.getByRole("group", { name: "Selected projects" }).getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toContainText("Its share link stays public. To take it down, stop sharing it from Share first.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/projects/shares");
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("In Community");
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Unlist from Community" }).click();
  await expect(row).toContainText("Link only");

  await expect(row.getByRole("link", { name, exact: true })).toHaveAttribute("href", `/p/${project.id}`);
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await expect(page.getByRole("menuitem", { name: "Edit in My projects" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Open project" }).click();
  await expect(page).toHaveURL(`/p/${project.id}`);
  expect(await callStore(page, "loadProjects")).toHaveLength(1);

  await page.goto("/projects/shares");
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await expect(page.getByRole("menuitem", { name: "Unlist from Community" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Stop sharing…" }).click();
  const deleteDialog = page.getByRole("dialog", { name: `Stop sharing “${name}”?` });
  await expect(deleteDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await deleteDialog.getByRole("button", { name: "Stop sharing" }).click();
  await expect(deleteDialog).toBeHidden({ timeout: 60_000 });
  await expect(row).toHaveCount(0);

  await page.goto(`/p/${project.id}`);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible({ timeout: 60_000 });
});

test("should edit a share from My shares in a browser without its project, and push changes", async ({ page }) => {
  await signInAsNewAccount(page);
  const name = `Edited share ${crypto.randomUUID().slice(0, 8)}`;
  const linkId = await publishShare(page.request, name);
  const listed = await page.request.put(`${appOrigin}/api/playgrounds/${linkId}/listing`, {
    headers: { Origin: appOrigin },
    data: { topic: "playground", description: null },
  });
  expect(listed.ok(), await listed.text()).toBe(true);

  await storeProjects(page, [projectRecord(0)], "/projects/shares");
  const row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Edit in My projects" }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "In Community", exact: true })).toBeVisible();

  const editor = page.locator(".monaco-editor .view-lines");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// pushed from My shares\n");
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Update share", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /nothing private/ }).click();
  await dialog.getByRole("button", { name: "Update share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Share updated." })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "Local. Where this project is kept" }),
  ).toBeVisible();

  await page.goto("/projects/shares");
  await expect(row).toContainText("In Community");
  await expect(row.getByRole("link", { name, exact: true })).toHaveAttribute("href", /^\/p\//);

  await page.goto("/projects");
  const projectRow = page.getByRole("row").filter({ hasText: name });
  await expect(projectRow).toContainText("In Community");
  await expect(projectRow.getByRole("button", { name: `Copy the link to ${name}` })).toBeVisible();
  const shared: { snapshot: unknown } = await (await page.request.get(`${appOrigin}/api/playgrounds/${linkId}`)).json();
  expect(JSON.stringify(shared.snapshot)).toContain("pushed from My shares");
});

test("should show no tabs to a signed-out visitor, and send the My shares link back to My projects", async ({
  page,
}) => {
  await storeProjects(page, [projectRecord(0)], "/projects");

  await expect(page.getByRole("heading", { name: "My projects" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "My projects and shares" })).toHaveCount(0);

  await page.goto("/projects/shares");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "My projects" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My shares" })).toHaveCount(0);
});

test("should switch between the tabs without crossfading the page", async ({ page }) => {
  await page.addInitScript(() => {
    const transitions = { count: 0 };
    Object.assign(window, { siteTransitions: transitions });
    const start = document.startViewTransition?.bind(document);

    if (start) {
      document.startViewTransition = (...args: Parameters<typeof start>) => {
        transitions.count += 1;
        return start(...args);
      };
    }
  });
  await signInAsNewAccount(page);
  await page.route("**/api/me/shares*", (route) => route.fulfill({ json: { shares: [], nextCursor: null } }));

  await storeProjects(page, [projectRecord(0)], "/projects");
  test.skip(!(await page.evaluate(() => "startViewTransition" in document)), "No View Transitions in this browser");
  const tabs = page.getByRole("navigation", { name: "My projects and shares" });
  await tabs.getByRole("link", { name: "My shares" }).click();
  await expect(page.getByText("No shares yet.")).toBeVisible();
  await tabs.getByRole("link", { name: "My projects" }).click();
  await expect(page.getByRole("heading", { name: "My projects 1" })).toBeVisible();

  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { siteTransitions: { count: number } }).siteTransitions.count),
  ).toBe(0);
});

test("should append the next page of shares on Show more, and hide the button on the last page", async ({ page }) => {
  await signInAsNewAccount(page);
  const firstShare = makeMyShare({ title: "First page share", updatedAt: "2026-10-02T10:00:00.000Z" });
  const nextShare = makeMyShare({ title: "Next page share", updatedAt: "2026-10-01T10:00:00.000Z" });
  await page.route("**/api/me/shares*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");

    return route.fulfill(
      cursor === null
        ? { json: { shares: [firstShare], nextCursor: "next-page" } }
        : { json: { shares: [nextShare, firstShare], nextCursor: null } },
    );
  });

  await storeProjects(page, [projectRecord(0)], "/projects/shares");

  const table = page.getByRole("table", { name: "My shares" });
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "Show more shares" }).click();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").nth(2)).toContainText("Next page share");
  await expect(page.getByRole("button", { name: "Show more shares" })).toHaveCount(0);
});

test("should load the shares again on Try again after the first page failed", async ({ page }) => {
  await signInAsNewAccount(page);
  const share = makeMyShare({ title: "Loaded on retry", updatedAt: "2026-10-02T10:00:00.000Z" });
  let failing = true;
  await page.route("**/api/me/shares*", (route) =>
    failing
      ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Down" } } })
      : route.fulfill({ json: { shares: [share], nextCursor: null } }),
  );

  await storeProjects(page, [projectRecord(0)], "/projects/shares");

  await expect(page.getByText("Your shares could not be loaded. Try again in a moment.")).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("table", { name: "My shares" }).getByRole("button", { name: "Loaded on retry", exact: true }),
  ).toBeVisible();
});

test("should show the account signed out when the Worker refuses the session behind My shares", async ({ page }) => {
  await signInAsNewAccount(page);
  let sessionEnded = false;
  await page.route("**/api/me/shares*", (route) => {
    sessionEnded = true;

    return route.fulfill({
      status: 401,
      json: { error: { code: "sign_in_required", message: "Sign in with GitHub to see your shares." } },
    });
  });
  await page.route("**/api/auth/session", (route) =>
    sessionEnded ? route.fulfill({ json: { configured: true, user: null } }) : route.fallback(),
  );

  await storeProjects(page, [projectRecord(0)], "/projects/shares");

  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "My shares" })).toHaveCount(0);
});
