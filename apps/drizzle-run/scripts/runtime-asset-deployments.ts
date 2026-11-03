import { createHash } from "node:crypto";

/** A bucket object's metadata used to plan retention. */
export interface StoredObject {
  key: string;
  size: number;
  uploaded: Date;
}

/** A deployment record with a parsed upload timestamp. */
export interface DeploymentRecord {
  key: string;
  preview?: string;
  gitCommit: string;
  uploadedAt: Date;
  assetKeys: string[];
}

export const deploymentRecordPrefix = "deployments/";

const deploymentRecordVersion = 1;
// Every runtime asset key is `<sha256 digest>/<name>`; nothing else in the bucket is a runtime asset.
const runtimeAssetKeyPattern = /^[0-9a-f]{64}\/.+$/;
// Must match the Worker name manage-deploy-environment.ts gives a pull request preview, such as `pr-12`.
const previewNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
// An upload stores its assets before its record. Another deployment's record may land in between, so an asset this
// young may still belong to an upload whose record is not written yet.
export const recentAssetWindowMs = 24 * 60 * 60 * 1000; // 1 day

// Code-unit order, so the inventory id is the same on every machine and locale.
function compareKeys(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Check a preview name
 *
 * @param name - The preview's name, such as `pr-12`
 * @returns The name
 */
export function assertPreviewName(name: string) {
  if (typeof name !== "string" || !previewNamePattern.test(name)) {
    throw new Error(`Expected a preview name such as pr-12, but got ${JSON.stringify(name)}`);
  }

  return name;
}

/**
 * Parse a comma-separated list of preview names, as `--open-previews` takes it
 *
 * An empty text is an empty list: no pull request is open.
 *
 * @param text - Such as `pr-3,pr-7`
 * @returns The names, each checked
 */
export function parsePreviewNames(text: string) {
  return text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map(assertPreviewName);
}

/**
 * Create a deployment record
 *
 * The key is derived from the sorted asset keys, so uploading the same inventory again (a redeploy or a rollback build)
 * replaces its record with a newer timestamp, and two inventories built from one commit never share a record. A pull
 * request preview's record also carries the preview's name in its key, so previews on one inventory each keep a record
 * of their own and never overwrite one another's.
 *
 * @param options.assetKeys - The inventory's R2 keys
 * @param options.gitCommit - The commit the inventory was built from, for people reading the record
 * @param options.uploadedAt - When the upload finished
 * @param options.preview - The pull request preview it deploys, such as `pr-12`; absent for other deployments
 * @returns The record's R2 key and its JSON body
 */
export function createDeploymentRecord({
  assetKeys,
  gitCommit,
  uploadedAt,
  preview,
}: {
  assetKeys: readonly string[];
  gitCommit: string;
  uploadedAt: Date;
  preview?: string;
}) {
  const sortedKeys = [...new Set(assetKeys)].toSorted(compareKeys);
  const inventoryId = createHash("sha256").update(sortedKeys.join("\n")).digest("hex");
  const record = {
    version: deploymentRecordVersion,
    inventoryId,
    ...(preview === undefined ? {} : { preview: assertPreviewName(preview) }),
    gitCommit,
    uploadedAt: uploadedAt.toISOString(),
    assetKeys: sortedKeys,
  };

  return {
    key: `${deploymentRecordPrefix}${inventoryId}${preview === undefined ? "" : `.${preview}`}.json`,
    body: `${JSON.stringify(record, null, 2)}\n`,
  };
}

/**
 * Parse a stored deployment record
 *
 * Throws on anything that is not a valid record: the prune stops instead of guessing which objects a broken record
 * protects.
 *
 * @param key - The record's R2 key, for the error message
 * @param body - The stored JSON text
 * @returns The record, with `uploadedAt` as a Date, and its `preview` when it has one
 */
export function parseDeploymentRecord(key: string, body: string): DeploymentRecord {
  let record;

  try {
    record = JSON.parse(body);
  } catch (cause) {
    throw new Error(`Deployment record ${key} is not valid JSON`, { cause });
  }

  const uploadedAt = new Date(record?.uploadedAt);

  if (
    record?.version !== deploymentRecordVersion ||
    (record.preview !== undefined && !previewNamePattern.test(String(record.preview))) ||
    typeof record.gitCommit !== "string" ||
    Number.isNaN(uploadedAt.getTime()) ||
    !Array.isArray(record.assetKeys) ||
    !record.assetKeys.every(
      (assetKey: unknown) => typeof assetKey === "string" && runtimeAssetKeyPattern.test(assetKey),
    )
  ) {
    throw new Error(
      `Deployment record ${key} does not match version ${deploymentRecordVersion}: ` +
        "expected gitCommit, an ISO uploadedAt, assetKeys of `<sha256>/<name>`, and an optional preview",
    );
  }

  return {
    key,
    ...(record.preview === undefined ? {} : { preview: record.preview }),
    gitCommit: record.gitCommit,
    uploadedAt,
    assetKeys: record.assetKeys,
  };
}

/**
 * Plan a runtime asset prune
 *
 * Keeps every runtime asset that the newest `keepDeployments` records (by `uploadedAt`) or the current inventory
 * reference, and every object stored after the latest record or within `recentAssetWindowMs` of `now`, which may belong
 * to an upload still running or one that failed before writing its record. Each open preview also keeps its newest record, however old: a preview is not
 * deployed again until its pull request gets a push, so its inventory stays live as long as the pull request is open.
 * Objects outside `<sha256>/` and `deployments/` are never touched. Every other record is deleted with its objects.
 *
 * Deletion must wait while `recordShortfall` is above 0: with fewer records than the keep window, a deployment uploaded
 * before records existed may still be live or one rollback away.
 *
 * @param options.objects - Every object in the bucket: `{ key, size, uploaded }`
 * @param options.records - Every parsed deployment record
 * @param options.currentAssetKeys - The R2 keys of the inventory this checkout builds
 * @param options.keepDeployments - How many of the newest deployment records keep their objects, at least 1
 * @param options.openPreviews - The previews whose pull requests are open, such as `["pr-3", "pr-7"]`
 * @param options.now - When the prune runs, by default now
 * @returns The records and objects kept or deleted
 *
 * @example
 * planRuntimeAssetPrune({ objects, records, currentAssetKeys, keepDeployments: 3 });
 * // { keptRecords, staleRecords, deletableObjects, recentObjects, unmanagedObjects, recordShortfall }
 */
export function planRuntimeAssetPrune({
  objects,
  records,
  currentAssetKeys,
  keepDeployments,
  openPreviews = [],
  now = new Date(),
}: {
  objects: StoredObject[];
  records: DeploymentRecord[];
  currentAssetKeys: readonly string[];
  keepDeployments: number;
  openPreviews?: string[];
  now?: Date;
}) {
  if (!Number.isInteger(keepDeployments) || keepDeployments < 1) {
    throw new Error(`Expected keepDeployments to be a whole number of at least 1, but got ${keepDeployments}`);
  }

  const openPreviewNames = new Set(openPreviews.map(assertPreviewName));

  const recordsByAge = records.toSorted(
    (left, right) => right.uploadedAt.getTime() - left.uploadedAt.getTime() || compareKeys(left.key, right.key),
  );
  const newestRecords = new Set(recordsByAge.slice(0, keepDeployments));
  const openPreviewRecords = new Set(
    [...openPreviewNames].flatMap((preview) => recordsByAge.find((record) => record.preview === preview) ?? []),
  );
  const keptRecords = recordsByAge.filter((record) => newestRecords.has(record) || openPreviewRecords.has(record));
  const staleRecords = recordsByAge.filter((record) => !keptRecords.includes(record));
  const keptAssetKeys = new Set([...currentAssetKeys, ...keptRecords.flatMap((record) => record.assetKeys)]);

  // R2 stamps both the records and the assets, so this compares one clock. Without records it is -Infinity, and every
  // unreferenced asset counts as recent.
  const recordKeys = new Set(records.map((record) => record.key));
  const lastRecordStoredAt = Math.max(
    ...objects.filter((object) => recordKeys.has(object.key)).map((object) => object.uploaded.getTime()),
  );
  const recentSince = Math.min(lastRecordStoredAt, now.getTime() - recentAssetWindowMs);

  const deletableObjects = [];
  const recentObjects = [];
  const unmanagedObjects = [];

  for (const object of objects) {
    if (object.key.startsWith(deploymentRecordPrefix)) {
      continue;
    }

    if (!runtimeAssetKeyPattern.test(object.key)) {
      unmanagedObjects.push(object);
      continue;
    }

    if (keptAssetKeys.has(object.key)) {
      continue;
    }

    if (object.uploaded.getTime() > recentSince) {
      recentObjects.push(object);
      continue;
    }

    deletableObjects.push(object);
  }

  return {
    keptRecords,
    staleRecords,
    deletableObjects,
    recentObjects,
    unmanagedObjects,
    recordShortfall: Math.max(0, keepDeployments - records.length),
  };
}
