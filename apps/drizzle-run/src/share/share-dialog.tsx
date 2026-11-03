import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { digestPlaygroundSnapshot, parsePlaygroundSnapshot } from "@drizzle-run/core/contracts";
import type { RunRecord } from "@drizzle-run/orchestration";
import { useActorRef, useSelector } from "@xstate/react";
import {
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  GlobeIcon,
  InfoIcon,
  Link2OffIcon,
  LoaderCircleIcon,
  PlayIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFetcher } from "react-router";
import type { ActorRefFrom } from "xstate";

import { useAppServices } from "../app-services";
import { COMMUNITY_REUSE_NOTE } from "../auth/account-copy";
import { useAuth, type Auth } from "../auth/auth-provider";
import { COMMUNITY_TOPICS, MAX_SHARE_DESCRIPTION_LENGTH, type CommunityTopic } from "../community/topics";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
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
import { Input } from "../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import type { PlaygroundPreview, PlaygroundTheme } from "../embed-loader/index";
import { resolveRecordingOffer, type RecordingOffer } from "../embed/recorded-run-offer";
import { cn } from "../lib/utils";
import type { ProjectRecord } from "../project/projects";
import type { ShareLinkRecord, ShareLinkStore } from "../store/storage";
import { AutoHeight } from "../ui/auto-height";
import { ChoiceCard, choiceGridClass, fieldClass, FieldError, fieldInputClass, FieldNote } from "../ui/field";
import { createClipboardMachine } from "./clipboard-machine";
import { communityListingMachine } from "./community-listing-machine";
import { buildEmbedPreview } from "./embed-preview";
import {
  buildEmbedSnippet,
  EMBED_HEIGHT_PRESETS,
  EMBED_HEIGHT_HINT,
  EMBED_THEMES,
  EmbedHeightPresetIdSchema,
  EmbedThemeSchema,
  getEmbedHeightPreset,
  getSafeLocalStorage,
  readEmbedHeightPresetId,
  readEmbedSnippetTheme,
  writeEmbedHeightPresetId,
  writeEmbedSnippetTheme,
  type EmbedHeightPresetId,
} from "./embed-snippet";
import { sharePublishMachine, type ShareStartView } from "./publish-machine";
import { shareDeleteMachine } from "./share-delete-machine";
import { ShareLinkField } from "./share-link-field";
import type { loadSharePublication } from "./share-publication-loader";

const shareDialogClass = cn(
  "max-h-[calc(100dvh-32px)] w-[min(520px,calc(100vw-24px))] max-w-none overflow-y-auto rounded-[18px] max-phone:w-[min(520px,calc(100vw-24px))]",
);
const shareDescriptionClass = cn("mt-1.5 mb-0");
const headerCodeClass = cn("font-mono text-[11px] whitespace-nowrap text-text");

/** A warning box with its icon. */
const shareWarningClass = cn(
  "flex items-start gap-2.5 rounded-[10px] bg-err-bg p-3 text-[13px]/[1.5] [&>svg]:mt-px [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-err",
);

/** What stopping a share does beyond this browser, said the same wherever it is asked. */
export function StopSharingNote() {
  return (
    <p className="m-0 text-[14px]/[1.5]">
      The link and its embeds stop working for everyone. Copies people already made stay theirs. Sharing again makes a
      new link.
    </p>
  );
}

/** The "I checked it" checkbox row. */
export const shareConsentClass = cn("flex min-h-touch cursor-pointer items-center gap-2.5 text-[14px] font-medium");

/** A status row inside a tab: what stands, then the one action that changes it. */
const shareStatusRowClass = cn(
  "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-[14px]",
);

/** The Share dialog's tabs, once the project has a link. */
const SHARE_TABS = ["link", "embed", "community"] as const;

type ShareTab = (typeof SHARE_TABS)[number];

const topicChoices = {
  playground: { label: "Playground", hint: "Shows how something works", Icon: PlayIcon },
  "bug-repros": { label: "Bug repro", hint: "Reproduces a Drizzle bug", Icon: BugIcon },
} satisfies Record<CommunityTopic, { label: string; hint: string; Icon: typeof PlayIcon }>;

export interface ShareDialogProps {
  project: ProjectRecord;
  links: ShareLinkStore;
  /** Where a project shared before opens: its Link tab, or the push step. */
  startView: ShareStartView;
  /**
   * The latest settled run of the project, or of each side in side order, when the dialog opens. A succeeded run of
   * exactly the shared code is published with it.
   */
  latestRuns: readonly (RunRecord | undefined)[];
  /** The link as this browser keeps it now, as soon as a publish, a Community change or a check saves it. */
  onLinkChange: (record: ShareLinkRecord) => void;
  /** A push to the existing link finished: the dialog has nothing left to show. */
  onPushed: () => void;
  onClose: () => void;
}

