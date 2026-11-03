import type { AgentTuning, ChatContextEntry, ChatProject, CompanionInfo } from "@drizzle-run/core/connect";
import {
  AGENT_NAMES,
  connectCommand,
  type AgentId,
  type ChatMode,
  type ConnectToolScope,
} from "@drizzle-run/core/connect";
import {
  connectQuota,
  connectStatus,
  createConnectMachine,
  workingTurn,
  type ConnectActivity,
  type ConnectMachine,
  type ConnectOpenProject,
  type ConnectPairing,
  type ConnectServices,
  type ConnectQuota,
  type ConnectStatus,
  type PendingEdit,
  type PendingRun,
} from "@drizzle-run/runtime/machines";
import { useActorRef, useSelector } from "@xstate/react";
import { isEqual } from "es-toolkit";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Actor } from "xstate";
import * as z from "zod/mini";

import { useAppServices } from "../app-services";
import type { ProjectRecord, ProjectTrust } from "../project/projects";
import type { ConnectSettingStore } from "../store/storage";
import type { ConnectGuide } from "./guide-tools";
import { PENDING_EDITS_SETTING, readPendingEdits } from "./pending-edits";
import { createConnectTools, type ConnectHost } from "./tools";

/**
 * The AI chat link for the whole app but embeds: one connect machine per tab, which every
 * page shares, shared links included. A project view lends itself as the tools' host while
 * it is open, so the tools follow the open project; the workspace lends its projects through
 * `useConnectWorkspace`. The chat panel reads it through `useConnect`.
 */

export const PAIRING_SETTING = "connect.pairing";

/** Opt-in for tests and debugging: exposes the connect API on `window.__drizzleRunConnect`. */
export const CONNECT_DEBUG_KEY = "drizzle-run:connect-debug";

/** How a view lends itself to the AI chat. */
export interface ConnectViewOptions {
  /** The tools it offers: `guide`, `snapshot` and `untrusted` read only. */
  scope: ConnectToolScope;
  /** Someone else's project in the workspace: the user's trust acts, from the chat note and the project menu. */
  trust?: ProjectTrustControls;
  /** A shared link: saves an untrusted copy without leaving it, for `fork_project`. */
  fork?: (name: string) => Promise<ProjectRecord>;
  /** A guided view: the guide and the learner's step, for `get_guide` and `read_docs`. */
  guide?: () => ConnectGuide | undefined;
  /** The chat behind the header's Ask AI button and the dock: a project's, or a guide's. */
  conversation?: string;
  /** A guide's chat: the learner's place, under the composer ("Step 2 of 3 · Transactions"). */
  position?: string;
}

/** The user's trust acts on someone else's project. Only the user calls them: no tool reaches them. */
export interface ProjectTrustControls {
  state: ProjectTrust;
  /** Asks the user to confirm, then trusts the project. */
  requestTrust: () => void;
  untrust: () => void;
}

/** The workspace's projects as the Connect tools reach them. */
export interface ConnectWorkspaceBinding {
  projects(): readonly ProjectRecord[];
  update(project: ProjectRecord): void;
  /** Adds a project without opening it, and settles once another tab can open it. */
  create(project: ProjectRecord): Promise<void>;
}

/** Outside the workspace (a shared link) there are no projects to list, change, or create. */
const NO_WORKSPACE: ConnectWorkspaceBinding = {
  projects: () => [],
  update: () => {
    throw new Error("Open the workspace to change a project.");
  },
  create: () => Promise.reject(new Error("Open the workspace to create a project.")),
};

interface ConnectRuntime {
  actor: Actor<ConnectMachine>;
  register(host: ConnectHost): () => void;
  lendWorkspace(workspace: ConnectWorkspaceBinding): () => void;
  /** Where chats keep their history in this browser. */
  settings: ConnectSettingStore;
}

const ConnectRuntimeContext = createContext<ConnectRuntime | undefined>(undefined);

const ConnectPairingSchema = z.object({
  secret: z.string(),
  pairedAt: z.string(),
  confirmedAt: z.optional(z.string()),
}) satisfies z.ZodMiniType<ConnectPairing>;

/** The project a view shows, as the connect machine checks calls against it; none while the view closes. */
function describeOpenProject(host: ConnectHost | undefined): ConnectOpenProject | undefined {
  try {
    const project = host?.project();

    return project && { id: project.id, name: project.name, ...(project.origin ? { origin: project.origin } : {}) };
  } catch {
    return undefined;
  }
}

