import type {
  AgentEffort,
  AgentId,
  AgentModel,
  AgentTuning,
  CompanionAgent,
  ConnectToolScope,
} from "@drizzle-run/core/connect";

/**
 * What an agent CLI plugin provides, and what the companion gives it.
 *
 * Each supported CLI (Claude Code, Codex, Grok) is one plugin in `agents/<id>.ts`. A plugin owns everything that
 * differs between CLIs: the options that lock it down to the Drizzle Run tools, the check that its version still
 * has them, the models it offers, how a turn starts, and how its output reads. The companion only runs turns and
 * forwards tool calls, the same way for every CLI.
 */

/** The name the agents know the Drizzle Run MCP server by. */
export const MCP_SERVER_NAME = "drizzle-run";

/** The MCP server a turn starts: this package, talking to its companion over a private socket. */
export interface McpLaunch {
  command: string;
  args: readonly string[];
}

/** A finished command. `status` is `null` when it could not start or was killed. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion. Never rejects. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;

/** A model and effort a chat may start on. */
export interface AgentDefault {
  model: string;
  effort?: AgentEffort;
}

/** The models and effort levels an agent offers a chat, and the ones a chat starts on. */
export interface AgentChoices {
  models: readonly AgentModel[];
  /**
   * What a chat starts on, best first: the first whose model the account has. The last must work on every plan,
   * since it is also the choice when the account's models cannot be read.
   */
  defaults: readonly [AgentDefault, ...AgentDefault[]];
}

/** One turn of a chat, as a plugin needs it to start the CLI. */
export interface TurnSpec {
  /** The CLI's session: one the companion named, or the one the CLI reported. Unset before a CLI names its own. */
  session?: string;
  /** Whether this turn starts the session. */
  first: boolean;
  /** The companion's instructions for the agent. */
  system: string;
  /** The user's message, with the turn's header. */
  prompt: string;
  mcp: McpLaunch;
  /** The tools the chat's view offers; the agent is allowed only those. */
  scope: ConnectToolScope;
  /** The model and effort, already checked against what the agent offers. */
  tuning?: AgentTuning;
  /** The empty folder an agent may run in. Nothing is written there: agents of other chats run in it too. */
  workdir: string;
  /** A private folder, out of `workdir`, where a plugin writes what a turn needs. */
  pluginFolder: string;
  /** What the plugin's check found that every turn must also apply (see `UsableAgent.lockdown`). */
  lockdown: AgentLockdown;
}

/** A turn ready to start. */
export interface PreparedTurn {
  args: string[];
  /** Written to the CLI's stdin. */
  stdin: string;
  cwd: string;
  /** Variables set on top of the companion's agent environment. */
  env?: Readonly<Record<string, string>>;
  /** Removes what the plugin wrote for the turn, once it ended. */
  cleanup?(): Promise<void>;
}

/** What a line of a turn's output says, in the companion's terms. */
export type TurnEvent =
  | { kind: "text"; text: string }
  /** A new agent message starts: its text is set apart from the previous one. */
  | { kind: "message" }
  /** The session the CLI named, for a plugin whose CLI names its own. */
  | { kind: "session"; id: string }
  | { kind: "failed"; error: string }
  | { kind: "finished" }
  /** The CLI started with more than the lockdown allows: the turn ends at once. */
  | { kind: "unsafe"; reason: string }
  /** A tool the agent calls: `mcp__drizzle-run__<tool>` for a Drizzle Run tool, anything else for another. */
  | { kind: "tool"; name: string };

/** Reads one turn's output, line by line. Throws on a line that is not JSON. */
export type TurnParser = (line: string) => TurnEvent[];

/**
 * What a plugin's check found that every turn must also apply, in the plugin's own terms
 *
 * Only the plugin that made it reads it. Codex's holds the features Drizzle Run does not list itself and its model
 * catalog without the file editing tool. Empty for the other plugins.
 */
export interface AgentLockdown {
  /** Settings every turn switches off too. */
  switchedOff: readonly string[];
  /** Files every turn writes in its own folder, by file name. */
  files: Readonly<Record<string, string>>;
}

/** The lockdown of a plugin whose check finds nothing more to apply. */
export const NO_LOCKDOWN: AgentLockdown = { switchedOff: [], files: {} };

/** An installed CLI that passed its plugin's check. */
export interface UsableAgent {
  ok: true;
  agent: CompanionAgent;
  command: string;
  /** What the check found that every turn must also apply. */
  lockdown: AgentLockdown;
}

/** Why an installed CLI is not offered. */
export interface RefusedAgent {
  ok: false;
  id: AgentId;
  reason: string;
}

/** An installed CLI that passed its checks, or why it was refused. */
export type AgentCheck = UsableAgent | RefusedAgent;

/** One agent CLI the companion can chat through. */
export interface AgentPlugin {
  id: AgentId;
  /** The executable looked up on PATH. */
  executable: string;
  /** The models and effort levels it offers, the one place to add or drop one. */
  choices: AgentChoices;
  /**
   * Who names a chat's session: the companion, with a UUID before the first turn, or the CLI, in the output of its
   * first turn.
   */
  sessionNaming: "companion" | "agent";
  /**
   * Check that an installed CLI still has every option its lockdown needs, and read what it offers
   *
   * Never throws: a refusal carries the reason to print.
   */
  check(command: string, run: RunCommand): Promise<AgentCheck>;
  /** Build a turn: its arguments, its input, its folder, and anything the CLI reads from disk. */
  prepareTurn(turn: TurnSpec): Promise<PreparedTurn>;
  /**
   * Create the reader of one turn's output
   *
   * `allowedTools` are the Drizzle Run tools of the turn's scope, such as `get_project`. The reader reports every
   * tool the agent calls and anything the CLI starts with beyond them, so the turn can end before the CLI acts on it.
   */
  createParser(options: { allowedTools: readonly string[] }): TurnParser;
}
