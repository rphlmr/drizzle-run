import { AGENT_EFFORTS, AGENT_NAMES, connectToolsFor, type ConnectToolScope } from "@drizzle-run/core/connect";

import { MCP_SERVER_NAME, NO_LOCKDOWN, type AgentChoices, type AgentPlugin, type TurnSpec } from "./contract.ts";
import { getMissingFlags, hasHelpWord, offerChoices, readVersion, toDrizzleRunToolName } from "./shared.ts";
import { createStreamJsonParser, getToolBlockName, readStringList } from "./stream-json.ts";

/**
 * Claude Code: no built-in tool at all (`--tools ""`), only the Drizzle Run MCP server (`--strict-mcp-config`), no
 * settings, hooks or slash commands, and `dontAsk` so nothing outside the allowed tools runs.
 *
 * Checked against Claude Code 2.1.300.
 */

/** Every Claude Code option the lockdown uses; `--help` must list them all. */
export const CLAUDE_REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--include-partial-messages",
  "--verbose",
  "--tools",
  "--strict-mcp-config",
  "--mcp-config",
  "--allowedTools",
  "--permission-mode",
  "--permission-prompts",
  "--setting-sources",
  "--disable-slash-commands",
  "--restricted",
  "--append-system-prompt",
  "--session-id",
  "--resume",
] as const;

/** The Claude Code option that sets the effort; a CLI whose help lacks it is offered without effort levels. */
export const CLAUDE_EFFORT_FLAG = "--effort";

/** The permission mode the lockdown runs Claude Code in; `--help` must offer it. */
export const CLAUDE_PERMISSION_MODE = "dontAsk";

/** Claude Code takes aliases that follow the latest model of each family. */
export const CLAUDE_CHOICES: AgentChoices = {
  models: [
    { id: "fable", name: "Fable", efforts: AGENT_EFFORTS },
    { id: "opus", name: "Opus", efforts: AGENT_EFFORTS },
    { id: "sonnet", name: "Sonnet", efforts: AGENT_EFFORTS },
  ],
  defaults: [{ model: "opus", effort: "medium" }],
};

/**
 * Claude Code tools that may be listed beside the Drizzle Run ones: they only read the resources of configured MCP
 * servers, and `--strict-mcp-config` leaves Drizzle Run's alone, which has none.
 */
const CLAUDE_HARMLESS_TOOLS: readonly string[] = ["ListMcpResourcesTool", "ReadMcpResourceTool"];

/** Get the Claude Code tool names of a scope, such as `mcp__drizzle-run__get_project`. */
export function claudeToolNames(scope: ConnectToolScope = "project"): string[] {
  return connectToolsFor(scope).map((tool) => toDrizzleRunToolName(tool.name));
}

/**
 * Get the arguments for one Claude Code turn
 *
 * The prompt goes on stdin. Throws for a turn without a session id.
 */
export function claudeArgs(turn: Omit<TurnSpec, "prompt" | "workdir" | "pluginFolder" | "lockdown">): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: "stdio", command: turn.mcp.command, args: turn.mcp.args },
    },
  });

  if (turn.session === undefined) {
    throw new Error("A Claude Code turn needs a session id.");
  }

  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // No built-in tool at all: no shell, files, web, or subagents.
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    `--allowedTools=${claudeToolNames(turn.scope).join(",")}`,
    "--permission-mode",
    CLAUDE_PERMISSION_MODE,
    "--permission-prompts",
    "none",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--restricted",
    "--append-system-prompt",
    turn.system,
    ...(turn.tuning?.model === undefined ? [] : ["--model", turn.tuning.model]),
    ...(turn.tuning?.effort === undefined ? [] : [CLAUDE_EFFORT_FLAG, turn.tuning.effort]),
    ...(turn.first ? ["--session-id", turn.session] : ["--resume", turn.session]),
  ];
}

export const claudePlugin: AgentPlugin = {
  id: "claude",
  executable: "claude",
  choices: CLAUDE_CHOICES,
  sessionNaming: "companion",

  async check(command, run) {
    const [versionResult, help] = await Promise.all([run(command, ["--version"]), run(command, ["--help"])]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const missingFlags = getMissingFlags(helpText, CLAUDE_REQUIRED_FLAGS);

    if (!hasHelpWord(helpText, CLAUDE_PERMISSION_MODE)) {
      missingFlags.push(`--permission-mode ${CLAUDE_PERMISSION_MODE}`);
    }

    if (help.status !== 0 || missingFlags.length > 0) {
      return {
        ok: false,
        id: "claude",
        reason: `${AGENT_NAMES.claude} lacks options Drizzle Run needs to limit it to its tools (${missingFlags.join(", ") || "no help"}). Update it.`,
      };
    }

    const version = readVersion(versionResult);

    return {
      ok: true,
      command,
      lockdown: NO_LOCKDOWN,
      agent: {
        id: "claude",
        name: AGENT_NAMES.claude,
        ...(version ? { version } : {}),
        ...offerChoices({ choices: CLAUDE_CHOICES, help: helpText, effortFlag: CLAUDE_EFFORT_FLAG }),
      },
    };
  },

  async prepareTurn(turn) {
    return { args: claudeArgs(turn), stdin: turn.prompt, cwd: turn.workdir };
  },

  createParser({ allowedTools }) {
    const allowedNames = new Set(allowedTools.map(toDrizzleRunToolName));

    return createStreamJsonParser({
      agentName: AGENT_NAMES.claude,
      checkInit: (init) => {
        const tools = readStringList(init.tools);
        const extraTools = tools?.filter((tool) => !allowedNames.has(tool) && !CLAUDE_HARMLESS_TOOLS.includes(tool));

        if (tools === undefined) {
          return "Claude Code did not say which tools this turn has, so Drizzle Run stopped it.";
        }

        if (extraTools !== undefined && extraTools.length > 0) {
          return `Claude Code offered tools beyond Drizzle Run's (${extraTools.join(", ")}), so Drizzle Run stopped it.`;
        }

        if (typeof init.permissionMode === "string" && init.permissionMode !== CLAUDE_PERMISSION_MODE) {
          return `Claude Code started in ${init.permissionMode} mode instead of ${CLAUDE_PERMISSION_MODE}, so Drizzle Run stopped it.`;
        }

        return undefined;
      },
      getToolName: (block) => getToolBlockName(block),
    });
  },
};
