import { type BucketTarget, runR2ObjectCommand, withBucketBinding } from "./runtime-asset-bucket.ts";
import type { DeploymentRecord, StoredObject } from "./runtime-asset-deployments.ts";
import { deploymentRecordPrefix, parseDeploymentRecord, planRuntimeAssetPrune } from "./runtime-asset-deployments.ts";

/**
 * Lists every object in the bucket and reads every deployment record, through one R2 binding.
 */
async function readBucketState({ bucket, storage }: BucketTarget) {
  return withBucketBinding({ bucket, storage }, async (bucketBinding) => {
    const objects: StoredObject[] = [];
    let cursor: string | undefined;

    do {
      const page = await bucketBinding.list({ cursor, limit: 1000 });

      objects.push(...page.objects.map(({ key, size, uploaded }) => ({ key, size, uploaded })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);

    const recordObjects = objects.filter((object) => object.key.startsWith(deploymentRecordPrefix));
    const records = await Promise.all(
      recordObjects.map(async ({ key }) => {
        const stored = await bucketBinding.get(key);

        if (stored === null) {
          throw new Error(`Deployment record ${key} was listed but could not be read`);
        }

        return parseDeploymentRecord(key, await stored.text());
      }),
    );

    return { objects, records };
  });
}

function formatBytes(bytes: number) {
  return `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(1)} MiB)`;
}

function describeRecord(record: DeploymentRecord) {
  const preview = record.preview === undefined ? "" : `  preview ${record.preview}`;

  return `${record.key}${preview}  commit ${record.gitCommit}  uploaded ${record.uploadedAt.toISOString()}  ${record.assetKeys.length} assets`;
}

/**
 * Prune runtime assets from R2
 *
 * Deletes the runtime assets that neither the current inventory, the newest `keepDeployments` deployment records, nor
 * the newest record of each open preview reference, then the other records themselves, with `wrangler r2 object delete`. The plan is printed first; a dry run
 * stops there. Deletion refuses to start while the bucket holds fewer records than the keep window.
 *
 * @param options.currentAssetKeys - The R2 keys of the inventory this checkout builds
 * @param options.bucket - The R2 bucket name
 * @param options.storage - `{ kind: "local", stateDir }` or `{ kind: "remote", accountId }`
 * @param options.keepDeployments - How many of the newest deployment records keep their assets
 * @param options.openPreviews - The previews whose pull requests are open: each keeps its newest record
 * @param options.mode - `"dry_run"` prints the plan, `"delete"` also deletes
 * @param options.log - Receives one line per step
 * @param options.now - When the prune runs, by default now; assets stored in the day before it are kept
 * @returns The plan, and the keys deleted (none in a dry run)
 */
export async function pruneRuntimeAssets({
  currentAssetKeys,
  bucket,
  storage,
  keepDeployments,
  openPreviews = [],
  mode,
  log,
  now = new Date(),
}: BucketTarget & {
  currentAssetKeys: readonly string[];
  keepDeployments: number;
  openPreviews?: string[];
  mode: "dry_run" | "delete";
  log: (line: string) => void;
  now?: Date;
}) {
  const { objects, records } = await readBucketState({ bucket, storage });
  const plan = planRuntimeAssetPrune({ objects, records, currentAssetKeys, keepDeployments, openPreviews, now });
  const staleRecordKeys = new Set(plan.staleRecords.map((record) => record.key));
  const staleRecordObjects = objects.filter((object) => staleRecordKeys.has(object.key));
  const deletions = [...plan.deletableObjects, ...staleRecordObjects];

  // Print the plan
  const openPreviewNote =
    openPreviews.length === 0 ? "" : ` and the newest of each open preview (${openPreviews.join(", ")})`;

  log(`Deployment records: ${records.length}, keeping the newest ${keepDeployments}${openPreviewNote}`);

  for (const record of plan.keptRecords) {
    log(`  keep    ${describeRecord(record)}`);
  }

  for (const record of plan.staleRecords) {
    log(`  delete  ${describeRecord(record)}`);
  }

  for (const object of plan.recentObjects) {
    log(`Keeping ${object.key}: stored after the latest deployment record or in the last day`);
  }

  for (const object of plan.unmanagedObjects) {
    log(`Leaving ${object.key}: not a runtime asset or deployment record`);
  }

  log(
    `Objects to delete: ${deletions.length}, ${formatBytes(deletions.reduce((total, object) => total + object.size, 0))}`,
  );

  for (const object of deletions) {
    log(`  ${object.key}  ${object.size} bytes`);
  }

  if (plan.recordShortfall > 0) {
    log(
      `Only ${records.length} deployment records for a keep window of ${keepDeployments}: ` +
        "deletion waits until more deployments are uploaded, since older live assets have no record.",
    );
  }

  if (mode === "dry_run") {
    log("Dry run: nothing deleted. Run again with --delete to delete these objects.");

    return { plan, deletedKeys: [] };
  }

  if (plan.recordShortfall > 0) {
    log("Nothing deleted.");

    return { plan, deletedKeys: [] };
  }

  // Delete assets before the records that describe them
  const deletedKeys = [];

  for (const object of deletions) {
    await runR2ObjectCommand({ command: "delete", objectPath: `${bucket}/${object.key}`, storage });
    deletedKeys.push(object.key);
    log(`Deleted ${object.key}`);
  }

  return { plan, deletedKeys };
}
