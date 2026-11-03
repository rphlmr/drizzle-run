import { useActorRef, useSelector } from "@xstate/react";
import { EllipsisIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link, useFetcher, useNavigate, useRevalidator, type ActionFunctionArgs } from "react-router";
import * as z from "zod/mini";

import { appServicesContext, useAppServices } from "../app-services";
import { CommunityShareIdSchema } from "../community/contract";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { getErrorText } from "../lib/error-text";
import { cn } from "../lib/utils";
import { openSharedSnapshot, type ProjectRecord } from "../project/projects";
import { shareDeleteMachine } from "../share/share-delete-machine";
import { StopSharingNote } from "../share/share-dialog";
import { FieldError, FieldNote } from "../ui/field";
import { useWorkspace } from "../workspace/context";
import type { MyShare } from "./contract";
import { toOwnedShareLink } from "./owned-share-link";

/** How long Edit waits for the share's code. */
const EDIT_LOAD_TIMEOUT_MS = 30_000;

type EditState = { status: "idle" } | { status: "opening" } | { status: "failed"; error: string };

/** Opening a share that is not in this browser as a project tied to its link, and how it went. */
export interface ShareEdit {
  state: EditState;
  start: () => void;
}

/**
 * Open a share's code as a new project tied to the link, so it can push changes from any browser
 *
 * A share on a release Drizzle Run no longer ships opens on its own page, which asks for a release first.
 */
export function useShareEdit(share: MyShare): ShareEdit {
  const { playgrounds } = useAppServices();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [state, setState] = useState<EditState>({ status: "idle" });

  const editShare = async () => {
    setState({ status: "opening" });

    try {
      const latest = await playgrounds.getPlaygroundSnapshot({
        id: share.id,
        signal: AbortSignal.timeout(EDIT_LOAD_TIMEOUT_MS),
      });
      const project = openSharedSnapshot(latest);

      if (project === undefined) {
        void navigate(`/s/${share.id}`);

        return;
      }

      await workspace.storage.saveShareLink(project.id, toOwnedShareLink(share.id, latest));
      workspace.add(project, { arrival: { kind: "forked", originalHref: `/s/${share.id}` } });
    } catch (cause) {
      setState({ status: "failed", error: getErrorText(cause) });
    }
  };

  return {
    state,
    start: () => {
      if (state.status !== "opening") {
        void editShare();
      }
    },
  };
}

