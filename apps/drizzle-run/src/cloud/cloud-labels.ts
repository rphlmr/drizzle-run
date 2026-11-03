import type { ProjectSyncState } from "./cloud-cycle";
import type { CloudMoveBlock, CloudSyncStatus } from "./cloud-sync";

/** Said wherever Cloud is offered or explained. */
export const CLOUD_FREE_NOTE = "Cloud is free, so please don't abuse it.";

/** What happens past a limit, and how to make room. */
export const CLOUD_LIMIT_NOTE =
  "Past a limit, your work stays in this browser and waits until there's room. Make a project Local to free space.";

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function countProjects(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"}`;
}

/** What the status words count besides the status itself. */
export interface CloudStatusDetails {
  /** Projects the last cycle could not save. */
  failedProjects?: number;
  /** When a save held back by the save interval goes, in epoch milliseconds; undefined when none waits. */
  heldUntilMs?: number;
  /** The time now, in epoch milliseconds: a held save whose time has passed waits only for the next cycle. */
  nowMs?: number;
}

/**
 * Status words and their dot, for the usage strip and Settings
 *
 * Failed projects or a held-back save say so, in that order, so neither shows by its dot alone: a held save reads
 * "Saved here, sending to Cloud at 2:32 PM", since other browsers still have the older copy, and "Saved here, sending
 * to Cloud soon" once that time has passed, as when a hidden tab's timer runs late.
 */
export function getCloudStatusLabel(
  status: CloudSyncStatus,
  { failedProjects = 0, heldUntilMs, nowMs = Date.now() }: CloudStatusDetails = {},
): { label: string; tone: "ok" | "busy" | "warn" } {
  switch (status) {
    case "synced":
      if (failedProjects > 0) {
        return { label: `${countProjects(failedProjects)} not saved`, tone: "warn" };
      }

      if (heldUntilMs !== undefined) {
        const when = heldUntilMs > nowMs ? `at ${formatClockTime(heldUntilMs)}` : "soon";

        return { label: `Saved here, sending to Cloud ${when}`, tone: "busy" };
      }

      return { label: "Up to date", tone: "ok" };
    case "offline":
      return { label: "Offline, retrying", tone: "warn" };
    case "syncing":
      return { label: "Updating…", tone: "busy" };
    case "signedOut":
    case "unavailable":
      return { label: "Off", tone: "busy" };
  }
}

/** Why a Local project cannot move to Cloud, in the words beside its location. */
export const cloudMoveBlockLabels = {
  too_large: "Over 1 MB, so it can't move to Cloud.",
  account_full: "Your Cloud is full. Make a project Local to free space.",
} as const satisfies Record<CloudMoveBlock, string>;

/** How a Cloud project stands, in the words of the status bar's popover; an up-to-date one needs none. */
export const cloudProjectStateLabels = {
  synced: null,
  pending: "Saved here, sending to Cloud soon.",
  too_large: "Over 1 MB: it waits here until it's smaller.",
  limit: "No room in your Cloud: it waits here.",
  failed: "Not saved to Cloud yet. Trying again.",
} as const satisfies Record<Exclude<ProjectSyncState, "local" | "unsyncable">, string | null>;
