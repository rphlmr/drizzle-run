import { canSharePairFile, isSharedPairFile, PAIR_SIDES, type PairManifest } from "@drizzle-run/core/pair";
import { RunProvider } from "@drizzle-run/react";
import type { PairRunResult } from "@drizzle-run/runtime/guides";
import { useRef, type ReactNode, type Ref } from "react";

import { ProjectSyncStatus } from "../cloud/project-sync-status";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import { ChatToggle, PendingEditBanner, PendingRunBanner } from "../connect/chat-panel";
import type { ConnectViewOptions } from "../connect/connect-provider";
import { cn } from "../lib/utils";
import { resolveProjectDocs } from "../official/project-docs";
import { ProjectDocsMenu } from "../official/project-docs-menu";
import type { AsideControls } from "../project/project-view";
import { formatProjectDialects, type SideBySideProject } from "../project/projects";
import type { ProjectPreferenceStorage, ShareLinkStore } from "../store/storage";
import { CapabilityMessage } from "../ui/capability-message";
import { FileTabs } from "../ui/file-tabs";
import { SidesIcon } from "../ui/icons";
import { LeaveDialog } from "../ui/leave-dialog";
import { PreparationFailedDialog } from "../ui/preparing-card";
import { DuplicateButton, ProjectActionsGroup } from "../ui/project-actions";
import { SeedBar } from "../ui/seed-bar";
import { SideBySideTag } from "../ui/side-by-side-tag";
import { StatusBar } from "../ui/status-bar";
import { WorkspaceMoreMenu } from "../workspace/more-menu";
import type { RunNotesMode } from "../workspace/run-marks";
import { isStoreSaveState, saveStateLabels, type SaveState } from "../workspace/save-state";
import { ShareButton } from "../workspace/share-button";
import { type RailWidth, WorkspaceLayout } from "../workspace/workspace-layout-view";
import { ChangeSideSheet } from "./change-side-popover";
import { PhoneSideControls } from "./phone-side-controls";
import { RunBothButton } from "./run-both-button";
import { SideFileMenu } from "./side-file-menu";
import { formatBothSides, getFileHint } from "./side-labels";
import type { SideMark } from "./side-marks";
import { getPreparingLabel, SidePane } from "./side-pane";
import { useSideBySideWorkspace } from "./use-side-by-side-workspace";

/** Lets a guide run a step's files on both sides, so each run shows in its side's output. */
export interface SideBySideControl {
  run(manifest: PairManifest, signal: AbortSignal): Promise<PairRunResult>;
}

/** Props of the side-by-side workspace. */
export interface SideBySideViewProps {
  project: SideBySideProject;
  storage: ProjectPreferenceStorage & ShareLinkStore;
  /** The file this project last showed in this browser, opened when the URL names none the project has. */
  rememberedFile?: string;
  update: (project: SideBySideProject) => void;
  saveState: SaveState;
  /** Asks before the page unloads. Defaults to `shouldWarnOnUnload` for the save state and `unsavedCopy`. */
  warnOnLeave?: boolean;
  /**
   * The page holds edits nothing saves, such as an edited example, guide step or shared link: leaving it in the app
   * asks first too.
   */
  unsavedCopy?: boolean;
  reportError: (error: string) => void;
  /** Header slot after the logo: the project switcher, a snapshot title, or a guide's breadcrumb. */
  leading?: ReactNode;
  /** "Fork to my projects", in the header's project actions box, for a guide or a snapshot. */
  fork?: ReactNode;
  /** Saves the copy to My projects from the leave dialog, which then offers Fork and leave. */
  forkBeforeLeaving?: () => Promise<unknown>;
  banner?: ReactNode;
  /** Share, file actions and changing a side; off for a shared snapshot or a guide. */
  projectActions?: boolean;
  /** Locks both editors; the text shows when someone types. */
  readOnly?: string;
  /** Pins both sides' versions, with this reason on the pair button. */
  sidesLocked?: string;
  /**
   * A panel left of the sides, such as a guide's rail, given what it can do with the sides. A phone shows it as its
   * first view, or with `sheet` a bottom sheet over the sides.
   */
  aside?: {
    label: string;
    renderContent: (controls: AsideControls) => ReactNode;
    sheet?: boolean;
    collapsed?: boolean;
    railWidth?: RailWidth;
  };
  /**
   * Written into both editors each time `version` changes, such as a guide step's files. The caller updates `project`
   * too.
   */
  fileOverride?: { version: number; manifest: PairManifest };
  /** Marks lines on each side each time `version` changes; both sides open the first side's file. */
  highlight?: { version: number; sides: readonly (SideMark | undefined)[] };
  /** Takes over Run both, such as a guide that runs each step through `control`. */
  onRunRequest?: () => void;
  /** Keeps Run both disabled and says why in its tooltip, such as on a guide step without a run. */
  runDisabled?: string;
  /** The display labels a guide step points at, scrolled to in each side's results. */
  highlightedDisplays?: readonly string[];
  control?: Ref<SideBySideControl>;
  onExportProjects?: () => void;
  /** Offers "Duplicate": in the header's project actions box, or the more menu on a phone. */
  onDuplicate?: () => void;
  /**
   * Notes the shown run leaves in each side's editor: a workspace's ("playground"), a guide's, which also say
   * where each result comes from ("guided"), or none.
   */
  runNotes?: RunNotesMode;
  /**
   * Lends this view to the AI chat tools while it is open: a workspace project with its chat
   * dock (one chat for both sides), a guide or a shared link reading only.
   */
  connect?: ConnectViewOptions;
}