/** A share's name, which opens its project in this browser, or makes one from the share first. */
export function MyShareName({
  share,
  source,
  edit,
  className,
  children,
}: {
  share: MyShare;
  source: ProjectRecord | undefined;
  edit: ShareEdit;
  className?: string;
  children: ReactNode;
}) {
  if (source !== undefined) {
    return (
      <Link to={`/p/${source.id}`} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={cn("cursor-pointer border-0 bg-transparent p-0 text-left", className)}
      aria-label={share.title}
      disabled={edit.state.status === "opening"}
      onClick={edit.start}
    >
      {children}
    </button>
  );
}

const MyShareActionFormSchema = z.object({ intent: z.literal("unlist"), shareId: CommunityShareIdSchema });

/** What unlisting a share from My shares did. */
export type MyShareActionResult = { status: "unlisted" } | { status: "failed"; error: string };

/**
 * Take one of the account's shares out of Community
 *
 * Proves ownership with the session, so it works from any browser the owner signs in on. The link keeps working.
 */
export async function myShareAction({ request, context }: ActionFunctionArgs): Promise<MyShareActionResult> {
  const form = MyShareActionFormSchema.safeParse(Object.fromEntries(await request.formData()));

  if (!form.success) {
    return { status: "failed", error: "This share cannot be unlisted." };
  }

  try {
    await context.get(appServicesContext).community.unlistShareFromCommunity({
      linkId: form.data.shareId,
      signal: request.signal,
    });
  } catch (cause) {
    return { status: "failed", error: getErrorText(cause) };
  }

  return { status: "unlisted" };
}

/**
 * The actions menu of one share: open or edit its project, open the shared page, Unlist from Community while it is
 * listed, and Stop sharing
 *
 * A share whose project is in this browser opens that project. Otherwise Edit opens the share's code as a new project
 * tied to the link, so it can push changes from any browser.
 * Unlisting runs at once; stopping asks first. Both refresh the list once done.
 */
export function MyShareActions({
  share,
  source,
  edit,
}: {
  share: MyShare;
  source: ProjectRecord | undefined;
  edit: ShareEdit;
}) {
  const navigate = useNavigate();
  const unlist = useFetcher<typeof myShareAction>();
  const [deleting, setDeleting] = useState(false);
  const unlisting = unlist.state !== "idle";
  const opening = edit.state.status === "opening";
  const listed = share.listing?.state === "listed";

  return (
    <span className="flex items-center gap-2">
      {unlist.data?.status === "failed" && !unlisting && (
        <span role="alert" className="text-[13px] text-err">
          {unlist.data.error}
        </span>
      )}
      {edit.state.status === "failed" && (
        <span role="alert" className="text-[13px] text-err">
          {edit.state.error}
        </span>
      )}
      {unlisting && <output className="text-[13px] text-muted">Unlisting…</output>}
      {opening && <output className="text-[13px] text-muted">Opening…</output>}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={unlisting || opening}
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${share.title}`} />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto" finalFocus={() => !deleting}>
          {source === undefined ? (
            <DropdownMenuItem onClick={edit.start}>Edit in My projects</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => void navigate(`/p/${source.id}`)}>Open project</DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void navigate(`/s/${share.id}`)}>Open the shared page</DropdownMenuItem>
          {listed && (
            <DropdownMenuItem
              onClick={() => void unlist.submit({ intent: "unlist", shareId: share.id }, { method: "post" })}
            >
              Unlist from Community
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
            Stop sharing…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {deleting && <DeleteShareDialog share={share} onClose={() => setDeleting(false)} />}
    </span>
  );
}

/**
 * Asks before deleting a share for good, then forgets its link in every local project that still points at it
 *
 * The projects themselves stay. Closes and refreshes the list once the share is gone.
 */
function DeleteShareDialog({ share, onClose }: { share: MyShare; onClose: () => void }) {
  const { playgrounds } = useAppServices();
  const workspace = useWorkspace();
  const revalidator = useRevalidator();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [projectIds] = useState(() => workspace.projects.map((project) => project.id));
  const deleter = useActorRef(
    shareDeleteMachine,
    {
      input: {
        services: { playgrounds, links: workspace.storage },
        projectIds,
        link: { linkId: share.id, publishedAt: share.updatedAt },
      },
    },
    (snapshot) => {
      if (snapshot.status === "done") {
        void revalidator.revalidate();
        onClose();
      }
    },
  );
  const deletion = useSelector(deleter, (snapshot) => snapshot);
  const busy = deletion.matches("deleting") || deletion.matches("cleaningUp");
  const cleanupFailed = deletion.matches("cleanupFailed");

  const cancel = () => {
    deleter.send({ type: "delete.cancel" });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && !cleanupFailed && cancel()}>
      <DialogContent initialFocus={cancelRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Stop sharing “{share.title}”?</DialogTitle>
          <DialogDescription>Your projects stay in My projects, with all their edits.</DialogDescription>
        </DialogHeader>
        <StopSharingNote />
        {deletion.matches("deleting") && <FieldNote live>Stopping the share…</FieldNote>}
        {deletion.matches("failed") && (
          <FieldError>{deletion.context.error} The share may still be public, and nothing changed.</FieldError>
        )}
        {cleanupFailed && (
          <FieldError>
            The share is stopped, but this browser still keeps its link for a project. {deletion.context.error}
          </FieldError>
        )}
        <DialogFooter>
          {cleanupFailed ? (
            <Button variant="outline" onClick={() => deleter.send({ type: "cleanup.retry" })}>
              Retry
            </Button>
          ) : (
            <>
              <Button ref={cancelRef} variant="outline" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                focusableWhenDisabled
                disabled={busy}
                onClick={() => deleter.send({ type: "delete.confirm" })}
              >
                {deletion.matches("deleting") ? "Stopping…" : deletion.matches("failed") ? "Retry" : "Stop sharing"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
