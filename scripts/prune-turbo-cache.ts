// Keep only the Turborepo cache entries this job's runs used: `node scripts/prune-turbo-cache.ts`.
//
// CI restores .turbo/cache from the latest saved cache and saves it again after the checks. Without this, every save
// would also carry every entry it restored, and the cache would grow with each commit. The run summaries in
// .turbo/runs (written when TURBO_RUN_SUMMARY=true) list the hash of every task the job ran or replayed; the other
// entries belong to older inputs and are dropped.
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(rootDir, ".turbo/cache");
const runsDir = join(rootDir, ".turbo/runs");

/** Read the task hashes every run summary in .turbo/runs lists. Throws when there is none, so nothing is pruned blind. */
async function readUsedTaskHashes() {
  const summaryNames = (await readdir(runsDir).catch(() => [])).filter((name) => name.endsWith(".json"));

  if (summaryNames.length === 0) {
    throw new Error(`No Turborepo run summary in ${runsDir}; run turbo with TURBO_RUN_SUMMARY=true before pruning`);
  }

  const hashes = new Set();

  for (const name of summaryNames) {
    const summary = JSON.parse(await readFile(join(runsDir, name), "utf8"));

    for (const task of summary.tasks) {
      hashes.add(task.hash);
    }
  }

  return hashes;
}

const usedHashes = await readUsedTaskHashes();
const entryNames = await readdir(cacheDir).catch(() => []);
const keptHashes = new Set();
let removedCount = 0;

// Each entry is `<hash>.tar.zst` with `<hash>-meta.json` and `<hash>-manifest.json` beside it.
for (const name of entryNames) {
  const hash = name.split(/[-.]/)[0];

  if (usedHashes.has(hash)) {
    keptHashes.add(hash);
    continue;
  }

  await rm(join(cacheDir, name), { recursive: true, force: true });
  removedCount += 1;
}

console.log(`Turborepo cache: kept ${keptHashes.size} task entries, removed ${removedCount} files of older ones.`);
