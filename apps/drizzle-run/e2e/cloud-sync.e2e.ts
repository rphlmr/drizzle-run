import type { BrowserContext, Page } from "@playwright/test";

import { resolveDrizzleRunPorts, toLocalOrigin } from "../../../scripts/drizzle-run-ports";
import { projectRecord, storeProjects } from "./data";
import { expect, test } from "./fixtures";
import { routeGitHubAvatars, signInWithGitHub, useGitHubAccount } from "./github";
import { callStore, callStoreInOneWorker, getStoreWorkerPath } from "./store";

// Each test signs in as its own account, so the browsers running at once never share a cloud.

const origin = toLocalOrigin(resolveDrizzleRunPorts().app);

/** Deleting a project reaches the account after the 5 s edit pause. */
const deleteSyncTimeoutMs = 15_000;

function makeUniqueLogin(label: string) {
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

function makeProject(index: number, name: string) {
  return { ...projectRecord(index), id: crypto.randomUUID(), name };
}

function withQuery(project: ReturnType<typeof makeProject>, query: string) {
  return { ...project, manifest: { ...project.manifest, files: { ...project.manifest.files, "query.ts": query } } };
}

/**
 * Edits a project in the local store with the app closed, so the open app never saves over the edit, at a revision
 * above any the app saved
 */
async function editStoredProject(page: Page, project: ReturnType<typeof makeProject>): Promise<void> {
  await page.goto(getStoreWorkerPath());
  await storeProjects(page, [{ ...project, revision: 100 }], "/projects");
}

/** The account's revision of a project, as the Worker lists it; null when the account does not hold it. */
async function readCloudRevision(page: Page, projectId: string): Promise<number | null> {
  const response = await page.request.get(`${origin}/api/cloud`);
  const { projects } = (await response.json()) as { projects: { id: string; revision: number }[] };

  return projects.find((entry) => entry.id === projectId)?.revision ?? null;
}

function getUsageStrip(page: Page) {
  return page.getByRole("group", { name: "Cloud" });
}

function getCloudStatus(page: Page) {
  return getUsageStrip(page).getByTestId("cloud-sync-status");
}

function escapeRegExp(text: string) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The button in My projects that shows where a project is kept and opens the menu with its move. */
function getLocationButton(page: Page, name: string) {
  return page.getByRole("button", { name: new RegExp(`^${escapeRegExp(name)} is kept in`) });
}

async function expectLocation(page: Page, name: string, location: "Cloud" | "Local"): Promise<void> {
  await expect(getLocationButton(page, name)).toHaveAccessibleName(`${name} is kept in ${location}`);
}

function getAccountButton(page: Page) {
  return page.getByRole("banner").getByRole("button", { name: /^Account/ });
}

async function moveToCloud(page: Page, name: string): Promise<void> {
  await getLocationButton(page, name).click();
  await page.getByRole("menuitem", { name: /^Move to Cloud/ }).click();
  await expectLocation(page, name, "Cloud");
}

/**
 * Another browser on another machine, signed in to the same account: its own cookies and local store, holding
 * `projects`.
 */
async function openAnotherBrowser(
  page: Page,
  login: string,
  projects: readonly ReturnType<typeof makeProject>[] = [],
): Promise<{ context: BrowserContext; page: Page }> {
  const browser = page.context().browser();

  if (browser === null) {
    throw new Error("Expected the test page to belong to a launched browser.");
  }

  const context = await browser.newContext({ baseURL: origin });
  await routeGitHubAvatars(context);
  await useGitHubAccount(context, login);
  const otherPage = await context.newPage();
  await callStoreInOneWorker(otherPage, [
    ["writeSetting", "guide-seen", true],
    ["saveProjects", projects, []],
  ]);
  await signInWithGitHub(otherPage.request);

  return { context, page: otherPage };
}

test("should bring Cloud projects to a fresh browser on sign-in, and keep Local ones out of the account", async ({
  page,
}) => {
  const login = makeUniqueLogin("cloud");
  const cloud = makeProject(0, `Cloud ${login}`);
  const local = makeProject(1, `Local ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [cloud, local], "/projects");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectLocation(page, cloud.name, "Local");
  await expect(
    page.getByText("Local projects stay in this browser. Move one to Cloud to keep it in your account."),
  ).toBeVisible();
  await moveToCloud(page, cloud.name);
  await expect(getUsageStrip(page)).toContainText("1 of 100 projects");
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  await expect(page.getByRole("row").filter({ hasText: cloud.name })).toContainText("Cloud");
  await expect(page.getByRole("row").filter({ hasText: local.name })).toContainText("Local");

  const other = await openAnotherBrowser(page, login);
  await other.page.goto("/projects");
  await expect(other.page.getByRole("link", { name: cloud.name, exact: true })).toBeVisible();
  await expectLocation(other.page, cloud.name, "Cloud");
  await expect(other.page.getByRole("link", { name: local.name, exact: true })).toHaveCount(0);
  await expect(other.page.getByRole("dialog")).toHaveCount(0);

  await other.context.close();
});

test("should create a new project in Cloud by default, and duplicate it as Local from the editor", async ({ page }) => {
  const login = makeUniqueLogin("new");
  const name = `New ${login}`;
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  const signedOutDialog = page.getByRole("dialog", { name: "New project" });
  await expect(signedOutDialog.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(signedOutDialog.getByRole("radio", { name: "Cloud" })).toHaveCount(0);
  await signedOutDialog.getByRole("button", { name: "Cancel" }).click();

  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await page.reload();
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByRole("radio", { name: "Cloud" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "This browser only" })).not.toBeChecked();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();

  const footer = page.getByRole("contentinfo");
  await footer.getByRole("button", { name: "Cloud. Where this project is kept" }).click();
  const popover = page.getByRole("dialog", { name: "Kept in Cloud" });
  await expect(popover).toContainText("In your account, on every browser you sign in to");
  await popover.getByRole("button", { name: "Duplicate as Local" }).click();
  await expect(page.getByText(`Duplicated as ${name} copy`)).toBeVisible();
  await expect(footer.getByRole("button", { name: "Local. Where this project is kept" })).toBeVisible();

  await page.goto("/projects");
  await expect(getUsageStrip(page)).toContainText("1 of 100 projects");
  await expectLocation(page, name, "Cloud");
  await expectLocation(page, `${name} copy`, "Local");
});

test("should keep a project over 1 MB Local, and say why it cannot move to Cloud", async ({ page }) => {
  const login = makeUniqueLogin("quota");
  const large = makeProject(0, `Large ${login}`);
  const largeRecord = {
    ...large,
    // 600 KB of source stays under the 1 MiB source limit, but every newline takes two bytes in JSON.
    manifest: { ...large.manifest, files: { ...large.manifest.files, "seed.ts": "\n".repeat(600_000) } },
  };
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [largeRecord], "/projects");

  await expect(getUsageStrip(page)).toContainText("0 of 100 projects");
  await expect(page.getByRole("columnheader", { name: "Kept in" })).toBeVisible();
  const largeRow = page.getByRole("row").filter({ hasText: large.name });
  await expect(largeRow).toContainText(/1\.\d MB/);
  await expect(largeRow).toContainText("Over 1 MB");
  await getLocationButton(page, large.name).click();
  const moveItem = page.getByRole("menuitem", { name: /^Move to Cloud/ });
  await expect(moveItem).toBeDisabled();
  await expect(moveItem).toContainText("Over 1 MB, so it can't move to Cloud.");
  await page.keyboard.press("Escape");

  await getUsageStrip(page).getByRole("button", { name: "Details" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toContainText(`@${login}`);
  await expect(settings).toContainText("never your private Cloud projects");
  await expect(settings).toContainText("Cloud is free, so please don't abuse it.");
  await expect(settings.getByRole("switch")).toHaveCount(0);
});

test("should take Cloud projects out of this browser on sign-out, keep Local ones, and bring them back on sign-in", async ({
  page,
}) => {
  const login = makeUniqueLogin("leave");
  const cloud = makeProject(0, `Cloud ${login}`);
  const local = makeProject(1, `Local ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [cloud, local], "/projects");
  await moveToCloud(page, cloud.name);
  await expect(getCloudStatus(page)).toHaveText("Up to date");

  await getAccountButton(page).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const signOut = page.getByRole("dialog", { name: "Sign out?" });
  await expect(signOut).toContainText(
    "Your Cloud project leaves this browser. It comes back when you sign in. Your Local project stays here.",
  );
  await signOut.getByRole("button", { name: "Sign out" }).click();

  await expect(getAccountButton(page)).toHaveAccessibleName("Account");
  await expect(page.getByRole("link", { name: local.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: cloud.name, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("link", { name: local.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: cloud.name, exact: true })).toHaveCount(0);

  await signInWithGitHub(page.request);
  await page.reload();
  await expect(page.getByRole("link", { name: cloud.name, exact: true })).toBeVisible();
  await expectLocation(page, cloud.name, "Cloud");
  await expectLocation(page, local.name, "Local");
});

test("should stop the sign-out on edits the account lacks, and remove every Cloud project once signing out anyway", async ({
  page,
}) => {
  const login = makeUniqueLogin("unsaved");
  const saved = makeProject(0, `Saved ${login}`);
  const refused = makeProject(1, `Refused ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await page.route(`**/api/cloud/projects/${refused.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "invalid_project", message: "The project record is invalid." } }),
        })
      : route.fallback(),
  );
  await storeProjects(page, [saved, refused], "/projects");
  await moveToCloud(page, saved.name);
  await moveToCloud(page, refused.name);
  await expect(getCloudStatus(page)).toHaveText("1 project not saved");
  await expect(page.getByRole("row").filter({ hasText: refused.name })).toContainText("Not saved");

  await getUsageStrip(page).getByRole("button", { name: "Details" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByTestId("cloud-sync-problems")).toContainText(
    `${refused.name}: The project record is invalid.`,
  );
  await settings.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();

  const unsaved = page.getByRole("dialog", { name: "Some edits aren't in your account" });
  await expect(unsaved).toContainText("A Cloud project has edits that didn't save to your account.");
  await unsaved.getByRole("button", { name: "Sign out anyway" }).click();

  await expect(getAccountButton(page)).toHaveAccessibleName("Account");
  await expect(page.getByRole("link", { name: refused.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: saved.name, exact: true })).toHaveCount(0);
});

