import { readFile } from "node:fs/promises";

import type { RunResult, SerializedValue } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import type { Page } from "@playwright/test";

import { turnOnDebug } from "./debug";
import { expect } from "./fixtures";
import { callStore } from "./store";

let runCount = 0;

/** Runs a manifest as a stored project in the built app and returns the full result from the Debug report. */
export async function runStoredProject(page: Page, name: string, manifest: RunManifest): Promise<RunResult> {
  const id = `00000000-0000-4000-9000-${String((runCount += 1)).padStart(12, "0")}`;
  const now = new Date().toISOString();
  const record = {
    version: 1,
    id,
    name: `${name} ${runCount}`,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    trust: "trusted" as const,
    manifest,
  };

  await callStore(page, "saveProjects", [record], []);
  await page.goto(`/p/${id}`);
  await turnOnDebug(page);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(
    /^(?:Succeeded|Failed)\b/,
    { timeout: 120_000 },
  );
  await page.getByRole("tab", { name: "Debug", exact: true }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const report: { result?: RunResult } = JSON.parse(await readFile(await (await download).path(), "utf8"));

  if (!report.result) {
    throw new Error(`${name}: the run returned no result.`);
  }

  return report.result;
}

/** A run's `$.display` values by their label. */
export function groupDisplaysByLabel(result: RunResult): Record<string, readonly SerializedValue[]> {
  return Object.fromEntries(result.displays.map((display) => [display.label, display.values]));
}
