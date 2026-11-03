import { DIALECTS } from "@drizzle-run/core/catalog";
import type { RunResult } from "@drizzle-run/core/contracts";
import type { RunManifest } from "@drizzle-run/core/manifest";
import type { RunOutcome } from "@drizzle-run/orchestration";
import { RunProvider } from "@drizzle-run/react";
import type { createBrowserRuntime } from "@drizzle-run/runtime/browser";
import { MoreHorizontalIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { ProjectSyncStatus } from "../cloud/project-sync-status";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ChatToggle, PendingEditBanner, PendingRunBanner } from "../connect/chat-panel";
import type { ConnectViewOptions } from "../connect/connect-provider";
import { EDITOR_TEXT } from "../design/editor-font-size";
import { cn } from "../lib/utils";
import { resolveProjectDocs } from "../official/project-docs";
import { ProjectDocsMenu } from "../official/project-docs-menu";
import type { ProjectPreferenceStorage, ShareLinkStore } from "../store/storage";
import { CapabilityMessage } from "../ui/capability-message";
import { CodePreview } from "../ui/code-preview";
import { FileTabs } from "../ui/file-tabs";
import { LeaveDialog } from "../ui/leave-dialog";
import { LibrariesPopover } from "../ui/libraries-popover";
import { OutputPanel, type OutputComparison } from "../ui/output-panel";
import type { OutputTab } from "../ui/output-tab";
import { PreparationFailedDialog } from "../ui/preparing-card";
import { DuplicateButton, ProjectActionsGroup } from "../ui/project-actions";
import { ReleaseDialog, ReleasePicker } from "../ui/release-picker";
import { RunButton, type RunButtonState } from "../ui/run-button";
import type { RunNote } from "../ui/run-notes";
import type { TimelineFilter } from "../ui/run-timeline";
import { SeedBar } from "../ui/seed-bar";
import { StatusBar } from "../ui/status-bar";
import { WorkspaceMoreMenu } from "../workspace/more-menu";
import type { RunNotesMode } from "../workspace/run-marks";
import { isStoreSaveState, saveStateLabels, type SaveState } from "../workspace/save-state";
import { ShareButton } from "../workspace/share-button";
import { type RailWidth, WorkspaceLayout } from "../workspace/workspace-layout-view";
import type { OneVersionProject } from "./projects";
import { useProjectWorkspace } from "./use-project-workspace";

type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;

/** Output views available in an embed. */
export const embedViews = ["results", "story", "logs"] as const satisfies readonly TimelineFilter[];

/** Lets a host run code through this playground, so the run shows in its output like any other. */
export interface ProjectControl {
  /** Runs `manifest` once; aborting `signal` cancels the run. Rejects when the playground cannot run now. */
  run(manifest: RunManifest, signal: AbortSignal): Promise<RunResult>;
}

/** What a side panel can do with the playground beside it. */
export interface AsideControls {
  phone: boolean;
  runState: RunButtonState;
  canRun: boolean;
  /** Presses Run, as the header button does. */
  run: () => void;
  /** Opens an output view; a phone switches to the output. */
  showOutput(tab: OutputTab): void;
}