function capture(project: ProjectRecord, latestRuns: ShareDialogProps["latestRuns"]) {
  try {
    const snapshot = parsePlaygroundSnapshot({ snapshotVersion: 1, name: project.name, manifest: project.manifest });
    const offer = resolveRecordingOffer({ snapshot, latestRuns });

    return {
      snapshot,
      snapshotDigest: digestPlaygroundSnapshot(snapshot),
      idempotencyKey: crypto.randomUUID(),
      error: "",
      offer,
      ...(offer.status === "offered" ? { recording: offer.recording } : {}),
    };
  } catch (cause) {
    return {
      snapshot: undefined,
      snapshotDigest: undefined,
      idempotencyKey: undefined,
      error: cause instanceof Error ? cause.message : "This playground cannot be shared as a snapshot.",
      offer: { status: "none" } satisfies RecordingOffer,
    };
  }
}

/** Reads whether this browser shared the project before, then opens its link's tabs or the publish step. */
export function ShareDialog({
  project,
  links,
  startView,
  latestRuns,
  onLinkChange,
  onPushed,
  onClose,
}: ShareDialogProps) {
  const auth = useAuth();
  const { playgrounds, recordedRuns } = useAppServices();
  const signedIn = auth.status === "signedIn";
  const [{ offer, snapshotDigest, ...input }] = useState(() => ({
    ...capture(project, latestRuns),
    services: { playgrounds, recordedRuns },
    projectId: project.id,
    links,
    startView,
  }));
  const publisher = useActorRef(sharePublishMachine, { input });
  const deleter = useActorRef(shareDeleteMachine, {
    input: { services: { playgrounds, links }, projectIds: [project.id] },
  });
  const deletion = useSelector(deleter, (snapshot) => snapshot);
  const deletionBusy = deletion.matches("deleting") || deletion.matches("cleaningUp");
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const cleanupRetryRef = useRef<HTMLButtonElement>(null);
  const previousDeletionState = useRef(deletion.value);
  const [tab, setTab] = useState<ShareTab>("link");
  const [focusPush, setFocusPush] = useState(false);

  // Focus follows the deletion: Cancel on the question, the button that retries after a failure, and back to the
  // menu that offered "Stop sharing…" when the owner keeps the share. Once the share is deleted and forgotten here,
  // the dialog closes.
  useEffect(() => {
    const previous = previousDeletionState.current;
    previousDeletionState.current = deletion.value;

    if (previous === deletion.value) {
      return;
    }

    if (deletion.value === "confirming") {
      deleteCancelRef.current?.focus();
    } else if (deletion.value === "failed") {
      deleteConfirmRef.current?.focus();
    } else if (deletion.value === "cleanupFailed") {
      cleanupRetryRef.current?.focus();
    } else if (deletion.value === "idle") {
      menuTriggerRef.current?.focus();
    } else if (deletion.value === "deleted") {
      onClose();
    }
  }, [deletion.value, onClose]);

  const changeLink = useEffectEvent(onLinkChange);
  const finishPush = useEffectEvent(onPushed);

  useEffect(() => {
    const saved = publisher.on("record.saved", (event) => changeLink(event.record));
    const pushed = publisher.on("push.done", () => finishPush());

    return () => {
      saved.unsubscribe();
      pushed.unsubscribe();
    };
  }, [publisher]);

  const state = useSelector(publisher, (snapshot) => snapshot);
  const { existing, result, error, consent, description, recordingError } = state.context;
  const publishing = state.matches("publishing");
  const descriptionId = useId();
  const [clipboardMachine] = useState(() =>
    createClipboardMachine({ writeText: (text) => navigator.clipboard.writeText(text) }),
  );
  const copier = useActorRef(clipboardMachine);
  const copyState = useSelector(copier, (snapshot) => snapshot);
  const copyFeedback = {
    text: copyState.matches("copied") ? copyState.context.text : "",
    message: copyState.matches("failed")
      ? "Select the text and copy it manually."
      : copyState.matches("copied")
        ? copyState.context.message
        : "",
  };
  const copy = (text: string, message: string) => copier.send({ type: "clipboard.copy", text, message });

  const settling = state.matches({ published: "uploading" });
  // A push stays on its form until its run's output is added, then the dialog closes.
  const formBusy =
    publishing ||
    (existing !== undefined && result?.linkSaved === true && (settling || state.matches({ published: "done" })));

  const close = (open: boolean) => {
    if (!open && !publishing && !settling && !deletionBusy) {
      onClose();
    }
  };

  if (state.matches("lookingUp")) {
    return (
      <Dialog open onOpenChange={close}>
        <DialogContent className={shareDialogClass}>
          <AutoHeight className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Share</DialogTitle>
              <DialogDescription className={shareDescriptionClass}>
                Checking whether this project was shared before…
              </DialogDescription>
            </DialogHeader>
            <Skeleton className="h-8.75 w-full" />
          </AutoHeight>
        </DialogContent>
      </Dialog>
    );
  }

  const deletingLink = deletion.context.link;

  if (!deletion.matches("idle") && deletingLink !== undefined) {
    const removed = deletion.matches("cleaningUp") || deletion.matches("cleanupFailed") || deletion.matches("deleted");
    const deleting = deletion.matches("deleting");
    const deletingUrl = new URL(`/s/${deletingLink.linkId}`, window.location.origin).href;

    return (
      <Dialog open onOpenChange={close}>
        <DialogContent className={shareDialogClass} showCloseButton={!deletionBusy}>
          <AutoHeight className="flex flex-col gap-4">
            <DialogHeader className="min-w-0">
              <DialogTitle>{removed ? "Sharing stopped" : "Stop sharing?"}</DialogTitle>
              <DialogDescription className={shareDescriptionClass}>
                {removed
                  ? deletion.context.outcome === "alreadyGone"
                    ? "This share was already gone from Drizzle Run. Your project stays in My projects."
                    : "The share is gone from Drizzle Run. Your project stays in My projects."
                  : `${project.name} stays in My projects, with all its edits.`}
              </DialogDescription>
            </DialogHeader>
            {!removed && (
              <>
                <ShareLinkField label="Link to stop" url={deletingUrl} />
                <StopSharingNote />
                {deleting && <FieldNote live>Stopping the share…</FieldNote>}
                {deletion.matches("failed") && (
                  <FieldError>
                    {deletion.context.error} The share may still be public, and nothing changed in this browser.
                  </FieldError>
                )}
                <DialogFooter className="mt-0">
                  <Button
                    ref={deleteCancelRef}
                    variant="outline"
                    disabled={deleting}
                    onClick={() => deleter.send({ type: "delete.cancel" })}
                  >
                    Cancel
                  </Button>
                  <Button
                    ref={deleteConfirmRef}
                    variant="destructive"
                    focusableWhenDisabled
                    disabled={deleting}
                    onClick={() => deleter.send({ type: "delete.confirm" })}
                  >
                    {deleting ? "Stopping…" : deletion.matches("failed") ? "Retry" : "Stop sharing"}
                  </Button>
                </DialogFooter>
              </>
            )}
            {removed && (
              <>
                {deletion.matches("cleaningUp") && <FieldNote live>Removing the link from this project…</FieldNote>}
                {deletion.matches("cleanupFailed") && (
                  <div className="flex flex-wrap items-center gap-2">
                    <FieldError>
                      The share is stopped, but this browser still keeps its link for this project.{" "}
                      {deletion.context.error}
                    </FieldError>
                    <Button
                      ref={cleanupRetryRef}
                      variant="outline"
                      size="sm"
                      onClick={() => deleter.send({ type: "cleanup.retry" })}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                <DialogFooter className="mt-0">
                  <Button variant="outline" disabled={deletion.matches("cleaningUp")} onClick={onClose}>
                    Done
                  </Button>
                </DialogFooter>
              </>
            )}
          </AutoHeight>
        </DialogContent>
      </Dialog>
    );
  }

  const sharedLink = result?.record ?? (state.matches("sharing") ? existing : undefined);

  if (sharedLink && !formBusy) {
    const published = result && (
      <>
        <output className="flex items-center gap-2 text-[14px] font-medium">
          <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
          {existing ? "Your changes are pushed." : "Your snapshot is published."}
        </output>
        {state.matches({ published: "uploading" }) && <FieldNote live>Adding your run's output…</FieldNote>}
        {state.matches({ published: "failed" }) && (
          <div className="flex flex-wrap items-center gap-2">
            <FieldError>The link is updated, but your run's output was not added. {recordingError}</FieldError>
            <Button variant="outline" size="sm" onClick={() => publisher.send({ type: "recording.retry" })}>
              Retry
            </Button>
          </div>
        )}
        {!result.linkSaved && (
          <FieldError>
            The link is public, but this browser could not save it with the project. Find it in My shares.
          </FieldError>
        )}
      </>
    );

    return (
      <Dialog open onOpenChange={close}>
        <DialogContent
          className={cn(
            shareDialogClass,
            "top-[max(16px,12dvh)] flex max-h-[calc(100dvh-max(16px,12dvh)-16px)] min-w-0 translate-y-0 flex-col gap-4 overflow-hidden p-6 sm:p-7",
          )}
        >
          <DialogHeader className="min-w-0 pr-16">
            <DialogTitle>Share</DialogTitle>
            <DialogDescription className="sr-only">
              Copy the link to {project.name}, embed it in a page, or list it in Community.
            </DialogDescription>
          </DialogHeader>
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={menuTriggerRef}
              disabled={settling}
              render={
                <Button variant="ghost" size="icon-sm" className="absolute top-3 right-12" aria-label="Share actions" />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-auto"
              // The delete question focuses its Cancel button, which the closing menu must not take back.
              finalFocus={() => !deleter.getSnapshot().matches("confirming")}
            >
              <DropdownMenuItem
                variant="destructive"
                onClick={() => deleter.send({ type: "delete.open", link: sharedLink })}
              >
                <Link2OffIcon className="size-4" aria-hidden="true" />
                Stop sharing…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="-m-1 min-h-0 min-w-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto p-1">
            <SharedLinkTabs
              // A new record, after a publish or a Community change, starts the tabs over from it.
              key={JSON.stringify(sharedLink)}
              project={project}
              links={links}
              record={sharedLink}
              auth={auth}
              tab={tab}
              onTabChange={setTab}
              snapshotDigest={snapshotDigest}
              published={published}
              canPublish={result === undefined}
              copyFeedback={copyFeedback}
              onCopy={copy}
              focusPush={focusPush}
              onPush={() => {
                setFocusPush(false);
                publisher.send({ type: "push.open" });
              }}
              onRecordChange={(record) => {
                publisher.send({ type: "link.change", record });
                onLinkChange(record);
              }}
            />
          </div>
          <output className={copyState.matches("failed") ? "text-[12px] text-muted" : "sr-only"}>
            {copyFeedback.message}
          </output>
        </DialogContent>
      </Dialog>
    );
  }

  const goBack = state.matches("preparingPush")
    ? () => {
        setFocusPush(true);
        publisher.send({ type: "push.cancel" });
      }
    : onClose;
  const backLabel = state.matches("preparingPush") ? "Back" : "Cancel";

  if (!signedIn) {
    return (
      <Dialog open onOpenChange={close}>
        <DialogContent className={shareDialogClass}>
          <AutoHeight className="flex flex-col gap-4">
            <DialogHeader className="min-w-0">
              <DialogTitle>{existing ? "Sign in to push changes" : "Sign in to share"}</DialogTitle>
              <DialogDescription className={shareDescriptionClass}>
                {existing
                  ? "Only the GitHub account that shared this link can change it."
                  : "Shares belong to your GitHub account, so you can update or stop them from any browser."}
              </DialogDescription>
            </DialogHeader>
            <SignInToShare auth={auth} onBack={goBack} backLabel={backLabel} />
          </AutoHeight>
        </DialogContent>
      </Dialog>
    );
  }

  const publishLabel = existing ? "Push changes" : "Publish";
  const frozen = formBusy || state.matches("failed");
  const exposed =
    offer.status === "offered"
      ? "every file, environment value, and your last run's output"
      : "every file and environment value";

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className={shareDialogClass}>
        <AutoHeight className="flex flex-col gap-4">
          <DialogHeader className="min-w-0">
            <DialogTitle>{existing ? publishLabel : "Share a public snapshot"}</DialogTitle>
            <DialogDescription className={shareDescriptionClass}>
              {existing
                ? "The link and its embeds show your new code to everyone. What they show now is replaced."
                : `We publish a copy of ${project.name}. Your local project stays private and keeps its edits.`}
            </DialogDescription>
          </DialogHeader>
          <div className={fieldClass}>
            <label htmlFor={descriptionId}>
              Description <span className="font-normal text-muted">(optional)</span>
            </label>
            <Input
              id={descriptionId}
              className={fieldInputClass}
              value={description}
              maxLength={MAX_SHARE_DESCRIPTION_LENGTH}
              disabled={frozen}
              placeholder="What it shows, in one line"
              onChange={(event) => publisher.send({ type: "description.change", description: event.target.value })}
            />
            <FieldNote>Shown in link previews.</FieldNote>
          </div>
          <div className={shareWarningClass}>
            <TriangleAlertIcon aria-hidden="true" />
            <span>Anyone with the link can read {exposed}. Remove credentials, personal data, and secrets first.</span>
          </div>
          <label className={shareConsentClass}>
            <Checkbox
              checked={consent}
              disabled={formBusy}
              onCheckedChange={(checked) => publisher.send({ type: "consent.change", consent: checked })}
            />
            {existing
              ? "I checked these changes and they contain nothing private."
              : "I checked this project and it contains nothing private."}
          </label>
          {offer.status === "too_large" && (
            <FieldNote>Your last run's output is over {offer.maxBytes / 1024} KiB, so it isn't included.</FieldNote>
          )}
          {error && <FieldError>{error} The local project is unchanged and can still be exported as JSON.</FieldError>}
          <DialogFooter className="mt-0">
            <Button variant="outline" onClick={goBack} disabled={formBusy}>
              {backLabel}
            </Button>
            <Button
              variant="sticker"
              onClick={() => publisher.send({ type: "share.publish" })}
              disabled={!consent || formBusy || !input.snapshot || !input.idempotencyKey}
            >
              {formBusy
                ? existing
                  ? "Pushing…"
                  : "Publishing…"
                : state.matches("failed")
                  ? existing
                    ? "Retry push"
                    : "Retry publish"
                  : publishLabel}
            </Button>
          </DialogFooter>
        </AutoHeight>
      </DialogContent>
    </Dialog>
  );
}

/** The signed-out share step: sharing needs a GitHub account. */
function SignInToShare({ auth, onBack, backLabel }: { auth: Auth; onBack: () => void; backLabel: string }) {
  return (
    <>
      {auth.status === "unavailable" && (
        <FieldNote>Sharing needs a GitHub sign-in, which is not set up on this deployment.</FieldNote>
      )}
      {auth.status === "failed" && <FieldError>Your sign-in could not be checked. Try again in a moment.</FieldError>}
      <DialogFooter className="mt-0">
        <Button variant="outline" onClick={onBack}>
          {backLabel}
        </Button>
        {auth.status === "failed" ? (
          <Button variant="sticker" onClick={auth.retry}>
            Try again
          </Button>
        ) : (
          auth.status !== "unavailable" && (
            <Button variant="sticker" disabled={auth.status !== "signedOut"} onClick={auth.signIn}>
              {auth.status === "redirecting" ? "Opening GitHub…" : "Sign in with GitHub"}
            </Button>
          )
        )}
      </DialogFooter>
    </>
  );
}

interface SharedLinkTabsProps {
  project: ProjectRecord;
  links: ShareLinkStore;
  record: ShareLinkRecord;
  auth: Auth;
  tab: ShareTab;
  onTabChange: (tab: ShareTab) => void;
  /** The project's digest when the dialog opened, compared with the published one. */
  snapshotDigest: string | undefined;
  /** What a publish just did, shown above the link; undefined until then. */
  published: ReactNode;
  /** False right after a publish or a push: the dialog captured the project once, so there is nothing new to push. */
  canPublish: boolean;
  copyFeedback: { text: string };
  onCopy: (text: string, message: string) => void;
  /** Focus the Push changes button once it shows, after Back from the push step. */
  focusPush: boolean;
  onPush: () => void;
  /** The link as this browser keeps it now, after a Community change or a check with the server. */
  onRecordChange: (record: ShareLinkRecord) => void;
}

/** A published link's Link, Embed and Community tabs. */
function SharedLinkTabs({
  project,
  links,
  record,
  auth,
  tab,
  onTabChange,
  snapshotDigest,
  published,
  canPublish,
  copyFeedback,
  onCopy,
  focusPush,
  onPush,
  onRecordChange,
}: SharedLinkTabsProps) {
  const { community } = useAppServices();
  const lister = useActorRef(communityListingMachine, {
    input: { services: { community, links }, projectId: project.id, record },
  });
  const publication = useFetcher<typeof loadSharePublication>();
  const loadPublication = publication.load;

  const changeRecord = useEffectEvent(onRecordChange);

  useEffect(() => {
    const subscription = lister.on("record.saved", (event) => changeRecord(event.record));

    return () => subscription.unsubscribe();
  }, [lister]);

  useEffect(() => {
    if (canPublish) {
      void loadPublication(`/resources/share-publication/${encodeURIComponent(record.linkId)}`);
    }
  }, [canPublish, loadPublication, record.linkId]);

  // The server knows what the link shows even when another browser pushed it; this browser keeps it for the editor's
  // Share button.
  const checked = publication.data?.status === "loaded" ? publication.data : undefined;

  useEffect(() => {
    if (checked === undefined || checked.digest === record.publishedDigest) {
      return;
    }

    const refreshed: ShareLinkRecord = { ...record, publishedDigest: checked.digest };

    links
      .saveShareLink(project.id, refreshed)
      .then(() => changeRecord(refreshed))
      .catch((cause: unknown) => {
        console.error("Keeping what the share link shows in this browser failed", cause);
      });
  }, [checked, links, project.id, record]);

  const url = new URL(`/s/${record.linkId}`, window.location.origin).href;
  const publishedDigest = canPublish ? checked?.digest : snapshotDigest;
  const preview = buildEmbedPreview({
    name: checked?.name ?? project.name,
    description: record.description ?? "",
    manifest: checked?.manifest ?? project.manifest,
    author: auth.user?.login,
  });

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        const picked = SHARE_TABS.find((candidate) => candidate === next);

        if (picked !== undefined) {
          onTabChange(picked);
        }
      }}
      className="min-w-0 gap-4"
    >
      <TabsList variant="line">
        <TabsTrigger value="link">Link</TabsTrigger>
        <TabsTrigger value="embed">Embed</TabsTrigger>
        <TabsTrigger value="community">Community</TabsTrigger>
      </TabsList>
      <TabsContent value="link" className="flex min-w-0 flex-col gap-4 pt-0 text-[14px]">
        {published}
        <ShareLinkField label="Link" url={url}>
          <CopyButton
            variant="sticker"
            className="w-full sm:w-auto"
            copied={copyFeedback.text === url}
            onClick={() => onCopy(url, "Link copied.")}
          >
            Copy link
          </CopyButton>
        </ShareLinkField>
        {canPublish && (
          <PublicationStatus
            loading={publication.state !== "idle" || publication.data === undefined}
            failed={publication.data?.status === "failed" || snapshotDigest === undefined}
            changed={publishedDigest !== snapshotDigest}
            focusPush={focusPush}
            onPush={onPush}
          />
        )}
      </TabsContent>
      <TabsContent value="embed" className="pt-0">
        <EmbedCode snapshotId={record.linkId} preview={preview} copiedText={copyFeedback.text} onCopy={onCopy} />
      </TabsContent>
      <TabsContent value="community" className="pt-0">
        <CommunityListing auth={auth} lister={lister} />
      </TabsContent>
    </Tabs>
  );
}

