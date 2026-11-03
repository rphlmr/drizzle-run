import { ChevronUpIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import type { ProjectSyncState } from "./cloud-cycle";
import { cloudMoveBlockLabels, cloudProjectStateLabels } from "./cloud-labels";
import type { CloudSync } from "./cloud-sync";
import { useOptionalCloudSync } from "./cloud-sync-provider";
import { isCloudSyncActive } from "./cloud-usage";
import { isSyncableProjectId } from "./contract";
import { getProjectLocation, LocationIcon, projectLocationActions, projectLocationLabels } from "./project-location";

const toneClass = { ok: "bg-ok", busy: "bg-faint", warn: "bg-warn" } as const;

type CloudProjectState = keyof typeof cloudProjectStateLabels;

function getCloudProjectState(state: ProjectSyncState | undefined): CloudProjectState {
  return state === undefined || state === "local" || state === "unsyncable" ? "pending" : state;
}

function getCloudTone(state: CloudProjectState): keyof typeof toneClass {
  if (state === "synced") {
    return "ok";
  }

  return state === "pending" ? "busy" : "warn";
}

export interface ProjectSyncStatusProps {
  project: { id: string; name: string };
  /** The local save state's words, such as "Saved in this browser". */
  saveLabel: string;
  /** Whether the local save is done; until then the status bar says how the save goes. */
  saved: boolean;
  /** The workspace's Duplicate, which a Cloud project offers to keep a Local copy; none on a read-only page. */
  onDuplicate?: () => void;
}

/**
 * The status bar's save state, and where the project is kept while signed in
 *
 * Signed out, or for a project Cloud cannot take, it is the save state's words alone.
 */
export function ProjectSyncStatus({ project, saveLabel, saved, onDuplicate }: ProjectSyncStatusProps) {
  const cloudSync = useOptionalCloudSync();

  if (cloudSync === null || !isCloudSyncActive(cloudSync) || !isSyncableProjectId(project.id)) {
    return <output>{saveLabel}</output>;
  }

  return (
    <ProjectSyncPopover
      cloudSync={cloudSync}
      project={project}
      saveLabel={saveLabel}
      saved={saved}
      onDuplicate={onDuplicate}
    />
  );
}

function ProjectSyncPopover({
  cloudSync,
  project,
  saveLabel,
  saved,
  onDuplicate,
}: ProjectSyncStatusProps & { cloudSync: CloudSync }) {
  const titleId = useId();
  const location = getProjectLocation(cloudSync, project.id);
  const inCloud = location === "cloud";
  const block = inCloud ? null : cloudSync.getMoveBlock(project.id);
  const state = getCloudProjectState(cloudSync.getProjectState(project.id));
  const label = saved ? projectLocationLabels[location].name : saveLabel;
  const reason =
    state === "failed" ? cloudSync.failures.find((failure) => failure.id === project.id)?.message : undefined;
  const description = inCloud
    ? (reason ?? cloudProjectStateLabels[state])
    : block === null
      ? null
      : cloudMoveBlockLabels[block];
  const action = projectLocationActions[location];
  const canAct = !inCloud || onDuplicate !== undefined;

  return (
    <Popover>
      <PopoverTrigger
        render={<button type="button" aria-label={`${label}. Where this project is kept`} />}
        className="relative inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-muted after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:text-text data-popup-open:text-text"
      >
        {inCloud && (
          <span className={cn("size-1.75 rounded-full", toneClass[getCloudTone(state)])} aria-hidden="true" />
        )}
        {label}
        <ChevronUpIcon className="size-3" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="flex w-[min(300px,calc(100vw-24px))] flex-col gap-2 rounded-[12px] border-[1.5px] border-card-border p-3 text-[13px] shadow-[var(--shadow-sticker-card),var(--shadow-pop)]"
      >
        <PopoverTitle id={titleId} className="flex items-center gap-1.5 text-[13.5px] font-[650]">
          <LocationIcon location={location} />
          Kept in {projectLocationLabels[location].name}
        </PopoverTitle>
        <p className="m-0 text-[12.5px] text-muted">{projectLocationLabels[location].hint}</p>
        {description !== null && <p className="m-0 text-[12.5px] text-muted">{description}</p>}
        {canAct && (
          <PopoverClose
            render={
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={block !== null}
                onClick={inCloud ? onDuplicate : () => cloudSync.moveToCloud(project.id)}
              />
            }
          >
            {action.name}
          </PopoverClose>
        )}
      </PopoverContent>
    </Popover>
  );
}
