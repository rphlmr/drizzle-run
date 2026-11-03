import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { RunResult } from "@drizzle-run/core/contracts";
import { createRecordedRun } from "@drizzle-run/core/contracts";
import { PAIR_SIDES, pairSide } from "@drizzle-run/core/pair";

import {
  digestOfficialManifest,
  listOfficialEmbeds,
  listOfficialGuests,
  resolveOfficialRecording,
} from "../src/official/official-embeds";
import { isPairManifest } from "../src/project/projects";
import { expect, test } from "./fixtures";
import { readOfficialExamples } from "./official-examples";
import { runStoredProject } from "./run-project";

/**
 * `pnpm record:official` records the run of every official embed: each example, and each step of its guide that runs.
 * It runs the code in the built app on Chromium and writes the recording next to the content, as
 * `examples/<folder>/recording.json` or `guides/<folder>/recordings/<step>.json`. A recording still valid for its code
 * and guests is kept, so its time does not churn; OFFICIAL_RECORDINGS_FORCE=1 records every one again. The unit tests fail when a
 * recording is missing, was recorded for other code, or ran on a guest the catalog has since refreshed.
 */

const appDirectory = resolve("apps/drizzle-run");
const force = process.env.OFFICIAL_RECORDINGS_FORCE === "1";

test.describe.configure({ mode: "parallel" });

for (const embed of listOfficialEmbeds(readOfficialExamples())) {
  const name = embed.step === undefined ? embed.example.slug : `${embed.example.slug}/${embed.step.id}`;

  test(`official embed ${name}: record`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const recordingFile = join(appDirectory, embed.recordingPath);
    const kept =
      existsSync(recordingFile) &&
      resolveOfficialRecording(embed, JSON.parse(readFileSync(recordingFile, "utf8"))) !== null;

    test.skip(kept && !force, `${embed.recordingPath} is still valid for its code and guests.`);

    await page.goto("/");
    await expect(page.getByRole("heading").first()).toBeVisible();

    // Run the code
    const manifest = embed.manifest;
    const runs = isPairManifest(manifest) ? PAIR_SIDES.map((side) => pairSide(manifest, side)) : [manifest];
    const results: RunResult[] = [];

    for (const sideManifest of runs) {
      const result = await runStoredProject(page, name, sideManifest);

      expect(result.outcome, `${name}: the run must succeed (${result.error?.message ?? ""}).`).toBe("succeeded");
      results.push(result);
    }

    // Record the run
    const [first, second] = results;
    const [firstGuest, secondGuest] = listOfficialGuests(manifest);
    const snapshotDigest = digestOfficialManifest(manifest);
    const recordedAt = new Date().toISOString();

    if (first === undefined || firstGuest === undefined) {
      throw new Error(`${name}: expected at least one run, but got none.`);
    }

    const created =
      second === undefined || secondGuest === undefined
        ? createRecordedRun({ result: first, guests: [firstGuest], snapshotDigest, recordedAt })
        : createRecordedRun({
            sides: [first, second],
            guests: [firstGuest, secondGuest],
            snapshotDigest,
            recordedAt,
          });

    if (created.status !== "recorded") {
      throw new Error(`${name}: expected a recording, but the run was ${created.status}.`);
    }

    mkdirSync(dirname(recordingFile), { recursive: true });
    writeFileSync(recordingFile, `${JSON.stringify(created.recording, null, 2)}\n`);
  });
}
