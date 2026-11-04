import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SerializedValue } from "@drizzle-run/core/contracts";
import { isPairProject, parseGuideManifest, resolveStep } from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import { PAIR_SIDES, pairSide, pairSideLabels } from "@drizzle-run/core/pair";

import { expect, test } from "./fixtures";
import { groupDisplaysByLabel, runStoredProject } from "./run-project";

/**
 * `pnpm replay:guides` replays every guide: each step that runs is run twice
 * on its resolved files, and the displays go to `guides/<folder>/expected.json`. A side-by-side
 * guide runs each side, and its displays are kept per side, named by release.
 * With GUIDES_CHECK=1 (`pnpm check:guides`) it fails instead of writing when the committed file is stale.
 * It fails when a step's run errors, changes between two runs, or misses a highlighted display.
 */

const guidesDirectory = resolve("apps/drizzle-run/guides");
const checkOnly = process.env.GUIDES_CHECK === "1";

function normalizePaginationTimestamps(json: string): string {
  return json.replace(
    /("createdAt":\s*\{\s*"type":\s*"primitive",\s*"value":\s*")(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})(?::?(\d{2}))?("\s*\})/g,
    (_match, prefix: string, date: string, time: string, hours: string, minutes: string | undefined, suffix: string) =>
      `${prefix}${new Date(`${date}T${time}${hours}:${minutes ?? "00"}`).toISOString()}${suffix}`,
  );
}

test("guide replay compares PostgreSQL timestamps by instant", () => {
  const paris = '{"createdAt":{"type":"primitive","value":"2026-01-01 10:00:00+01"}}';

  expect(normalizePaginationTimestamps(paris)).toBe(
    normalizePaginationTimestamps('{"createdAt":{"type":"primitive","value":"2026-01-01 09:00:00+00"}}'),
  );
  expect(normalizePaginationTimestamps(paris)).not.toBe(
    normalizePaginationTimestamps('{"createdAt":{"type":"primitive","value":"2026-01-01 10:00:00+00"}}'),
  );
});

const guides = readdirSync(guidesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(guidesDirectory, entry.name, "guide.json")))
  .map((entry) => ({
    name: entry.name,
    folder: join(guidesDirectory, entry.name),
    manifest: parseGuideManifest(JSON.parse(readFileSync(join(guidesDirectory, entry.name, "guide.json"), "utf8"))),
  }));

for (const { name, folder, manifest } of guides) {
  test(`guide ${name}: replay`, async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await page.goto("/");
    await expect(page.getByRole("heading").first()).toBeVisible();

    type Displays = Record<string, readonly SerializedValue[]>;
    const expected: Record<string, Displays | Record<string, Displays>> = {};

    for (const [index, step] of manifest.steps.entries()) {
      if (step.run === "none") {
        continue;
      }

      const { project } = resolveStep(manifest, index);
      // Keyed by side label, so two sides on one release keep apart.
      const runs: [string | undefined, RunManifest][] = isPairProject(project)
        ? PAIR_SIDES.map((side) => [pairSideLabels(project)[side], pairSide(project, side)])
        : [[undefined, project]];
      const sides: Record<string, Displays> = {};

      for (const [label, sideProject] of runs) {
        const first = await runStoredProject(page, manifest.id, sideProject);
        const second = await runStoredProject(page, manifest.id, sideProject);
        const where = `${manifest.id}/${step.id}${label === undefined ? "" : ` (${label})`}`;

        expect(first.outcome, `${where}: the step must run without an error (${first.error?.message ?? ""}).`).toBe(
          "succeeded",
        );

        const values = groupDisplaysByLabel(first);

        expect(groupDisplaysByLabel(second), `${where}: the displays change between runs.`).toEqual(values);

        for (const display of step.highlight?.displays ?? []) {
          expect(
            values[display],
            `${where}: highlights "${display}", but the run displays no "${display}".`,
          ).toBeDefined();
        }

        if (label === undefined) {
          expected[step.id] = values;
        } else {
          sides[label] = values;
        }
      }

      if (isPairProject(project)) {
        expected[step.id] = sides;
      }
    }

    const output = `${JSON.stringify({ steps: expected }, null, 2)}\n`;
    const path = join(folder, "expected.json");

    if (checkOnly) {
      const recorded = existsSync(path) ? readFileSync(path, "utf8") : "";
      const timezoneDependent = name === "pagination-postgresql" || name === "pagination-apis-postgresql";
      expect(
        timezoneDependent ? normalizePaginationTimestamps(recorded) : recorded,
        `guides/${name}/expected.json is stale. Run pnpm replay:guides.`,
      ).toBe(timezoneDependent ? normalizePaginationTimestamps(output) : output);
    } else {
      writeFileSync(path, output);
    }
  });
}
