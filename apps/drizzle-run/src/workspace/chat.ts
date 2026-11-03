import type { ChatProject } from "@drizzle-run/core/connect";

import type { ChatTarget } from "../connect/chat-panel";
import type { ConnectViewOptions } from "../connect/connect-provider";
import type { ConnectHost } from "../connect/tools";
import type { ProjectRecord } from "../project/projects";

/** The project as a chat turn names it; a side-by-side project also names both sides. */
export function toChatProject(project: ProjectRecord, sides?: ChatProject["sides"]): ChatProject {
  return {
    id: project.id,
    name: project.name,
    ...(project.origin ? { origin: project.origin } : {}),
    ...(sides ? { sides } : {}),
  };
}

/** A workspace project's chat, trusted or not: the pending run and edit banners show for both. */
export function isWorkspaceChat(connect: ConnectViewOptions | undefined): boolean {
  return connect?.scope === "project" || connect?.scope === "untrusted";
}

/**
 * The chat dock's target, or undefined without one
 *
 * A view with a conversation has a dock while `shown`: the view decides, since the dock is desktop only and has no
 * place beside a capability message. An untrusted project's dock asks for trust; a guide's says the learner's place.
 */
export function getChatTarget({
  connect,
  project,
  files,
  shown,
}: {
  connect: ConnectViewOptions | undefined;
  project: ChatProject;
  files: readonly string[];
  shown: boolean;
}): ChatTarget | undefined {
  if (connect?.conversation === undefined || !shown) {
    return undefined;
  }

  return {
    conversation: connect.conversation,
    project,
    files,
    scope: connect.scope,
    ...(connect.trust?.state === "untrusted" ? { onTrust: connect.trust.requestTrust } : {}),
    ...(connect.scope === "guide" ? { guided: { position: connect.position ?? project.name } } : {}),
  };
}

/** What a project view lends the AI chat tools besides its view options and run options. */
export type ViewConnectHost = Pick<ConnectHost, "project" | "save" | "problems" | "latestRun" | "run" | "running">;

/** The host a project view lends the tools: its view options, its own calls, and its Query plans flag. */
export function toConnectHost(
  connect: ConnectViewOptions,
  view: ViewConnectHost,
  queryPlans: ConnectHost["queryPlans"],
): ConnectHost {
  return {
    scope: connect.scope,
    guide: connect.guide,
    ...(connect.fork ? { fork: connect.fork } : {}),
    ...view,
    queryPlans,
  };
}