/** Props of the one-version workspace. */
export interface ProjectViewProps {
  project: OneVersionProject;
  storage: ProjectPreferenceStorage & ShareLinkStore;
  /** The file this project last showed in this browser, opened when the URL names none the project has. */
  rememberedFile?: string;
  update: (project: OneVersionProject) => void;
  saveState: SaveState;
  /** Asks before the page unloads. Defaults to `shouldWarnOnUnload` for the save state and `unsavedCopy`. */
  warnOnLeave?: boolean;
  /**
   * The page holds edits nothing saves, such as an edited example, guide step or shared link: leaving it in the app
   * asks first too.
   */
  unsavedCopy?: boolean;
  reportError: (error: string) => void;
  /** Header slot left of the file tabs: the project switcher, or a snapshot title. */
  leading?: ReactNode;
  /** Header content before the project actions, such as the embed's "Open full playground". */
  headerActions?: ReactNode;
  /** "Fork to my projects", in the header's project actions box, for an official example, a guide or a snapshot. */
  fork?: ReactNode;
  /** Saves the copy to My projects from the leave dialog, which then offers Fork and leave. */
  forkBeforeLeaving?: () => Promise<unknown>;
  /** Note under the header, such as the shared snapshot banner. */
  banner?: ReactNode;
  /** Stack code above output and limit output tabs to `embedViews`. */
  compact?: boolean;
  projectActions?: boolean;
  runtime?: BrowserRuntime;
  /** Called when a run settles, cancelled ones included; a recorded run shown with `REPLAY` is not one. */
  onRunSettled?: (settled: RunOutcome) => void;
  /** Offered when this browser cannot run projects, so they can be moved elsewhere. */
  onExportProjects?: () => void;
  /**
   * Written into the editor each time `version` changes, such as a guide step's files. The caller updates `project`
   * too.
   */
  fileOverride?: { version: number; files: Readonly<Record<string, string>> };
  /** Marks lines each time `version` changes. `reveal` also brings a phone to the code view. */
  highlight?: { version: number; file: string; startLine: number; endLine: number; reveal?: boolean };
  /** Shows the release without a way to change it, with this reason as its tooltip. */
  releaseLocked?: string;
  /** What the run button runs, after the word Run, such as "step 2". */
  runTarget?: string;
  /** Locks the editor; the text shows when someone types. */
  readOnly?: string;
  /** Takes over Run (button and shortcut), such as a guide that runs each step itself through `control`. */
  onRunRequest?: () => void;
  /** Keeps Run disabled and says why in its tooltip, such as on a guide step without a run. */
  runDisabled?: string;
  control?: Ref<ProjectControl>;
  /** A bar above the code, such as a guide's read-only note. */
  editorBar?: ReactNode;
  /** Marks what the shown run changed, such as since the guide's step before. */
  comparison?: OutputComparison;
  /** The display labels a guide step points at, scrolled to on the Results tab. */
  highlightedDisplays?: readonly string[];
  /**
   * The shown run's notes in the code: the playground's, a guide's (chips only, writes kept), or none, such as for
   * an earlier step's run. The embed's code has none.
   */
  runNotes?: RunNotesMode;
  /** A guide step's notes in the code, such as the lines it removes. */
  stepNotes?: readonly RunNote[];
  /** Hides the header's Run on phones, where the side panel has its own. */
  phoneHeaderRun?: boolean;
  /**
   * A panel beside the editor on desktop, named by `label`. On a phone it is the first view,
   * or with `sheet` a bottom sheet over the code and output.
   */
  aside?: {
    label: string;
    renderContent: (controls: AsideControls) => ReactNode;
    sheet?: boolean;
    collapsed?: boolean;
    railWidth?: RailWidth;
  };
  /** Offers "Duplicate": in the header's project actions box, or the more menu on a phone. */
  onDuplicate?: () => void;
  /** Offers "Fork as side by side…" in the more menu. */
  onForkSideBySide?: () => void;
  /**
   * Lends this view to the AI chat tools while it is open: a workspace project with its chat
   * dock, a guide or a shared link reading only.
   */
  connect?: ConnectViewOptions;
}

