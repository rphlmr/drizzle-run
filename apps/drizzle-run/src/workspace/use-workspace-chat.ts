import type { ChatProject } from "@drizzle-run/core/connect";

import { useChatOpen, usePendingPaths } from "../connect/chat-panel";
import { useConnectHost, type ConnectViewOptions } from "../connect/connect-provider";
import { getChatTarget, isWorkspaceChat, toConnectHost, type ViewConnectHost } from "./chat";
import type { RunOptionsControls } from "./use-run-options";

/** Options of `useWorkspaceChat`. */
export interface UseWorkspaceChatOptions {
  connect: ConnectViewOptions | undefined;
  project: ChatProject;
  /** The files the agent sees. */
  files: readonly string[];
  /** Whether the view has room for the dock now. */
  shown: boolean;
}

/** The chat dock of a project view: its target, whether it is open, and the files with pending AI edits. */
export function useWorkspaceChat({ connect, project, files, shown }: UseWorkspaceChatOptions) {
  const [chatOpen, setChatOpen] = useChatOpen();
  const pendingPaths = usePendingPaths(project.id);

  return {
    chat: getChatTarget({ connect, project, files, shown }),
    chatOpen,
    setChatOpen,
    pendingPaths,
    workspaceChat: isWorkspaceChat(connect),
  };
}

/**
 * Lend a project view to the AI chat tools while it is open
 *
 * Only with `connect`; `build` runs on each tool call, so the tools read the view's latest state.
 */
export function useWorkspaceConnectHost({
  connect,
  runOptions,
  build,
}: {
  connect: ConnectViewOptions | undefined;
  runOptions: RunOptionsControls;
  build: () => ViewConnectHost;
}): void {
  useConnectHost(connect ? () => toConnectHost(connect, build(), runOptions.connectQueryPlans) : undefined);
}
