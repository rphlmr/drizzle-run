/** The parts of a keyboard event the run shortcut reads. */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  target: unknown;
}

/**
 * Cmd+Enter or Ctrl+Enter runs the project from anywhere in the workspace.
 * Dialogs, popovers, and menus render in portals: React still bubbles their key
 * events to the workspace, but their DOM nodes sit outside it, so they keep the
 * keys for themselves.
 */
export function isRunShortcut(event: ShortcutEvent, workspace: { contains(node: unknown): boolean }): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && workspace.contains(event.target);
}

/** The Run button's hint, naming the files a run executes, in order. */
export function getRunTooltip(entrypoints: { run?: string; seed?: string }, shortcut: string): string {
  if (entrypoints.run === undefined) {
    return "No file is set to run";
  }

  const files = entrypoints.seed === undefined ? entrypoints.run : `${entrypoints.seed}, then ${entrypoints.run}`;

  return `Run ${files} · ${shortcut}`;
}