/** The one-version workspace: the editor, the output panel and the project's actions. */
export function ProjectView(props: ProjectViewProps) {
  const {
    project,
    saveState,
    leading,
    headerActions,
    fork,
    forkBeforeLeaving,
    banner,
    projectActions = true,
    onExportProjects,
    releaseLocked,
    runTarget,
    runDisabled,
    editorBar,
    comparison,
    highlightedDisplays,
    phoneHeaderRun = true,
    aside,
    onDuplicate,
    onForkSideBySide,
    connect,
  } = props;
  const workspace = useProjectWorkspace(props);
  const { phone, compact, selected, fileRoles, release, runOptions, unsupportedCapabilities, attachHost, editorReady } =
    workspace;
  const { dialect } = project.manifest.target;
  const showCapability = unsupportedCapabilities !== undefined;
  const docs = resolveProjectDocs(project.source);
  const desktopProject = projectActions && !compact && !phone;

  const fileTabs = (
    <FileTabs
      layout={phone ? "phone" : "header"}
      files={workspace.files}
      selected={selected}
      onSelect={workspace.chooseFile}
      onAdd={projectActions ? workspace.openCreate : undefined}
      pending={workspace.pendingPaths}
      errors={workspace.errorFiles}
      skipped={!fileRoles.seedOn && fileRoles.seedFileShown ? new Set([workspace.seedPath]) : undefined}
      trailing={
        fileRoles.helperSelected && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="File actions" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={workspace.openRename}>Rename file…</DropdownMenuItem>
              <DropdownMenuItem onClick={workspace.openDelete}>Delete file…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    />
  );

  const runButton = (
    <RunButton
      state={workspace.runButtonState}
      entrypoints={project.manifest.entrypoints}
      disabled={!workspace.canRun}
      disabledReason={runDisabled}
      target={runTarget}
      shortcut={!compact}
      onRun={workspace.startRun}
      onCancel={workspace.cancelRun}
    />
  );

  const headerButtons = (
    <>
      {headerActions}
      <ProjectActionsGroup>
        {docs && <ProjectDocsMenu docs={docs} />}
        {fork}
        {desktopProject && onDuplicate && <DuplicateButton onDuplicate={onDuplicate} />}
      </ProjectActionsGroup>
      {desktopProject && (
        <ShareButton shareStatus={workspace.shareStatus} onShare={workspace.openShare} onPush={workspace.openPush} />
      )}
      {workspace.chat && (
        <ChatToggle open={workspace.chatOpen} onToggle={() => workspace.setChatOpen(!workspace.chatOpen)} />
      )}
      {!compact && (
        <WorkspaceMoreMenu
          phone={phone}
          databaseLabel={DIALECTS[dialect].label}
          saveState={saveState}
          contentClassName="min-w-62"
          project={
            projectActions
              ? {
                  onShare: workspace.openShare,
                  onPush: workspace.shareStatus.status === "changed" ? workspace.openPush : undefined,
                  onDuplicate,
                  onForkSideBySide,
                  trust: connect?.trust,
                  seed: fileRoles.seedFileShown ? { on: fileRoles.seedOn, onToggle: workspace.toggleSeed } : undefined,
                }
              : undefined
          }
          runOptions={runOptions}
          release={{ locked: releaseLocked !== undefined, onOpen: () => release.setOpen(true) }}
          defaultFontSize={phone ? EDITOR_TEXT.phone.fontSize : EDITOR_TEXT.desktop.fontSize}
        />
      )}
    </>
  );

  const renderEditor = (filesBar: ReactNode) => (
    <section
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-code",
        (phone || compact) && "rounded-none border-0",
      )}
      aria-label="Editor"
    >
      {filesBar}
      {workspace.workspaceChat && <PendingRunBanner projectId={project.id} />}
      {workspace.workspaceChat && <PendingEditBanner projectId={project.id} />}
      {editorBar}
      {fileRoles.seedSelected && projectActions && <SeedBar on={fileRoles.seedOn} onToggle={workspace.toggleSeed} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={attachHost}
          className="min-h-0 w-full flex-1 pt-1.5"
          style={{ visibility: editorReady ? "visible" : "hidden" }}
        />
        {!editorReady && (
          <div
            className={cn("absolute inset-0 flex flex-col bg-code text-[13px] text-muted", compact && "gap-4.25 p-7")}
          >
            {compact ? (
              <pre className="flex-1 overflow-auto text-[13px]/6 whitespace-pre text-text">
                {project.manifest.files[selected]}
              </pre>
            ) : (
              <CodePreview code={project.manifest.files[selected] ?? ""} fontSize={workspace.codeFontSize} />
            )}
            {workspace.preparationFailed ? (
              <PreparationFailedDialog
                error={workspace.preparationError}
                note="Your files stay as they are."
                onRetry={workspace.retryPreparation}
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <WorkspaceLayout
      mode={workspace.mode}
      view={workspace.view}
      onRunShortcut={workspace.startRun}
      header={{
        leading: leading ?? <span className="max-w-65 truncate font-semibold">{project.name}</span>,
        actions: showCapability ? headerActions : headerButtons,
        run: showCapability ? undefined : runButton,
        phoneRun: phoneHeaderRun,
      }}
      fileTabs={fileTabs}
      banner={banner}
      blocked={
        unsupportedCapabilities && (
          <CapabilityMessage
            capabilities={unsupportedCapabilities}
            surface={compact ? "embed" : phone ? "phone" : "app"}
            linkToCopy={window.location.href}
            onExport={onExportProjects}
            onRetry={workspace.retryPreparation}
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
        shape: "split",
        renderEditor,
        badge: workspace.outputBadge,
        renderOutput: ({ stacked }) => (
          <RunProvider controller={workspace.execution}>
            <OutputPanel
              revision={project.revision}
              onDiagnostic={workspace.diagnostic}
              framed={!compact}
              comparison={comparison}
              highlightedDisplays={highlightedDisplays}
              runPicker={aside === undefined && !compact}
              views={compact ? embedViews : undefined}
              queryPlans={runOptions.plansSettings}
              chatRuns={workspace.chat !== undefined && workspace.chatOpen}
              settings={
                compact ? undefined : { flag: runOptions.queryPlans, dialect, onChange: runOptions.setQueryPlans }
              }
              tab={workspace.outputTab}
              onTabChange={workspace.setOutputTab}
              firstRun={{
                status: workspace.firstRunStatus,
                dialect,
                compact,
                stacked,
                onRun: workspace.startRun,
                canRun: workspace.canRun,
              }}
            />
          </RunProvider>
        ),
      }}
      chat={{ target: workspace.chat, open: workspace.chatOpen, onClose: () => workspace.setChatOpen(false) }}
      statusBar={
        <StatusBar
          databaseLabel={DIALECTS[dialect].label}
          release={
            <span className="flex shrink-0 items-center gap-1">
              <ReleasePicker
                readOnly={releaseLocked !== undefined}
                busy={release.switching}
                readOnlyReason={releaseLocked}
                target={release.target}
                current={release.current}
                files={release.files}
                onChange={release.switchRelease}
              />
              <LibrariesPopover target={release.target} current={release.current} />
            </span>
          }
          runtime={editorReady ? "ready" : workspace.unavailable ? "failed" : "preparing"}
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
      dialogs={
        <>
          {phone && (
            <ReleaseDialog
              open={release.open}
              onOpenChange={release.setOpen}
              target={release.target}
              current={release.current}
              files={release.files}
              onChange={release.switchRelease}
            />
          )}
          {workspace.shareDialog}
          <LeaveDialog blocker={workspace.leaveBlocker} onFork={forkBeforeLeaving} />
          {workspace.helperFileDialog}
        </>
      }
    />
  );
}