/** The tab's room socket: same origin as the page, so the relay's origin check passes. */
export function getTabRoomUrl(location: Pick<Location, "protocol" | "host">, roomId: string): string {
  return `${location.protocol === "http:" ? "ws:" : "wss:"}//${location.host}/api/connect/rooms/${roomId}?role=tab`;
}

/** What the Connect machine's services read: the settings store, the tools, and the open view. */
export interface ConnectServicesDependencies {
  settings: ConnectSettingStore;
  tools: ReturnType<typeof createConnectTools>;
  /** The tools the open view offers; `project` when it says nothing. */
  toolScope?: () => ConnectToolScope;
  openProject?: () => ConnectOpenProject | undefined;
}

/** The Connect machine's services: the pairing in settings, the room socket, and the tools it runs. */
export function connectServices({
  settings,
  tools,
  toolScope = () => "project",
  openProject = () => undefined,
}: ConnectServicesDependencies): ConnectServices {
  const knownEdits = new Set<string>();

  return {
    loadPairing: async () => {
      const pairing = ConnectPairingSchema.safeParse(await settings.readSetting(PAIRING_SETTING));

      return pairing.success ? pairing.data : undefined;
    },
    savePairing: (pairing) => settings.writeSetting(PAIRING_SETTING, pairing),
    clearPairing: () => settings.writeSetting(PAIRING_SETTING, null),
    roomUrl: (roomId) => getTabRoomUrl(window.location, roomId),
    openSocket: (url, handlers, protocols) => {
      const socket = new WebSocket(url, [...protocols]);

      socket.addEventListener("open", () => handlers.open());
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          handlers.message(event.data);
        }
      });
      socket.addEventListener("close", (event) => handlers.close(event.code, event.reason));

      return socket;
    },
    executeTool: (request, signal) => tools.execute(request, signal),
    undoEdit: (edit) => tools.undo(edit),
    toolScope,
    openProject,
    loadPendingEdits: async () => {
      const edits = readPendingEdits(await settings.readSetting(PENDING_EDITS_SETTING));

      for (const edit of edits) {
        knownEdits.add(edit.id);
      }

      return edits;
    },
    savePendingEdits: async (edits) => {
      const knownIds = [...knownEdits];

      await settings.mergePendingEdits(edits, knownIds);

      for (const edit of edits) {
        knownEdits.add(edit.id);
      }
    },
  };
}

/**
 * What the mounted views lend the tools: the project views, newest last, and the workspace. Each lend returns the
 * function that takes it back.
 */
function createConnectLends() {
  let hosts: readonly ConnectHost[] = [];
  let workspace = NO_WORKSPACE;

  return {
    getHost: () => hosts.at(-1),
    lendHost: (host: ConnectHost) => {
      hosts = [...hosts, host];

      return () => {
        hosts = hosts.filter((item) => item !== host);
      };
    },
    getWorkspace: () => workspace,
    lendWorkspace: (lent: ConnectWorkspaceBinding) => {
      workspace = lent;

      return () => {
        if (workspace === lent) {
          workspace = NO_WORKSPACE;
        }
      };
    },
  };
}

/** Owns the Connect machine for the app, so every project view and chat shares one companion link. */
export function ConnectProvider({ settings, children }: { settings: ConnectSettingStore; children: ReactNode }) {
  const [lends] = useState(createConnectLends);
  const { fetchDocs } = useAppServices();

  const machine = useMemo(() => {
    const tools = createConnectTools({
      host: () => lends.getHost(),
      projects: () => lends.getWorkspace().projects(),
      update: (project) => lends.getWorkspace().update(project),
      create: (project) => lends.getWorkspace().create(project),
      projectUrl: (projectId) => new URL(`/p/${encodeURIComponent(projectId)}`, window.location.origin).href,
      fetchText: fetchDocs,
    });

    return createConnectMachine(
      connectServices({
        settings,
        tools,
        toolScope: () => lends.getHost()?.scope ?? "project",
        openProject: () => describeOpenProject(lends.getHost()),
      }),
    );
  }, [fetchDocs, lends, settings]);
  const actor = useActorRef(machine);
  useEffect(() => {
    const activate = () => {
      if (document.visibilityState === "visible") {
        actor.send({ type: "tab.activate" });
      }
    };

    activate();
    window.addEventListener("focus", activate);
    document.addEventListener("visibilitychange", activate);

    return () => {
      window.removeEventListener("focus", activate);
      document.removeEventListener("visibilitychange", activate);
    };
  }, [actor]);

  const runtime = useMemo<ConnectRuntime>(
    () => ({
      actor,
      register: (host) => {
        const takeBack = lends.lendHost(host);
        actor.send({ type: "view.changed" });

        return () => {
          takeBack();
          actor.send({ type: "view.changed" });
        };
      },
      lendWorkspace: (workspace) => lends.lendWorkspace(workspace),
      settings,
    }),
    [actor, lends, settings],
  );

  useConnectDebugHook(actor, () => describeOpenProject(lends.getHost()));

  return <ConnectRuntimeContext.Provider value={runtime}>{children}</ConnectRuntimeContext.Provider>;
}