test("should offer to try again when signing out offline, and sign out once the account is back", async ({ page }) => {
  const login = makeUniqueLogin("offline");
  const cloud = makeProject(0, `Offline ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [cloud], "/projects");
  await moveToCloud(page, cloud.name);
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  await page.route("**/api/cloud**", (route) => route.abort("internetdisconnected"));

  await getAccountButton(page).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();
  const unreachable = page.getByRole("dialog", { name: "Your account can't be reached" });
  await expect(unreachable).toContainText("Signing out anyway removes your Cloud projects from this browser");
  await unreachable.getByRole("button", { name: "Try again" }).click();
  await expect(unreachable.getByRole("button", { name: "Try again" })).toBeEnabled();

  await page.unroute("**/api/cloud**");
  await unreachable.getByRole("button", { name: "Try again" }).click();

  await expect(getAccountButton(page)).toHaveAccessibleName("Account");
  await expect(page.getByRole("link", { name: cloud.name, exact: true })).toHaveCount(0);
});

test("should keep the other machine's version as a (copy) when both browsers edited a Cloud project", async ({
  page,
}) => {
  const login = makeUniqueLogin("conflict");
  const project = makeProject(0, `Users ${login}`);
  const other = await openAnotherBrowser(page, login, [project]);
  await other.page.goto("/projects");
  await moveToCloud(other.page, project.name);
  await expect(getCloudStatus(other.page)).toHaveText("Up to date");

  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await page.goto("/projects");
  await expectLocation(page, project.name, "Cloud");
  await expect(getCloudStatus(page)).toHaveText("Up to date");

  await page.route("**/api/cloud**", (route) => route.abort("internetdisconnected"));
  await editStoredProject(page, withQuery(project, "// edited here\n"));
  await expect(getCloudStatus(page)).toHaveText("Offline, retrying");

  await editStoredProject(other.page, withQuery(project, "// edited on the other machine\n"));
  await expect.poll(() => readCloudRevision(other.page, project.id)).toBe(2);

  await page.unroute("**/api/cloud**");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  const copyName = `${project.name} (copy)`;
  await expect(page.getByRole("table").getByRole("link", { name: copyName, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: project.name, exact: true })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "changed here and on another machine" });
  await expect(notice).toContainText(
    `${project.name} changed here and on another machine. The other version is in ${copyName}.`,
  );
  await expect(getUsageStrip(page)).toContainText("2 of 100 projects");
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  await expectLocation(page, copyName, "Cloud");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);

  await other.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(other.page.getByRole("table").getByRole("link", { name: copyName, exact: true })).toBeVisible();

  await other.context.close();
});

test("should delete a Cloud project everywhere", async ({ page }) => {
  const login = makeUniqueLogin("delete");
  const deleted = makeProject(0, `Deleted ${login}`);
  const kept = makeProject(1, `Kept ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [deleted, kept], "/projects");
  await moveToCloud(page, deleted.name);
  await moveToCloud(page, kept.name);
  await expect(getUsageStrip(page)).toContainText("2 of 100 projects");

  const other = await openAnotherBrowser(page, login);
  await other.page.goto("/projects");
  await expect(other.page.getByRole("link", { name: deleted.name, exact: true })).toBeVisible();
  await expect(other.page.getByRole("link", { name: kept.name, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Actions for ${deleted.name}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete project?" });
  await expect(deleteDialog).toContainText(
    `This removes ${deleted.name} from this browser, your account and your other browsers.`,
  );
  await expect(deleteDialog.getByRole("button", { name: "Keep in this browser only" })).toHaveCount(0);
  await deleteDialog.getByRole("button", { name: "Delete everywhere" }).click();
  await expect(page.getByRole("link", { name: deleted.name, exact: true })).toHaveCount(0);
  await expect(getUsageStrip(page)).toContainText("1 of 100 projects", { timeout: deleteSyncTimeoutMs });
  await expectLocation(page, kept.name, "Cloud");

  await other.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(other.page.getByRole("link", { name: deleted.name, exact: true })).toHaveCount(0);
  await expect(other.page.getByRole("link", { name: kept.name, exact: true })).toBeVisible();

  await other.context.close();
});

test("should keep the first account's Cloud projects when another account signs in to the same browser", async ({
  page,
}) => {
  const first = makeUniqueLogin("first");
  const project = makeProject(0, `Shared browser ${first}`);
  await useGitHubAccount(page.context(), first);
  await signInWithGitHub(page.request);
  await storeProjects(page, [project], "/projects");
  await moveToCloud(page, project.name);
  await expect(getUsageStrip(page)).toContainText("1 of 100 projects");

  await useGitHubAccount(page.context(), makeUniqueLogin("second"));
  await signInWithGitHub(page.request);
  await page.reload();
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  await expect(getUsageStrip(page)).toContainText("0 of 100 projects");
  await expectLocation(page, project.name, "Local");

  await useGitHubAccount(page.context(), first);
  await signInWithGitHub(page.request);
  await page.reload();
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  await expect(getUsageStrip(page)).toContainText("1 of 100 projects");
  await expectLocation(page, project.name, "Cloud");
});

test("should show the tab signed out when its session ended elsewhere, and offer to sign in again", async ({
  page,
}) => {
  const login = makeUniqueLogin("ended");
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await page.goto("/projects");
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  const accountButton = getAccountButton(page);
  await expect(accountButton).toHaveAccessibleName(`Account: signed in as @${login}`);

  const signOut = await page.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin } });
  expect(signOut.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(accountButton).toHaveAccessibleName("Account");
  await accountButton.click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Sign in with GitHub" })).toBeVisible();
});

test("should keep both accounts' Cloud copies when the second account's session expires", async ({ page }) => {
  const first = makeUniqueLogin("expiry-first");
  const second = makeUniqueLogin("expiry-second");
  const project = makeProject(0, `Shared ${first}`);
  await useGitHubAccount(page.context(), first);
  await signInWithGitHub(page.request);
  await storeProjects(page, [project], "/projects");
  await moveToCloud(page, project.name);
  await expect(getCloudStatus(page)).toHaveText("Up to date");

  await useGitHubAccount(page.context(), second);
  await signInWithGitHub(page.request);
  await page.reload();
  await expectLocation(page, project.name, "Local");
  await moveToCloud(page, project.name);
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  const logout = await page.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin } });
  expect(logout.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(getAccountButton(page)).toHaveAccessibleName("Account");
  await expect(page.getByRole("link", { name: project.name, exact: true })).toHaveCount(0);

  for (const login of [first, second]) {
    await useGitHubAccount(page.context(), login);
    await signInWithGitHub(page.request);
    await page.reload();
    await expectLocation(page, project.name, login === first ? "Cloud" : "Local");
    await expect(getCloudStatus(page)).toHaveText("Up to date");
    expect(await readCloudRevision(page, project.id)).toBe(1);
  }
});