/** Whether the project changed since the link's code, with the button that pushes the changes. */
function PublicationStatus({
  loading,
  failed,
  changed,
  focusPush,
  onPush,
}: {
  loading: boolean;
  failed: boolean;
  changed: boolean;
  focusPush: boolean;
  onPush: () => void;
}) {
  const focusOnMount = focusPush ? (button: HTMLButtonElement | null) => button?.focus() : undefined;
  const publishButton = (
    <Button variant="outline" size="sm" ref={focusOnMount} onClick={onPush}>
      <UploadIcon className="size-3.5" aria-hidden="true" />
      Push changes
    </Button>
  );

  if (loading) {
    return (
      <p role="note" aria-live="polite" className={cn(shareStatusRowClass, "justify-start")}>
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        Checking for unpublished changes…
      </p>
    );
  }

  if (failed) {
    return (
      <div role="note" aria-live="polite" className={shareStatusRowClass}>
        <span className="flex items-center gap-2">
          <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
          Couldn't check for changes
        </span>
        {publishButton}
      </div>
    );
  }

  if (!changed) {
    return (
      <div role="note" aria-live="polite" className={shareStatusRowClass}>
        <span className="flex items-center gap-2">
          <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
          All changes are published
        </span>
      </div>
    );
  }

  return (
    <div role="note" aria-live="polite" className={shareStatusRowClass}>
      <span className="flex items-center gap-2">
        <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
        Unpublished changes
      </span>
      {publishButton}
    </div>
  );
}