/**
 * Lends the calling project view to the tools while it is mounted. `build` runs on each
 * call, so the tools always read the view's latest state. Outside a provider it does nothing.
 * A guided view passes `guide` and the `guide` scope; a shared link passes `snapshot`.
 */
export function useConnectHost(build: (() => ConnectHost) | undefined): void {
  const runtime = useContext(ConnectRuntimeContext);
  const readBuild = useEffectEvent(() => build);
  const enabled = build !== undefined;

  useEffect(() => {
    if (runtime === undefined || !enabled) {
      return;
    }

    const current = () => {
      const make = readBuild();

      if (make === undefined) {
        throw new Error("The project view is closing.");
      }

      return make();
    };

    return runtime.register({
      project: () => current().project(),
      save: (project) => current().save(project),
      problems: () => current().problems(),
      latestRun: (side) => current().latestRun(side),
      run: () => current().run(),
      running: () => current().running(),
      get queryPlans() {
        return readBuild()?.().queryPlans;
      },
      get scope() {
        return readBuild()?.().scope;
      },
      guide: () => readBuild()?.().guide?.(),
      fork: (name) => {
        const fork = readBuild()?.().fork;

        return fork === undefined ? Promise.reject(new Error("This view has no fork of its own.")) : fork(name);
      },
      get canFork() {
        return readBuild()?.().fork !== undefined;
      },
    });
  }, [runtime, enabled]);
}

/** Lends the workspace's projects to the tools while it is mounted; `build` runs on each call. */
export function useConnectWorkspace(build: () => ConnectWorkspaceBinding): void {
  const runtime = useContext(ConnectRuntimeContext);
  const readWorkspace = useEffectEvent(() => build());

  useEffect(() => {
    if (runtime === undefined) {
      return;
    }

    return runtime.lendWorkspace({
      projects: () => readWorkspace().projects(),
      update: (project) => readWorkspace().update(project),
      create: (project) => readWorkspace().create(project),
    });
  }, [runtime]);
}

/** The settings store chats keep their history in. */
export function useConnectSettings(): ConnectSettingStore {
  const runtime = useContext(ConnectRuntimeContext);

  if (runtime === undefined) {
    throw new Error("useConnectSettings needs a ConnectProvider.");
  }

  return runtime.settings;
}

/** Whether the AI chat link exists here: embeds have none. */
export function useConnectAvailable(): boolean {
  return useContext(ConnectRuntimeContext) !== undefined;
}

const NO_EDITS: readonly PendingEdit[] = [];

function unsubscribeNothing() {
  return () => undefined;
}

/** The edits waiting for Keep or Undo, or none outside a provider. */
export function usePendingEdits(): readonly PendingEdit[] {
  const runtime = useContext(ConnectRuntimeContext);
  const actor = runtime?.actor;
  const subscribe = useMemo(
    () =>
      actor === undefined
        ? unsubscribeNothing
        : (listener: () => void) => {
            const subscription = actor.subscribe(listener);
            return () => subscription.unsubscribe();
          },
    [actor],
  );

  return useSyncExternalStore(subscribe, () => actor?.getSnapshot().context.pendingEdits ?? NO_EDITS);
}

const NO_RUNS: readonly PendingRun[] = [];

/** Agent runs of a community project waiting for the user, or none outside a provider. */
export function usePendingRuns(): readonly PendingRun[] {
  const runtime = useContext(ConnectRuntimeContext);
  const actor = runtime?.actor;
  const subscribe = useMemo(
    () =>
      actor === undefined
        ? unsubscribeNothing
        : (listener: () => void) => {
            const subscription = actor.subscribe(listener);
            return () => subscription.unsubscribe();
          },
    [actor],
  );

  return useSyncExternalStore(subscribe, () => actor?.getSnapshot().context.pendingRuns ?? NO_RUNS);
}