/**
 * A side-by-side project: two sides, each with its own editor, runtime and output. Run both runs
 * both sides, each in a fresh guest and database. Nothing compares them.
 */
export function SideBySideView(props: SideBySideViewProps) {
  const {
    project,
    saveState,
    leading,
    fork,
    forkBeforeLeaving,
    banner,
    projectActions = true,
    readOnly,
    sidesLocked,
    aside,
    onExportProjects,
    onDuplicate,
    runNotes = "playground",
    runDisabled,
    highlightedDisplays,
    connect,
  } = props;
  const workspace = useSideBySideWorkspace(props);
  const { phone, view, releases, selected, fileRoles, pairRunning, bothReady, unavailable, unsupported } = workspace;
  const { manifest } = project;
  // The phone sheet opens from a menu item that is gone once the sheet closes, so focus goes back to the menu's trigger.
  const changeSideMenuTrigger = useRef<HTMLElement | null>(null);
  const runtimeLabel = pairRunning
    ? "Running both sides"
    : bothReady
      ? "Ready to run both sides"
      : unavailable
        ? "Runtime unavailable"
        : "Preparing editors";
  const docs = resolveProjectDocs(project.source);
  const unavailableSides = workspace.sides.filter(
    (side) => side.ready.matches("failed") || side.ready.matches("unsupported"),
  );
  const runBothReason =
    unavailableSides.length === 2
      ? "Neither side can run right now. Each pane says why."
      : unavailableSides.length === 1
        ? `${releases[unavailableSides[0].side].label} cannot run right now. Its pane says why.`
        : (runDisabled ?? (manifest.entrypoints.run === undefined ? "No file is set to run" : undefined));

  const runBoth = (
    <RunBothButton
      running={pairRunning}
      bothReady={bothReady}
      unavailable={unavailable}
      canRun={workspace.canRun}
      disabledReason={runBothReason}
      phone={phone}
      onRun={workspace.startRun}
      onCancel={workspace.cancelRun}
    />
  );

  const canShare = canSharePairFile(manifest, selected);
  const fileMenu = projectActions &&
    ((workspace.selectedPerSide ? canShare : !fileRoles.seedSelected) || fileRoles.helperSelected) && (
      <SideFileMenu
        releases={releases}
        selectedPerSide={workspace.selectedPerSide}
        canShare={canShare}
        seedSelected={fileRoles.seedSelected}
        helperSelected={fileRoles.helperSelected}
        onShare={workspace.shareSideFile}
        onSplit={workspace.splitSideFile}
        onRename={workspace.openRename}
        onDelete={workspace.openDelete}
      />
    );

  const fileTabs = (
    <FileTabs
      layout={phone ? "phone" : "header"}
      files={workspace.files}
      selected={selected}
      onSelect={workspace.chooseFile}
      pending={workspace.pendingPaths}
      errors={workspace.errorFiles}
      describe={(path) => ({ hint: getFileHint(manifest, path), perSide: !isSharedPairFile(manifest, path) })}
      onAdd={projectActions ? workspace.openCreate : undefined}
      skipped={!fileRoles.seedOn && fileRoles.seedFileShown ? new Set([workspace.seedPath]) : undefined}
      trailing={fileMenu}
    />
  );

  const databaseLabel = formatProjectDialects(manifest);
  const moreMenu = (
    <WorkspaceMoreMenu
      phone={phone}
      databaseLabel={databaseLabel}
      saveState={saveState}
      hint="Swap sides, change a side, back to one version"
      leadingItems={
        pairRunning && (
          <>
            <DropdownMenuItem onClick={workspace.cancelRun}>Cancel run</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )
      }
      project={
        projectActions
          ? {
              onShare: workspace.openShare,
              onPush: workspace.shareStatus.status === "changed" ? workspace.openPush : undefined,
              onDuplicate,
              trust: connect?.trust,
              seed: fileRoles.seedFileShown ? { on: fileRoles.seedOn, onToggle: workspace.toggleSeed } : undefined,
            }
          : undefined
      }
      projectItems={
        projectActions && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sides</DropdownMenuLabel>
              <DropdownMenuItem disabled={pairRunning} onClick={workspace.swapSides}>
                Swap sides
              </DropdownMenuItem>
              {PAIR_SIDES.map((side) => (
                <DropdownMenuItem
                  key={side}
                  disabled={pairRunning || sidesLocked !== undefined}
                  onClick={() => {
                    changeSideMenuTrigger.current = document.querySelector<HTMLElement>(
                      '[aria-haspopup="menu"][data-popup-open]',
                    );
                    workspace.setChanging(side);
                  }}
                >
                  Change {releases[side].label}’s version…
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )
      }
      runOptions={workspace.runOptions}
      defaultFontSize={workspace.defaultFontSize}
    />
  );

  const shownPhoneSide = workspace.sides[view.side];

  return (
    <WorkspaceLayout
      mode={workspace.mode}
      view={view}
      onRunShortcut={workspace.startRun}
      header={{
        leading: phone ? (
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="truncate text-[14.5px] font-semibold">{project.name}</span>
            <span className="flex min-w-0 items-center gap-1.25 text-[11.5px] text-muted">
              <SidesIcon className="size-2.75 shrink-0" />
              <span className="truncate">Side by side · {formatBothSides(manifest)}</span>
            </span>
          </span>
        ) : (
          <>
            {leading ?? <span className="max-w-65 truncate font-semibold">{project.name}</span>}
            <SideBySideTag size="header" />
          </>
        ),
        actions: (
          <>
            <ProjectActionsGroup>
              {docs && <ProjectDocsMenu docs={docs} />}
              {fork}
              {projectActions && !phone && onDuplicate && <DuplicateButton onDuplicate={onDuplicate} />}
            </ProjectActionsGroup>
            {projectActions && !phone && (
              <ShareButton
                shareStatus={workspace.shareStatus}
                onShare={workspace.openShare}
                onPush={workspace.openPush}
              />
            )}
            {workspace.chat && (
              <ChatToggle open={workspace.chatOpen} onToggle={() => workspace.setChatOpen(!workspace.chatOpen)} />
            )}
            {moreMenu}
          </>
        ),
        run: runBoth,
      }}
      fileTabs={fileTabs}
      banner={banner}
      blocked={
        unsupported && (
          <CapabilityMessage
            capabilities={unsupported.capabilities}
            surface={phone ? "phone" : "app"}
            linkToCopy={window.location.href}
            onExport={onExportProjects}
            onRetry={() => unsupported.side.readiness.send({ type: "readiness.retry" })}
            openHref={window.location.href}
          />
        )
      }
      aside={
        aside && {
          label: aside.label,
          content: workspace.asideContent,
          sheet: aside.sheet,
          collapsed: aside.collapsed,
          railWidth: aside.railWidth,
        }
      }
      work={{
        shape: "sides",
        phoneControls: (
          <RunProvider controller={shownPhoneSide.execution}>
            <PhoneSideControls
              releases={releases}
              side={view.side}
              onSide={(side) => view.send({ type: "side.show", side })}
              preparing={getPreparingLabel(shownPhoneSide)}
              view={view.workView}
              tab={workspace.tabs[view.side]}
              onView={(next) => view.send({ type: next === "code" ? "code.show" : "output.show" })}
              onTab={(tab) => {
                workspace.setSideTab(view.side, tab);
                view.send({ type: "output.show" });
              }}
              selected={selected}
            />
            {projectActions && (
              <ChangeSideSheet
                manifest={manifest}
                side={workspace.changing ?? 0}
                open={workspace.changing !== undefined}
                returnFocus={changeSideMenuTrigger}
                onOpenChange={(open) => {
                  if (!open) {
                    workspace.setChanging(undefined);
                  }
                }}
                onConfirm={(tupleId, sideFiles, guestFlavor) => {
                  if (workspace.changing !== undefined) {
                    workspace.changeSide(workspace.changing, tupleId, sideFiles, guestFlavor);
                  }
                }}
              />
            )}
          </RunProvider>
        ),
        top: (
          <>
            {workspace.workspaceChat && !phone && (
              <div className="mb-3 overflow-hidden rounded-lg border border-border empty:hidden">
                <PendingRunBanner projectId={project.id} />
                <PendingEditBanner projectId={project.id} />
              </div>
            )}
            {fileRoles.seedSelected && projectActions && (!phone || view.workView === "code") && (
              <div className="mb-3 overflow-hidden rounded-lg border border-border bg-surface *:border-b-0 max-phone:mx-4 max-phone:mt-2.5 max-phone:mb-0">
                <SeedBar on={fileRoles.seedOn} onToggle={workspace.toggleSeed} />
              </div>
            )}
          </>
        ),
        renderSide: (index, slots) => {
          const side = workspace.sides[index];

          return (
            <RunProvider controller={side.execution}>
              <SidePane
                side={side}
                release={releases[index]}
                manifest={manifest}
                selected={selected}
                phone={phone}
                hidden={phone && index !== view.side}
                phoneView={view.workView}
                tab={workspace.tabs[index]}
                onTabChange={(tab) => workspace.setSideTab(index, tab)}
                preparing={getPreparingLabel(side)}
                readOnly={readOnly !== undefined}
                sidesLocked={sidesLocked}
                canChange={projectActions && !pairRunning}
                changing={workspace.changing === index}
                onChanging={(open) => workspace.setChanging(open ? index : undefined)}
                onChangeSide={(tupleId, sideFiles, guestFlavor) =>
                  workspace.changeSide(index, tupleId, sideFiles, guestFlavor)
                }
                onRename={
                  projectActions && readOnly === undefined && sidesLocked === undefined
                    ? (name) => workspace.renameSide(index, name)
                    : undefined
                }
                fileTabs={slots.fileTabs}
                queryPlans={workspace.runOptions.plansSettings}
                settings={{
                  flag: workspace.runOptions.queryPlans,
                  dialect: manifest.sides[index].target.dialect,
                  onChange: workspace.runOptions.setQueryPlans,
                }}
                runPicker={aside === undefined}
                runNotes={runNotes}
                highlightedDisplays={highlightedDisplays}
                onDiagnostic={workspace.diagnostic(side)}
                split={slots.split}
              />
            </RunProvider>
          );
        },
      }}
      chat={{ target: workspace.chat, open: workspace.chatOpen, onClose: () => workspace.setChatOpen(false) }}
      overlay={
        workspace.failedSides.length > 0 && (
          <PreparationFailedDialog
            error={workspace.failedSides[0]?.ready.context.error}
            note="Your files stay as they are."
            onRetry={() => {
              for (const side of workspace.failedSides) {
                side.readiness.send({ type: "readiness.retry" });
              }
            }}
          />
        )
      }
      statusBar={
        <StatusBar
          databaseLabel={databaseLabel}
          release={
            <span className="inline-flex items-center gap-1.5">
              <span className="font-semibold text-text">Drizzle</span>
              <span className="font-mono text-[11px]">{formatBothSides(manifest)}</span>
            </span>
          }
          runtime={pairRunning ? "preparing" : bothReady ? "ready" : unavailable ? "failed" : "preparing"}
          runtimeLabel={runtimeLabel}
          save={
            isStoreSaveState(saveState) ? (
              <ProjectSyncStatus
                project={project}
                saveLabel={saveStateLabels[saveState]}
                saved={saveState === "saved"}
                onDuplicate={onDuplicate}
              />
            ) : (
              saveStateLabels[saveState]
            )
          }
        />
      }
      phoneFooter={
        <footer className="flex shrink-0 items-center gap-2.5 border-t border-border bg-surface px-4 pt-2.5 pb-4.5 text-[11.5px] text-muted">
          <span className="font-semibold text-text">{databaseLabel}</span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.75 rounded-full",
                pairRunning || !bothReady ? "bg-warn" : unavailable ? "bg-err" : "bg-accent-text",
              )}
              aria-hidden="true"
            />
            {runtimeLabel}
          </span>
          <output className="ml-auto">{saveStateLabels[saveState]}</output>
        </footer>
      }
      dialogs={
        <>
          {workspace.shareDialog}
          <LeaveDialog blocker={workspace.leaveBlocker} onFork={forkBeforeLeaving} />
          {workspace.helperFileDialog}
        </>
      }
    />
  );
}
