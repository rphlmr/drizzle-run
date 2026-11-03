import type { Dialect } from "@drizzle-run/core/catalog";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import { turnOnDebug } from "./debug";
import { expect, test } from "./fixtures";
import { countLiveWorkers, installLifecycleInstrumentation, type LifecycleWindow } from "./lifecycle-instrumentation";
import { postSnapshot } from "./publish";

const RUNAWAY_QUERY =
  'import { db } from "@drizzle-run/runtime/context";\nimport { records } from "./schema";\nawait db.insert(records).values({ id: 42 });\nglobalThis.__drizzleRunLifecycleMarker = "interrupted guest";\n$.display("Runaway entered", [{ entered: true }]);\nwhile (true) {}\n';

function createSnapshot(name: string, dialect: Dialect, query = RUNAWAY_QUERY) {
  const core = dialect === "postgresql" ? "pg" : "sqlite";

  return {
    snapshotVersion: 1,
    name,
    manifest: {
      kind: "drizzle-run",
      manifestVersion: 1,
      target: { dialect },
      dependencies: {
        "drizzle-orm": "0.45.4",
        "drizzle-kit": "0.31.11",
      },
      entrypoints: { schema: "schema.ts", run: "query.ts" },
      files: {
        "schema.ts": `import { ${core}Table, integer } from "drizzle-orm/${core}-core";\n\nexport const records = ${core}Table("records", { id: integer("id").primaryKey() });\n`,
        "query.ts": query,
      },
    },
  };
}

async function publishSnapshot(
  request: APIRequestContext,
  name: string,
  dialect: Dialect,
  query?: string,
): Promise<string> {
  const response = await postSnapshot(request, {
    data: createSnapshot(name, dialect, query),
  });
  const responseText = await response.text();
  expect(response.ok(), `Snapshot publication failed: ${responseText}`).toBe(true);

  const body: unknown = JSON.parse(responseText);
  expect(body).toMatchObject({ id: expect.any(String) });

  return (body as { id: string }).id;
}

async function waitForRuntimeReady(page: Page): Promise<boolean> {
  const run = page.getByRole("button", { name: "Run", exact: true });
  const ready = async () => (await run.count()) > 0 && (await run.isEnabled());

  await expect
    .poll(
      async () => {
        if (await ready()) {
          return true;
        }

        const alerts = (await page.getByRole("alert").allTextContents()).join(" ").trim();

        return alerts.length > 0;
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  if (await ready()) {
    return true;
  }

  const alerts = (await page.getByRole("alert").allTextContents()).join(" ").trim();
  expect(alerts, "Runtime preparation failed before the lifecycle test could run").toContain(
    "can't run in this browser",
  );

  return false;
}

async function replaceRunSource(page: Page, source: string): Promise<void> {
  const editorContent = page.locator(".monaco-editor .view-lines");
  await expect(editorContent).toBeVisible();
  await editorContent.click();
  await page.keyboard.press("ControlOrMeta+A");

  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await editorContent.innerText()).trim()).toBe("");
  await page.keyboard.insertText(source);

  const expectedSource = source.replace(/\s+/g, "");
  await expect
    .poll(async () => (await editorContent.innerText()).replace(/\s+/g, ""), {
      message: "The editor must contain the source tokens before execution",
    })
    .toBe(expectedSource);
}

