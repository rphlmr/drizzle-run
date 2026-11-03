import { ChevronDownIcon, CloudIcon, CopyIcon, MonitorIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cloudMoveBlockLabels } from "./cloud-labels";
import type { CloudSync } from "./cloud-sync";

/** Where a project is kept: in the signed-in account, or in this browser only. */
export type ProjectLocation = "cloud" | "local";

/** The words of each location, where a project shows it. */
export const projectLocationLabels = {
  cloud: { name: "Cloud", hint: "In your account, on every browser you sign in to" },
  local: { name: "Local", hint: "This browser only" },
} as const satisfies Record<ProjectLocation, { name: string; hint: string }>;

/** The one move each location offers: a Local project moves to Cloud, a Cloud project is duplicated as Local. */
export const projectLocationActions = {
  local: { name: "Move to Cloud", hint: "Keep it in your account, on every browser you sign in to" },
  cloud: { name: "Duplicate as Local", hint: "A copy in this browser only. This one stays in Cloud." },
} as const satisfies Record<ProjectLocation, { name: string; hint: string }>;

/** Where the project is kept, counting a move not yet synced. */
export function getProjectLocation(cloudSync: CloudSync, projectId: string): ProjectLocation {
  return cloudSync.isCloudProject(projectId) ? "cloud" : "local";
}

export function LocationIcon({ location }: { location: ProjectLocation }) {
  return location === "cloud" ? (
    <CloudIcon className="size-3.5" aria-hidden="true" />
  ) : (
    <MonitorIcon className="size-3.5" aria-hidden="true" />
  );
}

/** Props of the location controls: the project, cloud sync, and the workspace's Duplicate. */
export interface ProjectLocationProps {
  project: { id: string; name: string };
  cloudSync: CloudSync;
  onDuplicate: () => void;
}

/** The location of a project in My projects, and the menu with its move. */
export function ProjectLocationMenu({ project, cloudSync, onDuplicate }: ProjectLocationProps) {
  const location = getProjectLocation(cloudSync, project.id);
  const block = location === "local" ? cloudSync.getMoveBlock(project.id) : null;
  const action = projectLocationActions[location];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="relative -ml-2 gap-1.5 px-2 after:absolute after:-inset-y-1"
            aria-label={`${project.name} is kept in ${projectLocationLabels[location].name}`}
          />
        }
      >
        <LocationIcon location={location} />
        {projectLocationLabels[location].name}
        <ChevronDownIcon className="size-3 text-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        <DropdownMenuItem
          disabled={block !== null}
          onClick={location === "cloud" ? onDuplicate : () => cloudSync.moveToCloud(project.id)}
        >
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              {location === "local" ? (
                <CloudIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <CopyIcon className="size-3.5" aria-hidden="true" />
              )}
              {action.name}
            </span>
            <span className="text-[12px] text-muted">{block === null ? action.hint : cloudMoveBlockLabels[block]}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
