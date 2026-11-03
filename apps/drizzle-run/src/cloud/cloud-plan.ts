import type { ProjectRecord } from "../project/projects";
import type { CloudSyncState } from "../store/storage";
import type { CloudProjectSummary } from "./contract";

/** A local project as the planner compares it. */
export interface LocalCloudProject {
  project: ProjectRecord;
  digest: string;
  byteSize: number;
}

/** One thing a sync cycle does, in the order the plan lists them. */
export type CloudSyncStep =
  /** Only this browser's row changes: the cloud already holds this content. */
  | { kind: "record"; id: string; state: CloudSyncState }
  /** This browser's row goes, and the project is Local here. */
  | { kind: "forget"; id: string }
  /** Take the cloud copy: a Cloud project from another browser, or a newer revision of an unchanged local one. */
  | { kind: "download"; id: string; replace: boolean }
  /** Removed from the account elsewhere and unchanged here: the project leaves this browser too. */
  | { kind: "discard"; id: string }
  /**
   * Both sides changed: the cloud's version is added here as a new Cloud project, then this browser's saves over it.
   * `revision` and `digest` name the cloud copy the plan saw.
   */
  | { kind: "copy"; id: string; revision: number; digest: string }
  /**
   * Remove the cloud copy at `revision` whose content `digest` names: the project was deleted here.
   * A copy saved again elsewhere since is another copy, and stays.
   */
  | { kind: "remove"; id: string; revision: number; digest: string }
  /** Save the local project after `baseRevision`, the cloud copy whose content `baseDigest` names (none for a new one). */
  | { kind: "push"; id: string; baseRevision: number; baseDigest?: string }
  /** Larger than the per-project limit: it waits here until it is smaller. */
  | { kind: "too_large"; id: string };

/** What the planner compares. */
export interface CloudPlanInput {
  local: readonly LocalCloudProject[];
  cloud: readonly CloudProjectSummary[];
  /** This browser's rows for the account: a project is Cloud exactly when it has one. */
  rows: readonly CloudSyncState[];
  /**
   * Projects this browser keeps but cannot open, such as one on a removed pair: missing from `local`, they are not
   * deleted here, so they are left as they are until they open again.
   */
  unopenable: ReadonlySet<string>;
  maxProjectBytes: number;
}

/** A sync plan: the steps to run. */
export interface CloudPlan {
  steps: CloudSyncStep[];
}

const stepOrder: Record<CloudSyncStep["kind"], number> = {
  record: 0,
  forget: 1,
  download: 2,
  discard: 3,
  remove: 4,
  too_large: 5,
  copy: 6,
  push: 7,
};

/**
 * Plan a sync cycle
 *
 * Compares every project this browser or the account knows. A project without a row is Local and never planned. When
 * both sides changed, nothing is replaced: the cloud's version becomes a new project and this browser's saves over
 * the original. Saves go newest first, so a limit keeps the recent ones.
 */
export function planCloudSync(input: CloudPlanInput): CloudPlan {
  const local = new Map(input.local.map((item) => [item.project.id, item]));
  const cloud = new Map(input.cloud.map((entry) => [entry.id, entry]));
  const rows = new Map(input.rows.map((row) => [row.projectId, row]));
  const ids = new Set([...local.keys(), ...cloud.keys(), ...rows.keys()]);
  const steps: CloudSyncStep[] = [];
  const pushes: { id: string; baseRevision: number; baseDigest?: string; updatedAt: string }[] = [];

  for (const id of ids) {
    if (input.unopenable.has(id)) {
      continue;
    }

    const mine = local.get(id);
    const theirs = cloud.get(id);
    const row = rows.get(id);

    // Gone here
    if (mine === undefined) {
      if (theirs === undefined) {
        if (row !== undefined) {
          steps.push({ kind: "forget", id });
        }
      } else if (row !== undefined && row.revision === theirs.revision && row.digest === theirs.digest) {
        steps.push({ kind: "remove", id, revision: theirs.revision, digest: theirs.digest });
      } else {
        steps.push({ kind: "download", id, replace: false });
      }

      continue;
    }

    if (row === undefined) {
      continue;
    }

    // Gone from the account
    if (theirs === undefined) {
      if (row.revision > 0) {
        steps.push(mine.digest === row.digest ? { kind: "discard", id } : { kind: "forget", id });
        continue;
      }

      if (mine.byteSize > input.maxProjectBytes) {
        steps.push({ kind: "too_large", id });
        continue;
      }

      pushes.push({ id, baseRevision: 0, updatedAt: mine.project.updatedAt });
      continue;
    }

    // On both sides
    if (mine.digest === theirs.digest) {
      if (row.revision !== theirs.revision || row.digest !== theirs.digest) {
        steps.push({
          kind: "record",
          id,
          state: { projectId: id, revision: theirs.revision, digest: theirs.digest },
        });
      }

      continue;
    }

    const changedHere = mine.digest !== row.digest;
    // Compare the digest too: a project removed and saved again elsewhere starts over at the same revision.
    const changedThere = theirs.revision !== row.revision || theirs.digest !== row.digest;

    if (changedThere && !changedHere) {
      steps.push({ kind: "download", id, replace: true });
      continue;
    }

    if (mine.byteSize > input.maxProjectBytes) {
      steps.push({ kind: "too_large", id });
      continue;
    }

    if (changedThere) {
      steps.push({ kind: "copy", id, revision: theirs.revision, digest: theirs.digest });
      continue;
    }

    pushes.push({ id, baseRevision: theirs.revision, baseDigest: theirs.digest, updatedAt: mine.project.updatedAt });
  }

  // Saves, newest first
  for (const push of pushes.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    steps.push({
      kind: "push",
      id: push.id,
      baseRevision: push.baseRevision,
      ...(push.baseDigest === undefined ? {} : { baseDigest: push.baseDigest }),
    });
  }

  return { steps: steps.toSorted((a, b) => stepOrder[a.kind] - stepOrder[b.kind]) };
}
