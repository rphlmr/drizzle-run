import type { RunController } from "@drizzle-run/orchestration";
import { useEffect, useMemo, useState } from "react";

import type { ProjectRecord } from "../project/projects";
import type { ShareStartView } from "../share/publish-machine";
import { ShareDialog } from "../share/share-dialog";
import { getShareStatus, resolveProjectDigest } from "../share/share-status";
import type { ShareLinkRecord, ShareLinkStore } from "../store/storage";
import { Toast } from "../ui/toast";

const PUSHED_TOAST_MS = 5_000;

/** Options of `useShareDialog`. */
export interface UseShareDialogOptions {
  project: ProjectRecord;
  links: ShareLinkStore;
  /** The project's run machine, or each side's in side order: their latest runs may go with the share. */
  executions: readonly RunController[];
}

/**
 * The Share dialog of a project view
 *
 * Returns its openers, for the header's Share button and the phone menu, the project's share status, and the dialog to
 * render once in the view. The dialog reads each run machine's latest run as it opens. The status reads the share link
 * this browser keeps, follows each change the dialog saves, reads it again when the dialog closes, and compares it
 * with the project as it is edited. A finished push closes the dialog and shows a toast instead.
 */
export function useShareDialog({ project, links, executions }: UseShareDialogOptions) {
  const [startView, setStartView] = useState<ShareStartView | undefined>(undefined);
  const [pushedToastShown, setPushedToastShown] = useState(false);
  const [stored, setStored] = useState<{ projectId: string; record: ShareLinkRecord | undefined }>();
  const projectDigest = useMemo(() => resolveProjectDigest(project), [project]);

  useEffect(() => {
    let active = true;

    readShareLink(links, project.id, (record) => {
      if (active) {
        setStored({ projectId: project.id, record });
      }
    });

    return () => {
      active = false;
    };
  }, [links, project.id]);

  useEffect(() => {
    if (!pushedToastShown) {
      return;
    }

    const timer = setTimeout(() => setPushedToastShown(false), PUSHED_TOAST_MS);

    return () => clearTimeout(timer);
  }, [pushedToastShown]);

  const record = stored?.projectId === project.id ? stored.record : undefined;
  const closeDialog = () => {
    setStartView(undefined);
    readShareLink(links, project.id, (latest) => setStored({ projectId: project.id, record: latest }));
  };
  const dialog = startView !== undefined && (
    <ShareDialog
      project={project}
      links={links}
      startView={startView}
      latestRuns={executions.map((execution) => execution.getState().history.at(-1))}
      onLinkChange={(latest) => setStored({ projectId: project.id, record: latest })}
      onPushed={() => {
        closeDialog();
        setPushedToastShown(true);
      }}
      onClose={closeDialog}
    />
  );
  const shareDialog = (
    <>
      {dialog}
      {pushedToastShown && (
        <Toast onDismiss={() => setPushedToastShown(false)}>Share updated. The link shows your latest code.</Toast>
      )}
    </>
  );

  return {
    openShare: () => setStartView("link"),
    openPush: () => setStartView("push"),
    shareStatus: getShareStatus(record, projectDigest),
    shareDialog,
  };
}

function readShareLink(
  links: ShareLinkStore,
  projectId: string,
  onRead: (record: ShareLinkRecord | undefined) => void,
) {
  links
    .shareLink(projectId)
    .then(onRead)
    .catch((cause: unknown) => {
      console.error("Reading the project's share link failed", cause);
    });
}
