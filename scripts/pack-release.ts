import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

interface ReleasePackage {
  name: string;
  version: string;
  directory: string;
}

// Tarball directories keep dependencies ahead of their consumers in the publish job.
export const releasePackageDirectories = ["core", "runtime", "orchestration", "react", "connect"];

/** Read the packages released together; app and testing workspaces remain private. */
export async function readReleasePackages(): Promise<ReleasePackage[]> {
  return Promise.all(
    releasePackageDirectories.map(async (directory, index) => {
      const manifest = JSON.parse(await readFile(join(repositoryRoot, "packages", directory, "package.json"), "utf8"));

      if (manifest.private || manifest.publishConfig?.access !== "public") {
        throw new Error(`Release package ${manifest.name} must allow public publication`);
      }

      return { name: manifest.name, version: manifest.version, directory: `${index}-${directory}` };
    }),
  );
}

/** Select missing exact versions. Registry failures must not be treated as permission to republish. */
export async function findUnpublishedPackages({
  packages,
  fetchVersion = fetch,
}: {
  packages: ReleasePackage[];
  fetchVersion?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const checks = await Promise.all(
    packages.map(async (entry) => {
      const response = await fetchVersion(
        `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      await response.body?.cancel();

      if (response.status === 404) {
        return entry;
      }

      if (response.status !== 200) {
        throw new Error(`Cannot check ${entry.name}@${entry.version}: registry HTTP ${response.status}`);
      }

      return null;
    }),
  );

  return checks.filter((entry) => entry !== null);
}

/** Pack built packages with pnpm so workspace dependencies become published version references. Never publishes. */
export async function packReleasePackages({
  packages,
  destination,
}: {
  packages: ReleasePackage[];
  destination: string;
}) {
  for (const entry of packages) {
    const packageDestination = resolve(destination, entry.directory);
    await mkdir(packageDestination, { recursive: true });
    execFileSync("pnpm", ["--filter", entry.name, "pack", "--pack-destination", packageDestination], {
      cwd: repositoryRoot,
      stdio: "inherit",
      timeout: 120_000,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];

  if (!destination) {
    throw new Error("Usage: node scripts/pack-release.ts <tarball-directory>");
  }

  const packages = await findUnpublishedPackages({ packages: await readReleasePackages() });
  await packReleasePackages({ packages, destination });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `unpublished=${packages.length > 0}\n`);
  }

  console.log(`Packed ${packages.length} unpublished package versions. Nothing was published.`);
}