async function waitForGuestRunPhase(page: Page, label: string): Promise<void> {
  await page.getByRole("tab", { name: "Debug" }).click();
  const debugReport = page
    .getByRole("region", { name: "Execution output" })
    .getByRole("tabpanel", { name: "Debug" })
    .locator("pre");

  await expect
    .poll(
      async () => {
        const text = await debugReport.textContent();

        if (text === null) {
          return false;
        }

        try {
          const snapshot = JSON.parse(text) as { states?: { phase?: string }[] };
          return snapshot.states?.some((state) => state.phase === "run") ?? false;
        } catch {
          return false;
        }
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  await expect(debugReport).toContainText(label);
}

async function switchProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("dialog").getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText(name);
}

async function createSecondProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("radiogroup", { name: "Database" }).getByRole("radio", { name: "SQLite" }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText(name);
  expect(await waitForRuntimeReady(page)).toBe(true);
}

async function verifyLifecycle(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  dialect: Dialect,
): Promise<void> {
  const runtimeAssetRequests: string[] = [];
  page.on("request", (assetRequest) => {
    const path = new URL(assetRequest.url()).pathname;

    if (path.startsWith("/runtime-assets/")) {
      runtimeAssetRequests.push(path);
    }
  });

  await installLifecycleInstrumentation(page);

  const snapshotId = await publishSnapshot(request, "Runtime lifecycle fixture", dialect);
  await page.goto(`/s/${snapshotId}`);
  await expect(page.getByRole("button", { name: "Fork to my projects" })).toBeVisible();
  await page.getByRole("button", { name: "Fork to my projects" }).click();
  await expect(page.getByRole("button", { name: "Switch project" })).toHaveText("Runtime lifecycle fixture");
  const supported = await waitForRuntimeReady(page);

  if (!supported) {
    await expect(page.getByRole("alert")).toContainText("can't run in this browser");
    expect(runtimeAssetRequests).toEqual([]);
    expect(await page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleWorkers ?? [])).toEqual([]);
    return;
  }

  await turnOnDebug(page);
  const run = page.getByRole("button", { name: "Run", exact: true });
  await run.click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({ timeout: 120_000 });
  await waitForGuestRunPhase(page, "Runaway entered");
  expect(await countLiveWorkers(page, "drizzle-run-execution")).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Cancelled/, {
    timeout: 30_000,
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("drizzle-run-debug.json");
  await expect.poll(() => page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleDownload)).toBeTruthy();
  const reportText = await page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleDownload);

  if (reportText === undefined) {
    throw new Error("The cancellation report download did not capture its contents.");
  }

  const report: unknown = JSON.parse(reportText);
  expect(report).toMatchObject({
    result: {
      outcome: "cancelled",
      cleanup: { guest: { mode: "forced" } },
    },
  });

  const cancelledWorkers = await page.evaluate(() => {
    return (window as LifecycleWindow).__drizzleRunLifecycleWorkers ?? [];
  });
  expect(cancelledWorkers).toHaveLength(1);
  expect(cancelledWorkers.every((worker) => worker.terminated)).toBe(true);

  await testInfo.attach("cancelled-owner-workers", {
    body: JSON.stringify(cancelledWorkers),
    contentType: "application/json",
  });

  const recoverySource = [
    'import { db } from "@drizzle-run/runtime/context";',
    'import { records } from "./schema";',
    'if ((await db.select().from(records)).length !== 0) { throw new Error("Database rows leaked across runs"); }',
    "if (globalThis.__drizzleRunLifecycleMarker !== undefined) {",
    'throw new Error("Guest globals leaked across runs");',
    "}",
    'globalThis.__drizzleRunLifecycleMarker = "recovered guest";',
    "for (let index = 0; index < 2200; index += 1) {",
    'console.log("bounded-output");',
    "}",
    '$.display("Fresh guest recovery", [{ recovered: true }]);',
  ].join(" ");
  await replaceRunSource(page, recoverySource);
  await run.click();
  const recoveryStatus = page.getByRole("region", { name: "Execution output" }).getByRole("status");
  await expect(recoveryStatus).toHaveText(/^(?:Succeeded|Failed)\b/, { timeout: 120_000 });

  if ((await recoveryStatus.textContent())?.startsWith("Failed")) {
    await page.getByRole("tab", { name: "Debug" }).click();
    await page.evaluate(() => {
      (window as LifecycleWindow).__drizzleRunLifecycleDownload = undefined;
    });
    const recoveryDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download report" }).click();
    await recoveryDownload;
    await expect
      .poll(() => page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleDownload))
      .toBeTruthy();
    const recoveryReport = await page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleDownload);
    await testInfo.attach("failed-recovery-report", {
      body: recoveryReport ?? "No recovery report captured",
      contentType: "application/json",
    });
  }

  await expect(recoveryStatus).toHaveText(/^Succeeded/);
  await expect.poll(() => countLiveWorkers(page, "drizzle-run-execution")).toBe(0);
  expect(await page.evaluate(() => (window as LifecycleWindow).__drizzleRunLifecycleWorkers?.length)).toBe(2);
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(page.getByRole("region", { name: "Fresh guest recovery" })).toContainText("true");
  await page.getByRole("tab", { name: "Logs" }).click();
  await page
    .getByRole("group", { name: "Show in Logs" })
    .getByRole("button", { name: /^Console/ })
    .click();
  const retainedLogs = page.locator("[data-slot=console-line]").filter({ hasText: "bounded-output" });
  await expect(retainedLogs).toHaveCount(2_200, { timeout: 30_000 });

  await replaceRunSource(page, 'import nonsense "./schema";');
  await run.click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Failed/, {
    timeout: 120_000,
  });
  await page.getByRole("tab", { name: "Problems" }).click();
  await expect(page.getByRole("button", { name: /query\.ts:\d+:\d+/ })).toBeVisible();

  await createSecondProject(page, "Lifecycle destination");
  await switchProject(page, "Runtime lifecycle fixture");
  expect(await waitForRuntimeReady(page)).toBe(true);
  await turnOnDebug(page);
  await replaceRunSource(
    page,
    'globalThis.__drizzleRunUnmountMarker = true; $.display("Unmount entered", [{ entered: true }]); while (true) {}',
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({ timeout: 120_000 });
  await waitForGuestRunPhase(page, "Unmount entered");

  const workersBeforeUnmount = await page.evaluate(() => {
    return (window as LifecycleWindow).__drizzleRunLifecycleWorkers?.length ?? 0;
  });
  expect(workersBeforeUnmount).toBeGreaterThan(0);
  const activeWorkersBeforeUnmount = await page.evaluate(() => {
    const workers = (window as LifecycleWindow).__drizzleRunLifecycleWorkers ?? [];
    return workers.filter((worker) => worker.name === "drizzle-run-execution" && !worker.terminated).length;
  });
  expect(activeWorkersBeforeUnmount).toBeGreaterThan(0);

  await switchProject(page, "Lifecycle destination");
  await expect
    .poll(
      async () =>
        page.evaluate((workerCount) => {
          const instrumentedWindow = window as LifecycleWindow;
          const workers = instrumentedWindow.__drizzleRunLifecycleWorkers ?? [];
          const earlierOwners = workers
            .slice(0, workerCount)
            .filter((worker) => worker.name === "drizzle-run-execution");
          return earlierOwners.length > 0 && earlierOwners.every((worker) => worker.terminated);
        }, workersBeforeUnmount),
      { timeout: 15_000 },
    )
    .toBe(true);

  expect(await waitForRuntimeReady(page)).toBe(true);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
  await expect.poll(() => countLiveWorkers(page, "drizzle-run-execution")).toBe(0);
}