type CommunityLister = ActorRefFrom<typeof communityListingMachine>;

/** The Community tab: list the link, edit its card, or unlist it. */
function CommunityListing({ auth, lister }: { auth: Auth; lister: CommunityLister }) {
  const listingState = useSelector(lister, (snapshot) => snapshot);
  const { record, topic, description, error } = listingState.context;
  const listing = record.listing;
  const busy = !listingState.matches("idle");
  const descriptionId = useId();
  const topicLabelId = useId();
  const owner = auth.user === null ? "your GitHub account" : `@${auth.user.login}`;

  if (auth.status !== "signedIn") {
    return (
      <div className="flex flex-col gap-3 text-[14px]">
        {listing && (
          <p className={cn(shareStatusRowClass, "justify-start")}>
            <GlobeIcon className="size-4 shrink-0" aria-hidden="true" />
            Listed in Community
          </p>
        )}
        <p>List this share on the Community page so others can find it.</p>
        {auth.status === "unavailable" ? (
          <FieldNote>Listing needs a GitHub sign-in, which is not set up on this deployment.</FieldNote>
        ) : (
          <>
            <FieldNote>Sign in with the GitHub account that shared this link to list it.</FieldNote>
            <Button variant="outline" className="self-start" onClick={auth.signIn}>
              Sign in with GitHub
            </Button>
          </>
        )}
      </div>
    );
  }

  const cardChanged =
    listing !== undefined && (topic !== listing.topic || description.trim() !== (listing.description ?? ""));

  return (
    <div className="flex flex-col gap-4 text-[14px]">
      {listing ? (
        <div className={shareStatusRowClass}>
          <span className="flex items-center gap-2">
            <GlobeIcon className="size-4 shrink-0" aria-hidden="true" />
            Listed · {owner}
          </span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => lister.send({ type: "listing.remove" })}>
            {listingState.matches("removing") ? "Unlisting…" : "Unlist"}
          </Button>
        </div>
      ) : (
        <FieldNote>
          Others find it on the Community page under {owner}, marked as not official. It shows the link&apos;s current
          code. {COMMUNITY_REUSE_NOTE}
        </FieldNote>
      )}
      <div className="flex flex-col gap-2">
        <span id={topicLabelId} className="font-medium">
          Kind
        </span>
        <RadioGroup
          aria-labelledby={topicLabelId}
          className={choiceGridClass}
          value={topic}
          disabled={busy}
          onValueChange={(next) => {
            const picked = COMMUNITY_TOPICS.find((candidate) => candidate === next);

            if (picked !== undefined) {
              lister.send({ type: "topic.change", topic: picked });
            }
          }}
        >
          {COMMUNITY_TOPICS.map((candidate) => {
            const { label, hint, Icon } = topicChoices[candidate];

            return (
              <ChoiceCard key={candidate} checked={topic === candidate} className="flex-col items-stretch gap-1">
                <span className="flex items-center gap-2">
                  <RadioGroupItem value={candidate} aria-label={label} />
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </span>
                <span className="text-[12px] font-normal text-muted">{hint}</span>
              </ChoiceCard>
            );
          })}
        </RadioGroup>
      </div>
      <div className={fieldClass}>
        <label htmlFor={descriptionId}>
          Description <span className="font-normal text-muted">(optional)</span>
        </label>
        <Input
          id={descriptionId}
          className={fieldInputClass}
          value={description}
          maxLength={MAX_SHARE_DESCRIPTION_LENGTH}
          disabled={busy}
          placeholder="What it shows, in one line"
          onChange={(event) => lister.send({ type: "description.change", description: event.target.value })}
        />
        <FieldNote>Shown on the Community card.</FieldNote>
      </div>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex justify-end">
        {listing ? (
          <Button
            variant="outline"
            disabled={busy || !cardChanged}
            onClick={() => lister.send({ type: "listing.save" })}
          >
            {listingState.matches("saving") ? "Saving…" : "Save card"}
          </Button>
        ) : (
          <Button variant="sticker" disabled={busy} onClick={() => lister.send({ type: "listing.save" })}>
            {listingState.matches("saving") ? "Listing…" : "List in Community"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The embed snippet of a published link: its height and theme pickers, the copy button, and the code on demand. */
function EmbedCode({
  snapshotId,
  preview,
  copiedText,
  onCopy,
}: {
  snapshotId: string;
  preview: PlaygroundPreview;
  copiedText: string;
  onCopy: (text: string, message: string) => void;
}) {
  const [heightPresetId, setHeightPresetId] = useState(() => readEmbedHeightPresetId(getSafeLocalStorage()));
  const [embedTheme, setEmbedTheme] = useState(() => readEmbedSnippetTheme(getSafeLocalStorage()));
  const snippet = buildEmbedSnippet({
    origin: window.location.origin,
    snapshotId,
    preview,
    heightPreset: getEmbedHeightPreset(heightPresetId),
    theme: embedTheme,
  });

  const chooseHeight = (id: EmbedHeightPresetId) => {
    setHeightPresetId(id);
    writeEmbedHeightPresetId(getSafeLocalStorage(), id);
  };

  const chooseTheme = (theme: PlaygroundTheme) => {
    setEmbedTheme(theme);
    writeEmbedSnippetTheme(getSafeLocalStorage(), theme);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 text-[14px]">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <EmbedHeightPicker value={heightPresetId} onChange={chooseHeight} />
        <EmbedThemePicker value={embedTheme} onChange={chooseTheme} />
      </div>
      <CopyButton
        variant="sticker"
        className="self-start"
        copied={copiedText === snippet}
        onClick={() => onCopy(snippet, "Embed code copied.")}
      >
        Copy embed code
      </CopyButton>
      <FieldNote>It shows a cover first. The playground loads only when the reader clicks.</FieldNote>
      <details className="group min-w-0">
        <summary className="flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-muted hover:text-text">
          <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
          Show code
        </summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <pre className="max-h-45 overflow-auto rounded-md border border-border bg-code p-3 text-[12px] font-normal wrap-normal whitespace-pre">
            {snippet}
          </pre>
          <FieldNote>
            It runs inline in Chrome and Edge. Firefox and Safari show your included run, or open it in a new tab,
            unless your page sends <code className={headerCodeClass}>Cross-Origin-Opener-Policy: same-origin</code> and{" "}
            <code className={headerCodeClass}>Cross-Origin-Embedder-Policy: require-corp</code>, which also block
            cross-origin images, scripts and iframes that don't allow it.
          </FieldNote>
        </div>
      </details>
    </div>
  );
}

/**
 * The embed code's height: a segmented choice of presets, with what the reader's page does under it
 *
 * A radio group, so arrow keys move the pick and screen readers announce one choice of three. Every option keeps the
 * same two lines and the hint stays one line, so a new pick never moves the dialog.
 */
function EmbedHeightPicker({
  value,
  onChange,
}: {
  value: EmbedHeightPresetId;
  onChange: (id: EmbedHeightPresetId) => void;
}) {
  const labelId = useId();
  const hintId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-[13px]">
        Height
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        aria-describedby={hintId}
        className="grid grid-cols-3 gap-0.5 rounded-md bg-surface-2 p-0.75"
        value={value}
        onValueChange={(next) => {
          const picked = EmbedHeightPresetIdSchema.safeParse(next);

          if (picked.success) {
            onChange(picked.data);
          }
        }}
      >
        {EMBED_HEIGHT_PRESETS.map((preset) => {
          const size = `${preset.heightPx} px`;

          return (
            <RadioPrimitive.Root
              key={preset.id}
              value={preset.id}
              aria-label={`${preset.name} · ${size}`}
              className="flex min-w-0 cursor-pointer flex-col items-center rounded-sm px-2 py-1.5 text-center text-[13px] leading-[1.35] font-medium text-muted transition-colors duration-(--motion-fast) hover:text-text data-checked:bg-surface data-checked:text-text data-checked:shadow-[0_0_0_1px_var(--border)]"
            >
              <span className="max-w-full truncate">{preset.name}</span>
              <span className="text-[12px] font-normal text-muted">{size}</span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
      <p id={hintId} className="text-[12px] font-normal text-muted">
        {EMBED_HEIGHT_HINT}
      </p>
    </div>
  );
}

function EmbedThemePicker({ value, onChange }: { value: PlaygroundTheme; onChange: (theme: PlaygroundTheme) => void }) {
  const labelId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-[13px]">
        Theme
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        className="grid grid-cols-2 gap-0.5 rounded-md bg-surface-2 p-0.75"
        value={value}
        onValueChange={(next) => {
          const picked = EmbedThemeSchema.safeParse(next);

          if (picked.success) {
            onChange(picked.data);
          }
        }}
      >
        {EMBED_THEMES.map((theme) => (
          <RadioPrimitive.Root
            key={theme.id}
            value={theme.id}
            aria-label={theme.name}
            className="flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-sm px-3 py-1.5 text-center text-[13px] leading-[1.35] font-medium text-muted transition-colors duration-(--motion-fast) hover:text-text data-checked:bg-surface data-checked:text-text data-checked:shadow-[0_0_0_1px_var(--border)]"
          >
            <span className="max-w-full truncate">{theme.name}</span>
            <span
              aria-hidden="true"
              className={cn(
                "flex h-3.5 w-8 items-center justify-center rounded-[4px] border border-border",
                theme.id === "dark" ? "bg-ink" : "bg-white",
              )}
            >
              <span className="h-1.5 w-4 rounded-full bg-lime" />
            </span>
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
    </div>
  );
}

function CopyButton({
  copied,
  children,
  ...props
}: Pick<ComponentProps<typeof Button>, "variant" | "size" | "onClick" | "className"> & {
  copied: boolean;
  children: ReactNode;
}) {
  return (
    <Button {...props}>
      <span className="grid">
        <span
          className={cn("col-start-1 row-start-1 flex items-center justify-center gap-1.75", copied && "invisible")}
          aria-hidden={copied}
        >
          <CopyIcon className="size-3.5" aria-hidden="true" />
          {children}
        </span>
        <span
          className={cn("col-start-1 row-start-1 flex items-center justify-center gap-1.75", !copied && "invisible")}
          aria-hidden={!copied}
        >
          <CheckIcon className="size-3.5" aria-hidden="true" />
          Copied
        </span>
      </span>
    </Button>
  );
}
