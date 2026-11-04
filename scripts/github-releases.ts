import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releasePackageDirectories } from "./pack-release.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Extract one version's Changesets notes, preserving its Markdown headings. */
export function getReleaseNotes(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${version}`);

  if (start === -1) {
    throw new Error(`Changelog has no notes for version ${version}`);
  }

  const nextVersion = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines
    .slice(start + 1, nextVersion === -1 ? undefined : nextVersion)
    .join("\n")
    .trim();

  if (!notes) {
    throw new Error(`Changelog notes for version ${version} are empty`);
  }

  return notes;
}

/** Create a version's release once; only a missing release permits creation. */
export async function createGithubRelease({
  repository,
  token,
  sha,
  tag,
  prerelease,
  latest,
  readNotes,
  fetchRelease = fetch,
}: {
  repository: string;
  token: string;
  sha: string;
  tag: string;
  prerelease: boolean;
  latest: boolean;
  readNotes: () => Promise<string>;
  fetchRelease?: typeof fetch;
}): Promise<void> {
  const endpoint = `https://api.github.com/repos/${repository}/releases`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const existing = await fetchRelease(`${endpoint}/tags/${encodeURIComponent(tag)}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  await existing.body?.cancel();

  if (existing.status === 200) {
    console.log(`GitHub Release ${tag} already exists.`);

    return;
  }

  if (existing.status !== 404) {
    throw new Error(`Cannot check GitHub Release ${tag}: HTTP ${existing.status}`);
  }

  const response = await fetchRelease(endpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: sha,
      name: tag,
      body: await readNotes(),
      prerelease,
      make_latest: latest && !prerelease ? "true" : "false",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();

  if (response.status !== 201) {
    throw new Error(`Cannot create GitHub Release ${tag}: HTTP ${response.status}`);
  }

  console.log(`Created GitHub Release ${tag}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, GITHUB_SHA: sha } = process.env;

  if ((mode !== "packages" && mode !== "app") || !repository || !token || !sha) {
    throw new Error(
      "Usage: node scripts/github-releases.ts <packages|app> with GITHUB_REPOSITORY, GH_TOKEN and GITHUB_SHA",
    );
  }

  const directories =
    mode === "app" ? ["apps/drizzle-run"] : releasePackageDirectories.map((directory) => `packages/${directory}`);

  for (const directory of directories) {
    const folder = join(repositoryRoot, directory);
    const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));

    if (mode === "packages" && (manifest.private || manifest.publishConfig?.access !== "public")) {
      throw new Error(`Release package ${manifest.name} must allow public publication`);
    }

    await createGithubRelease({
      repository,
      token,
      sha,
      tag: `${mode === "app" ? "drizzle-run-app" : manifest.name}@${manifest.version}`,
      prerelease: manifest.version.includes("-"),
      latest: mode === "app",
      readNotes: async () => getReleaseNotes(await readFile(join(folder, "CHANGELOG.md"), "utf8"), manifest.version),
    });
  }
}