/** The agent connected to this tab, by name, or none: unlinked, or outside a provider. */
export function useConnectedAgent(): string | undefined {
  const runtime = useContext(ConnectRuntimeContext);
  const actor = runtime?.actor;
  const subscribe = useMemo(
    () =>
      actor === undefined
        ? unsubscribeNothing
        : (listener: () => void) => {
            const subscription = actor.subscribe(listener);
            return () => subscription.unsubscribe();
          },
    [actor],
  );

  return useSyncExternalStore(subscribe, () => {
    const status = actor === undefined ? undefined : connectStatus(actor.getSnapshot());

    if (status?.kind === "ready") {
      return AGENT_NAMES[status.agent];
    }

    if (status?.kind === "terminal") {
      return status.companion.agent === undefined ? "Terminal agent" : AGENT_NAMES[status.companion.agent];
    }

    return undefined;
  });
}

/** The typed API the chat panel builds on. */
export interface ConnectApi {
  status: ConnectStatus;
  /** This tab's share of today's AI chat, once the relay told it. */
  quota: ConnectQuota | undefined;
  companion: CompanionInfo | undefined;
  mode: ChatMode;
  /** User messages, streamed agent text, turns, and tool rows, oldest first. */
  activity: readonly ConnectActivity[];
  pendingEdits: readonly PendingEdit[];
  /** Agent runs of a community project waiting for the user. */
  pendingRuns: readonly PendingRun[];
  /** The command to show: with the secret while pairing, without it to rejoin. */
  command: string | undefined;
  /**
   * This tab's companion commands: rejoin, a terminal agent's `--mcp`, and an update. On a local server they run the
   * checkout's build.
   */
  commands: CompanionCommands;
  /** The turn the agent is working on in a chat, if any. */
  working(conversation: string): string | undefined;
  /** Makes a link code: the first one, or a new one after a failure or a Forget. */
  pair: () => void;
  forget: () => void;
  /** Closes this tab's link and keeps the pairing; `retry` connects again. */
  disconnect: () => void;
  retry: () => void;
  chooseAgent: (agent: AgentId) => void;
  /** Sets a chat's mode; the machine keeps it for that chat's turns. */
  setMode: (mode: ChatMode, conversation: string) => void;
  /**
   * `scope` is the chat's view: a guided chat sends `guide`, always in Ask mode. `tuning` is the chat's agent, model
   * and effort; without it, the companion's agent on the CLI's defaults. `context` is the chat so far, which the
   * companion gives only to an agent session that starts without it.
   */
  send(
    conversation: string,
    text: string,
    options?: {
      project?: ChatProject;
      scope?: ConnectToolScope;
      tuning?: AgentTuning & { agent?: AgentId };
      context?: readonly ChatContextEntry[];
    },
  ): void;
  stop(conversation: string): void;
  keep: (editId: string) => void;
  undo: (editId: string) => void;
  /** Runs, or does not run, a community project an agent asked to run. */
  confirmRun: (runId: string) => void;
  declineRun: (runId: string) => void;
  /** Why the last Undo of a pending edit was refused, such as a file changed since. */
  undoError: (editId: string) => string | undefined;
  /**
   * Where a pending edit's Undo is: waiting behind another job ("queued", Keep still cancels it), putting files back
   * ("running"), or not asked for.
   */
  undoState: (editId: string) => "queued" | "running" | undefined;
  /**
   * For the events it emits, such as `edit.pending` and `pairing.forgotten`.
   */
  actor: Actor<ConnectMachine>;
}

/** The terminal commands the panel shows to rejoin, add the MCP server, or update the companion. */
export interface CompanionCommands {
  rejoin: string;
  mcp: string;
  update: string;
}

// Set by .github/workflows to the companion published to pkg.pr.new from the same commit. An empty value means the npm
// release.
const companionPackage = import.meta.env.VITE_CONNECT_PACKAGE;
const companionPackageCommand = companionPackage ? `npx ${companionPackage}` : undefined;

function getCompanionCommands(origin: string): CompanionCommands {
  return {
    rejoin: connectCommand({ origin, packageCommand: companionPackageCommand }),
    mcp: connectCommand({ origin, mcp: true, packageCommand: companionPackageCommand }),
    update: connectCommand({ origin, latest: true, packageCommand: companionPackageCommand }),
  };
}

function getCompanionCommand(status: ConnectStatus, origin: string) {
  if (status.kind === "pairing") {
    return connectCommand({ secret: status.secret, origin, packageCommand: companionPackageCommand });
  }

  if (status.kind === "waiting" || status.kind === "disconnected") {
    return connectCommand({ origin, packageCommand: companionPackageCommand });
  }

  return undefined;
}