test("should keep unsaved edits as Local after session expiry without deleting their account copy on sign-in", async ({
  page,
}) => {
  const login = makeUniqueLogin("expired-edits");
  const saved = makeProject(0, `Saved ${login}`);
  const edited = makeProject(1, `Edited ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [saved, edited], "/projects");
  await moveToCloud(page, saved.name);
  await moveToCloud(page, edited.name);
  await expect(getCloudStatus(page)).toHaveText("Up to date");

  await page.route("**/api/cloud**", (route) => route.abort("internetdisconnected"));
  await page.goto(getStoreWorkerPath());
  await storeProjects(page, [saved, { ...withQuery(edited, "// unsaved edit\n"), revision: 100 }], "/projects");
  await expect(getCloudStatus(page)).toHaveText("Offline, retrying");
  const logout = await page.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin } });
  expect(logout.ok()).toBe(true);

  await page.unroute("**/api/cloud**");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(getAccountButton(page)).toHaveAccessibleName("Account");
  await expect(page.getByRole("link", { name: saved.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: edited.name, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: edited.name, exact: true })).toBeVisible();
  const stored = await callStore(page, "readProject", edited.id);
  expect(stored?.manifest).toEqual(withQuery(edited, "// unsaved edit\n").manifest);

  await page.getByRole("button", { name: `Actions for ${edited.name}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const deleting = page.getByRole("dialog", { name: "Delete project?" });
  await expect(deleting).toContainText(`This removes ${edited.name} from this browser`);
  await deleting.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(page.getByRole("link", { name: edited.name, exact: true })).toHaveCount(0);

  await signInWithGitHub(page.request);
  await page.reload();
  await expectLocation(page, edited.name, "Cloud");
  await expectLocation(page, saved.name, "Cloud");
  expect(await readCloudRevision(page, edited.id)).toBe(1);
});

test("should recover another tab's pending edits as a Local copy when the session expires", async ({ page }) => {
  const login = makeUniqueLogin("pending-expiry");
  const project = makeProject(0, `Pending ${login}`);
  await useGitHubAccount(page.context(), login);
  await signInWithGitHub(page.request);
  await storeProjects(page, [project], "/projects");
  await moveToCloud(page, project.name);
  await expect(getCloudStatus(page)).toHaveText("Up to date");
  const other = await page.context().newPage();

  try {
    await other.goto(`/p/${project.id}`);
    await expect(other.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
    await expect(other.getByRole("button", { name: "Cloud. Where this project is kept", exact: true })).toBeVisible();
    await other.clock.install();
    await other.clock.pauseAt(new Date());
    await other.locator(".monaco-editor .view-lines").click();
    await other.keyboard.press("ControlOrMeta+End");
    await other.keyboard.insertText(" // pending edit survives expiry");
    await expect(other.getByRole("contentinfo")).toContainText("Unsaved changes");

    const logout = await page.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin } });
    expect(logout.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const notice = other.getByRole("status").filter({ hasText: "Your pending edits are kept in Local copies" });
    const copyLink = notice.getByRole("link", { name: `${project.name} copy`, exact: true });
    await expect(copyLink).toBeVisible();
    const copyPath = await copyLink.getAttribute("href");
    expect(copyPath).not.toBe(`/p/${project.id}`);
    await expect
      .poll(() => callStore(page, "loadProjects"))
      .toEqual([expect.objectContaining({ name: `${project.name} copy` })]);
    await other.screenshot({ path: test.info().outputPath("recovered-copy.png") });
    await other.clock.resume();
    await copyLink.click();
    await expect(other.locator(".monaco-editor .view-lines")).toContainText("pending edit survives expiry");
    await expect(other.getByRole("contentinfo")).toContainText("Saved in this browser");
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
    await other.reload();
    await expect(other.locator(".monaco-editor .view-lines")).toContainText("pending edit survives expiry");
    await other.goto("/projects");
    await expect(other.getByRole("link", { name: `${project.name} copy`, exact: true })).toBeVisible();

    await signInWithGitHub(page.request);
    await page.reload();
    await expectLocation(page, project.name, "Cloud");
    await expectLocation(page, `${project.name} copy`, "Local");
    expect(await readCloudRevision(page, project.id)).toBe(1);
  } finally {
    await other.close();
  }
});
