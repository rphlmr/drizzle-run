import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { findUnpublishedPackages, readReleasePackages } from "../../../scripts/pack-release.ts";

type JobResult = "success" | "failure" | "cancelled" | "skipped" | "in_progress";

interface ReleaseRun {
  cancelled: boolean;
  needs: {
    packages: { result: JobResult; outputs: { "has-changesets": string; "app-deployed": string } };
    pack: { result: JobResult; outputs: { unpublished: string } };
    publish: { result: JobResult };
  };
}

function makeRun({
  packages = "success",
  pack = "success",
  publish = "success",
  unpublished = "true",
  hasChangesets = "false",
  deployed = "false",
  cancelled = false,
}: {
  packages?: JobResult;
  pack?: JobResult;
  publish?: JobResult;
  unpublished?: string;
  hasChangesets?: string;
  deployed?: string;
  cancelled?: boolean;
} = {}): ReleaseRun {
  return {
    cancelled,
    needs: {
      packages: { result: packages, outputs: { "has-changesets": hasChangesets, "app-deployed": deployed } },
      pack: { result: pack, outputs: { unpublished } },
      publish: { result: publish },
    },
  };
}

/** Evaluate the real job condition after its declared dependencies, including GitHub's implicit success check. */
function shouldDeploy(run: ReleaseRun): boolean {
  const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
  const production = workflow.split("\n  production:\n")[1];

  if (production === undefined) {
    throw new Error("Release workflow has no production job");
  }

  const dependencyLine = production.match(/^    needs: (.+)$/m)?.[1];
  const conditionMatch = production.match(/^    if: (?:>-\n((?:      .+\n)+)|(.+))/m);
  const condition = (conditionMatch?.[1] ?? conditionMatch?.[2])?.trim();

  if (dependencyLine === undefined || condition === undefined) {
    throw new Error("Production job must declare its dependencies and condition");
  }

  const dependencyNames = dependencyLine
    .replaceAll("[", "")
    .replaceAll("]", "")
    .split(",")
    .map((name) => name.trim());
  const dependencies = dependencyNames.map((name) => {
    const dependency = Object.entries(run.needs).find(([id]) => id === name)?.[1];

    if (dependency === undefined) {
      throw new Error(`Unexpected production dependency: ${name}`);
    }

    return dependency;
  });

  if (dependencies.some((dependency) => dependency.result === "in_progress")) {
    return false;
  }

  const succeeded = dependencies.every((dependency) => dependency.result === "success");
  const hasStatusCheck = /\b(?:always|cancelled|failure|success)\s*\(/.test(condition);

  if (!hasStatusCheck && !succeeded) {
    return false;
  }

  return Boolean(
    runInNewContext(`(${condition.replace(/\.([\w]+(?:-[\w]+)+)/g, '["$1"]')})`, {
      needs: run.needs,
      cancelled: () => run.cancelled,
      always: () => true,
      success: () => succeeded,
      failure: () => dependencies.some((dependency) => dependency.result === "failure"),
    }),
  );
}

describe("production release prerequisites", () => {
  it("should deploy after all missing package versions were successfully published", () => {
    expect(shouldDeploy(makeRun())).toBe(true);
  });

  it("should deploy when every exact package version already exists and publishing is skipped", () => {
    expect(shouldDeploy(makeRun({ unpublished: "false", publish: "skipped" }))).toBe(true);
  });

  it.each([
    { label: "packing is running", pack: "in_progress", publish: "in_progress" },
    { label: "publishing is running", publish: "in_progress" },
    { label: "packing failed", pack: "failure", publish: "skipped" },
    { label: "packing was cancelled", pack: "cancelled", publish: "skipped" },
    { label: "packing was skipped", pack: "skipped", publish: "skipped" },
    { label: "publishing failed", publish: "failure" },
    { label: "publishing was cancelled", publish: "cancelled" },
    { label: "unpublished packages were not published", publish: "skipped" },
    { label: "the version check produced no answer", unpublished: "", publish: "skipped" },
    { label: "the version check produced an unknown answer", unpublished: "unknown" },
    { label: "versioning failed", packages: "failure" },
    { label: "changesets are pending", hasChangesets: "true" },
    { label: "the app version is already deployed", deployed: "true" },
    { label: "the workflow is cancelled", cancelled: true },
  ] satisfies Array<Parameters<typeof makeRun>[0] & { label: string }>)(
    "should not deploy when $label",
    ({ label, ...options }) => {
      expect(shouldDeploy(makeRun(options)), label).toBe(false);
    },
  );
});

describe("release package selection", () => {
  it("should include all public SDK packages in dependency order and exclude private workspaces", async () => {
    const packages = await readReleasePackages();

    expect(packages.map((entry) => entry.name)).toEqual([
      "@drizzle-run/core",
      "@drizzle-run/runtime",
      "@drizzle-run/orchestration",
      "@drizzle-run/react",
      "@drizzle-run/connect",
    ]);

    for (const [index, entry] of packages.entries()) {
      const directory = entry.name.replace("@drizzle-run/", "");
      const manifest = JSON.parse(
        readFileSync(new URL(`../../../packages/${directory}/package.json`, import.meta.url), "utf8"),
      );

      const workspaceDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
        name.startsWith("@drizzle-run/"),
      );

      for (const name of workspaceDependencies) {
        expect(packages.slice(0, index).some((dependency) => dependency.name === name)).toBe(true);
      }
    }
  });

  it("should resume a partial release by selecting only missing versions in dependency order", async () => {
    const packages = await readReleasePackages();
    const selected = await findUnpublishedPackages({
      packages,
      fetchVersion: async (url: string) =>
        new Response(null, {
          status: url.includes(encodeURIComponent("@drizzle-run/core")) ? 200 : 404,
        }),
    });

    expect(selected).toEqual(packages.slice(1));
  });

  it("should skip publication when every exact version exists", async () => {
    expect(
      await findUnpublishedPackages({
        packages: await readReleasePackages(),
        fetchVersion: async () => new Response(null, { status: 200 }),
      }),
    ).toEqual([]);
  });

  it.each([401, 429, 500])("should stop on registry HTTP %s instead of republishing", async (status) => {
    await expect(
      findUnpublishedPackages({
        packages: await readReleasePackages(),
        fetchVersion: async () => new Response(null, { status }),
      }),
    ).rejects.toThrow(`registry HTTP ${status}`);
  });

  it("should stop on a network failure instead of republishing", async () => {
    await expect(
      findUnpublishedPackages({
        packages: await readReleasePackages(),
        fetchVersion: async () => {
          throw new Error("DNS lookup failed");
        },
      }),
    ).rejects.toThrow("DNS lookup failed");
  });
});