/** The Connect status and actions; throws outside a `ConnectProvider`. */
export function useConnect(): ConnectApi {
  const runtime = useContext(ConnectRuntimeContext);

  if (runtime === undefined) {
    throw new Error("useConnect needs a ConnectProvider.");
  }

  const { actor } = runtime;
  const status = useSelector(actor, connectStatus, isEqual);
  const quota = useSelector(actor, connectQuota, isEqual);
  const companion = useSelector(actor, (snapshot) => snapshot.context.companion);
  const mode = useSelector(actor, (snapshot) => snapshot.context.mode);
  const activity = useSelector(actor, (snapshot) => snapshot.context.activity);
  const pendingEdits = useSelector(actor, (snapshot) => snapshot.context.pendingEdits);
  const pendingRuns = useSelector(actor, (snapshot) => snapshot.context.pendingRuns);
  const queuedUndos = useSelector(actor, (snapshot) => snapshot.context.queuedUndos);
  const runningUndo = useSelector(actor, (snapshot) => snapshot.context.runningUndo);
  const undoErrors = useSelector(actor, (snapshot) => snapshot.context.undoErrors);

  return {
    status,
    quota,
    companion,
    mode,
    activity,
    pendingEdits,
    pendingRuns,
    command: getCompanionCommand(status, window.location.origin),
    commands: getCompanionCommands(window.location.origin),
    working: (conversation) => workingTurn(activity, conversation),
    pair: () => actor.send({ type: "pairing.create" }),
    forget: () => actor.send({ type: "pairing.forget" }),
    disconnect: () => actor.send({ type: "link.disconnect" }),
    retry: () => actor.send({ type: "link.retry" }),
    chooseAgent: (agent) => actor.send({ type: "chat.agent.choose", agent }),
    setMode: (next, conversation) => actor.send({ type: "chat.mode.set", mode: next, conversation }),
    send: (conversation, text, options = {}) =>
      actor.send({
        type: "chat.message.send",
        conversation,
        text,
        ...(options.project ? { project: options.project } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.tuning?.agent ? { agent: options.tuning.agent } : {}),
        ...(options.tuning
          ? {
              tuning: {
                ...(options.tuning.model === undefined ? {} : { model: options.tuning.model }),
                ...(options.tuning.effort === undefined ? {} : { effort: options.tuning.effort }),
              },
            }
          : {}),
        ...(options.context ? { context: options.context } : {}),
      }),
    stop: (conversation) => actor.send({ type: "chat.turn.stop", conversation }),
    keep: (id) => actor.send({ type: "edit.keep", id }),
    undo: (id) => actor.send({ type: "edit.undo", id }),
    confirmRun: (id) => actor.send({ type: "run.confirm", id }),
    declineRun: (id) => actor.send({ type: "run.decline", id }),
    undoError: (id) => undoErrors[id],
    undoState: (id) => (runningUndo === id ? "running" : queuedUndos.includes(id) ? "queued" : undefined),
    actor,
  };
}

function readDebugFlag(): boolean {
  try {
    return window.localStorage.getItem(CONNECT_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    __drizzleRunConnect?: {
      status(): ConnectStatus;
      command(): string | undefined;
      context(): {
        mode: ChatMode;
        pendingEdits: readonly PendingEdit[];
        pendingRuns: readonly PendingRun[];
        activity: readonly ConnectActivity[];
      };
      /** The project the tools act on now. */
      openProject(): ConnectOpenProject | undefined;
      send(event: Parameters<Actor<ConnectMachine>["send"]>[0]): void;
    };
  }
}

/** Test hook, off unless this browser opted in through localStorage. */
function useConnectDebugHook(actor: Actor<ConnectMachine>, openProject: () => ConnectOpenProject | undefined): void {
  const readOpenProject = useEffectEvent(openProject);

  useEffect(() => {
    if (!readDebugFlag()) {
      return;
    }

    window.__drizzleRunConnect = {
      status: () => connectStatus(actor.getSnapshot()),
      command: () => getCompanionCommand(connectStatus(actor.getSnapshot()), window.location.origin),
      context: () => {
        const { mode, pendingEdits, pendingRuns, activity } = actor.getSnapshot().context;
        return { mode, pendingEdits, pendingRuns, activity };
      },
      openProject: () => readOpenProject(),
      send: (event) => actor.send(event),
    };

    return () => {
      delete window.__drizzleRunConnect;
    };
  }, [actor]);
}
