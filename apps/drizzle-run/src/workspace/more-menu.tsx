import { MoreHorizontalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { TrustMenuItem } from "../connect/chat-panel";
import type { ProjectTrustControls } from "../connect/connect-provider";
import { cn } from "../lib/utils";
import { CreditsDialog } from "../ui/credits-dialog";
import { EditorFontSizeMenuItems } from "../ui/editor-font-size-menu-items";
import { Hint } from "../ui/hint";
import { SidesIcon } from "../ui/icons";
import { AUTHOR_HREF, ISSUES_HREF, SOURCE_HREF } from "../ui/project-links";
import { isApplePlatform } from "../ui/run-button";
import { ThemeMenuItems } from "../ui/theme-menu-items";
import { applyFormatOnRun, useFormatOnRun } from "./format-on-run-setting";
import { applyRunNotesShown, useRunNotesShown } from "./run-notes-setting";
import { saveStateLabels, type SaveState } from "./save-state";
import type { RunOptionsControls } from "./use-run-options";

/** The Project group of the more menu: what the user can do with the project as a whole. */
export interface ProjectMenuActions {
  /** Opens Share; the group offers it on phones, where the header has no Share button. */
  onShare: () => void;
  /** Phones only: pushes the changes, once the project changed since what its link shows. */
  onPush?: () => void;
  /** Phones only: the desktop header has Duplicate in its project actions box. */
  onDuplicate?: () => void;
  /** "Disable seed execution", or "Enable seed execution" while it is off; only when the project has a seed. */
  seed?: { on: boolean; onToggle: () => void };
  /** Offers "Fork as side by side…", for a one-version project. */
  onForkSideBySide?: () => void;
  /** Someone else's project: "Allow AI edits" or its undo. */
  trust?: ProjectTrustControls;
}

export interface WorkspaceMoreMenuProps {
  phone: boolean;
  /** The database the phone menu names, such as "PostgreSQL vs SQLite" beside two sides. */
  databaseLabel: string;
  saveState: SaveState;
  /** A tooltip on the trigger, saying what the menu holds beyond the shared groups. */
  hint?: string;
  contentClassName?: string;
  /** Items before the Project group, such as Cancel run, each with its separator. */
  leadingItems?: ReactNode;
  /** The Project group's actions; undefined without project actions, such as on a shared snapshot. */
  project: ProjectMenuActions | undefined;
  /** Groups after the Project group, such as a side-by-side project's Sides, each with its separator. */
  projectItems?: ReactNode;
  runOptions: RunOptionsControls;
  /** The phone menu's "Drizzle release…", for a project on one release; `locked` greys it out. */
  release?: { locked: boolean; onOpen: () => void };
  /** The editor's text size before the user picks one, for the font size items. */
  defaultFontSize: number;
}

/**
 * Keep the menu open when toggling Debug so other settings remain available.
 */
function DebugMenuItem({ runOptions }: { runOptions: RunOptionsControls }) {
  return (
    <DropdownMenuCheckboxItem
      checked={runOptions.debug}
      onCheckedChange={runOptions.setDebug}
      closeOnClick={false}
      title="A report about this playground's own run"
      className="pl-2.5 [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
    >
      Debug
      <span
        className={cn(
          "relative ml-auto inline-flex h-4.5 w-7.75 shrink-0 rounded-full bg-border",
          runOptions.debug && "bg-segment",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-3.5 rounded-full bg-surface shadow-[0_0_0_1px_var(--border)] transition-transform duration-150",
            runOptions.debug && "translate-x-3.25",
          )}
        />
      </span>
    </DropdownMenuCheckboxItem>
  );
}

function formatOpenFiles() {
  void import("../editor/format").then(({ formatOpenEditors }) => formatOpenEditors());
}

/**
 * Formats the open files with Prettier, as Format Document does in the editor, and says whether Run does it first
 *
 * A read-only editor, such as a guide's while it runs, is left as it is. The toggle stays open on a click.
 */
function FormatCodeMenuItems() {
  const formatOnRun = useFormatOnRun();

  return (
    <DropdownMenuGroup>
      <DropdownMenuItem onClick={formatOpenFiles}>
        Format code
        <span className="ml-auto pl-3 text-[12px] text-muted">
          {isApplePlatform() ? "Shift Option F" : "Shift Alt F"}
        </span>
      </DropdownMenuItem>
      <DropdownMenuCheckboxItem
        checked={formatOnRun}
        onCheckedChange={applyFormatOnRun}
        closeOnClick={false}
        title="Run formats every file with Prettier before it runs"
      >
        Format on run
      </DropdownMenuCheckboxItem>
    </DropdownMenuGroup>
  );
}

/** Whether runs leave their transaction chips in the code. Stays open on a toggle. */
function RunNotesMenuItem() {
  const shown = useRunNotesShown();

  return (
    <DropdownMenuGroup>
      <DropdownMenuCheckboxItem
        checked={shown}
        onCheckedChange={applyRunNotesShown}
        closeOnClick={false}
        title="How each transaction ended, after the line that opened it"
      >
        Run notes in code
      </DropdownMenuCheckboxItem>
    </DropdownMenuGroup>
  );
}

/**
 * Project settings and actions in the header's More menu
 *
 * On every screen: the seed toggle, Fork as side by side, Debug, Format code and Format on run, the theme, the code font size and the run
 * notes toggle. On phones, which have no status bar or header actions, it also says the database and save state, and holds
 * Share, Duplicate, the release picker and the credits. The view adds its own items through `leadingItems` and
 * `projectItems`.
 */
export function WorkspaceMoreMenu({
  phone,
  databaseLabel,
  saveState,
  hint,
  contentClassName,
  leadingItems,
  project,
  projectItems,
  runOptions,
  release,
  defaultFontSize,
}: WorkspaceMoreMenuProps) {
  const [creditsOpen, setCreditsOpen] = useState(false);
  const publishPending = phone && project?.onPush !== undefined;
  const trigger = (
    <DropdownMenuTrigger
      render={
        <Button
          variant="outline"
          size="icon"
          className="relative"
          aria-label={publishPending ? "More actions, unpublished changes" : "More actions"}
        />
      }
    >
      <MoreHorizontalIcon />
      {publishPending && (
        <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-1.75 rounded-full bg-warn" />
      )}
    </DropdownMenuTrigger>
  );

  return (
    <>
      <DropdownMenu>
        {hint === undefined ? trigger : <Hint content={hint}>{trigger}</Hint>}
        <DropdownMenuContent align="end" className={contentClassName}>
          {phone && (
            <>
              {/* Base UI labels need a group around them. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {databaseLabel} · {saveStateLabels[saveState]}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {leadingItems}
          <ProjectMenuGroup phone={phone} actions={project} runOptions={runOptions} />
          {projectItems}
          {phone && release && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={release.locked} onClick={release.onOpen}>
                  Drizzle release…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <FormatCodeMenuItems />
          <DropdownMenuSeparator />
          <ThemeMenuItems />
          <DropdownMenuSeparator />
          <EditorFontSizeMenuItems defaultFontSize={defaultFontSize} />
          <DropdownMenuSeparator />
          <RunNotesMenuItem />
          {phone && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>About</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setCreditsOpen(true)}>What we use</DropdownMenuItem>
                <DropdownMenuItem
                  render={
                    <a href={SOURCE_HREF} target="_blank" rel="noopener noreferrer">
                      GitHub
                    </a>
                  }
                />
                <DropdownMenuItem
                  render={
                    <a href={ISSUES_HREF} target="_blank" rel="noopener noreferrer">
                      Report an issue
                    </a>
                  }
                />
                <DropdownMenuItem
                  render={
                    <a href={AUTHOR_HREF} target="_blank" rel="noopener noreferrer">
                      @rphlmr
                    </a>
                  }
                />
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {phone && <CreditsDialog open={creditsOpen} onOpenChange={setCreditsOpen} />}
    </>
  );
}

interface ProjectMenuGroupProps {
  phone: boolean;
  actions: ProjectMenuActions | undefined;
  runOptions: RunOptionsControls;
}

/** The project's own items, then Debug, with their separator; phones add Share and Duplicate first. */
function ProjectMenuGroup({ phone, actions, runOptions }: ProjectMenuGroupProps) {
  return (
    <>
      <DropdownMenuGroup>
        {phone && actions && <DropdownMenuItem onClick={actions.onShare}>Share…</DropdownMenuItem>}
        {phone && actions?.onPush && <DropdownMenuItem onClick={actions.onPush}>Push changes…</DropdownMenuItem>}
        {phone && actions?.onDuplicate && <DropdownMenuItem onClick={actions.onDuplicate}>Duplicate</DropdownMenuItem>}
        {actions?.seed && (
          <DropdownMenuItem onClick={actions.seed.onToggle}>
            {actions.seed.on ? "Disable seed execution" : "Enable seed execution"}
          </DropdownMenuItem>
        )}
        {actions?.onForkSideBySide && (
          <DropdownMenuItem onClick={actions.onForkSideBySide}>
            <SidesIcon className="size-3.5 text-accent-text" />
            Fork as side by side…
          </DropdownMenuItem>
        )}
        {actions?.trust && <TrustMenuItem trust={actions.trust} />}
        <DebugMenuItem runOptions={runOptions} />
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}
