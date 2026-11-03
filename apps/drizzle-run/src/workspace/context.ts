import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import type { ReactNode } from "react";
import { useOutletContext } from "react-router";

import type { CloudSync } from "../cloud/cloud-sync";
import type { ProjectRecord } from "../project/projects";
import type { LocalProjectStorage } from "../store/storage";
import type { ProjectArrival } from "./project-arrival";
import type { StoreSaveState } from "./save-state";

/** What the layout route shares with the home, My projects, gallery, example, and project pages. */
export interface WorkspaceContext {
  storage: LocalProjectStorage;
  projects: readonly ProjectRecord[];
  /** The store has not loaded yet, or failed to load. */
  loading: boolean;
  saveState: StoreSaveState;
  /** Sync with the signed-in account; the local store stays the source of truth. */
  cloudSync: CloudSync;
  /** Storage, migration, and action errors shown under the header. */
  banners: ReactNode;
  /** The project switcher for a page header, marking `current` when there is one. */
  renderSwitcher(current?: ProjectRecord): ReactNode;
  /** Saves the project and, unless `open` is false, opens it on the notice its `arrival` calls for. */
  add(project: ProjectRecord, options?: { open?: boolean; arrival?: ProjectArrival }): void;
  update: (project: ProjectRecord) => void;
  reportError: (message: string) => void;
  openCreate: () => void;
  /** Creates a starter project in one step, as the welcome page does. */
  quickCreate(target: RunManifestTarget): void;
  rename(project: ProjectRecord): void;
  duplicate(project: ProjectRecord): void;
  exportProjects(projects: readonly ProjectRecord[], filename?: string): void;
  /** Asks for confirmation, then deletes. */
  remove(projects: readonly ProjectRecord[]): void;
}

/** Reads the workspace the layout route shares; only valid under that route. */
export function useWorkspace(): WorkspaceContext {
  return useOutletContext<WorkspaceContext>();
}
