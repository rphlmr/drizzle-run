import type { CloudConflictCopy, CloudProjectFailure, ProjectSyncState } from "./cloud-cycle";

/** Where cloud sync stands, in the words the UI uses. */
export type CloudSyncStatus = "signedOut" | "unavailable" | "syncing" | "synced" | "offline";

/**
 * Where a sign-out stands: asking, saving the last edits, waiting on edits that did not reach the account, or signing
 * out
 *
 * `cloudCount` and `localCount` are the projects that leave this browser and the ones that stay. `unsavedCount` is the
 * Cloud projects whose latest edits the account lacks; `error` says why the save failed, empty when it ran.
 */
export type CloudLeave =
  | { step: "asking"; cloudCount: number; localCount: number }
  | { step: "saving" }
  | { step: "unsaved"; unsavedCount: number; error: string }
  | { step: "signing_out" };

/** Why a Local project cannot move to Cloud right now. */
export type CloudMoveBlock = "too_large" | "account_full";

/** Cloud sync as the pages see it. */
export interface CloudSync {
  status: CloudSyncStatus;
  /** Usage against the limits; null until the first cycle answers. */
  usage: { bytes: number; maxBytes: number; projects: number; maxProjects: number; maxProjectBytes: number } | null;
  /** Projects the last cycle could not sync; the others synced. */
  failures: readonly CloudProjectFailure[];
  /** The other machine's versions added as new projects, until dismissed. */
  copies: readonly CloudConflictCopy[];
  dismissCopies: () => void;
  /** When a save held back by the save interval goes, in epoch milliseconds; undefined when none waits. */
  heldUntilMs: number | undefined;
  /** Why sync stopped (offline, unavailable, signed in elsewhere); empty while it runs. */
  error: string;
  /** How a project stands; undefined before the first cycle reached it. */
  getProjectState: (projectId: string) => ProjectSyncState | undefined;
  /** Whether the project is Cloud, counting a move not yet synced. */
  isCloudProject: (projectId: string) => boolean;
  /** Why the project cannot move to Cloud; null when it can, or is Cloud already. */
  getMoveBlock: (projectId: string) => CloudMoveBlock | null;
  /** Moves a project to Cloud: it uploads with the next cycle. A Cloud project stays Cloud. */
  moveToCloud: (projectId: string) => void;
  /** The sign-out in progress; null when none. */
  leave: CloudLeave | null;
  /** Asks, then saves the last edits, takes every Cloud project out of this browser, and signs out. */
  signOut: () => void;
  /** Goes on with the sign-out the dialog shows; after a failed save, signs out and loses the unsaved edits. */
  confirmSignOut: () => void;
  /** Saves again after a failed save. */
  retrySignOut: () => void;
  cancelSignOut: () => void;
  /** The Settings dialog, opened from the account menu or the usage strip's Details. */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}