for (const dialect of ["postgresql", "sqlite"] as const) {
  test(`${dialect}: cancels a runaway guest, recovers in a fresh realm, bounds output, and disposes on unmount`, async ({
    page,
    request,
  }, testInfo) => {
    await verifyLifecycle(page, request, testInfo, dialect);
  });
}

test("should terminate each execution worker and create a fresh one after switching projects on the same release", async ({
  page,
  request,
}) => {
  const query =
    'import { db } from "@drizzle-run/runtime/context";\nimport { records } from "./schema";\nexport default await db.select().from(records);\n';
  const first = await publishSnapshot(request, "Shared runtime A", "sqlite", query);
  const second = await publishSnapshot(request, "Shared runtime B", "sqlite", query);
  await installLifecycleInstrumentation(page);

  // Wait for each fork to open, so leaving the page cannot cut off its save.
  for (const [id, name] of [
    [first, "Shared runtime A"],
    [second, "Shared runtime B"],
  ] as const) {
    await page.goto(`/s/${id}`);
    await page.getByRole("button", { name: "Fork to my projects" }).click();
    await expect(page.getByRole("button", { name: "Switch project" })).toHaveText(name);
  }

  test.skip(!(await waitForRuntimeReady(page)), "This browser cannot run Drizzle Run.");
  await switchProject(page, "Shared runtime A");
  expect(await waitForRuntimeReady(page)).toBe(true);
  expect(await countLiveWorkers(page, "drizzle-run-execution")).toBe(0);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });
  await expect.poll(() => countLiveWorkers(page, "drizzle-run-execution")).toBe(0);
  const ownersBeforeSwitch = await page.evaluate(
    () =>
      ((window as LifecycleWindow).__drizzleRunLifecycleWorkers ?? []).filter(
        (worker) => worker.name === "drizzle-run-execution",
      ).length,
  );
  expect(ownersBeforeSwitch).toBe(1);

  await switchProject(page, "Shared runtime B");
  expect(await waitForRuntimeReady(page)).toBe(true);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
    timeout: 120_000,
  });

  expect(
    await page.evaluate(
      () =>
        ((window as LifecycleWindow).__drizzleRunLifecycleWorkers ?? []).filter(
          (worker) => worker.name === "drizzle-run-execution",
        ).length,
    ),
  ).toBe(ownersBeforeSwitch + 1);
  await expect.poll(() => countLiveWorkers(page, "drizzle-run-execution")).toBe(0);
});
