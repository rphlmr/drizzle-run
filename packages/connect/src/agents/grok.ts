import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AGENT_NAMES, connectToolsFor } from "@drizzle-run/core/connect";
import * as z from "zod/mini";

import { MCP_SERVER_NAME, NO_LOCKDOWN, type AgentChoices, type AgentPlugin, type TurnSpec } from "./contract.ts";
import {
  getMissingFlags,
  hasHelpWord,
  offerChoices,
  readVersion,
  toDrizzleRunToolName,
  toTomlString,
} from "./shared.ts";
import { createStreamJsonParser, getToolBlockName, readStringList } from "./stream-json.ts";

/**
 * Grok: headless (`--prompt-file`) with only the MCP meta-tools (`--tools use_tool` leaves `search_tool` and
 * `use_tool`), in `dontAsk` mode with one allow rule per Drizzle Run tool of the chat, so a call to anything else is
 * cancelled. No subagents, web, plans, memory, workflows, or Claude Code and Cursor settings. Grok names the Drizzle
 * Run tools `drizzle-run__<tool>`, and calls them directly or through `use_tool`.
 *
 * Grok has no option for an MCP server, so each chat gets a private folder whose `.grok/config.toml` names the
 * Drizzle Run server, written before each turn and removed after it. The turn's first line must list that server as
 * the only one on: Grok also loads the servers of the user's own config, which would bring tools beyond Drizzle
 * Run's.
 *
 * Checked against Grok 1.0.62.
 */

/** Every Grok option the lockdown uses; `--help` must list them all. */
export const GROK_REQUIRED_FLAGS = [
  "--prompt-file",
  "--output-format",
  "--include-partial-messages",
  "--tools",
  "--permission-mode",
  "--allow",
  "--no-subagents",
  "--disable-web-search",
  "--no-plan",
  "--rules",
  "--session-id",
  "--resume",
] as const;

/** The Grok option that sets the effort; a CLI whose help lacks it is offered without effort levels. */
export const GROK_EFFORT_FLAG = "--reasoning-effort";

/** The permission mode the lockdown runs Grok in; `--help` must offer it. */
export const GROK_PERMISSION_MODE = "dontAsk";

/** Grok's models and the effort levels each one's menu lists (`grok models`), checked 2026-10-20. */
export const GROK_CHOICES: AgentChoices = {
  models: [
    { id: "grok-4.7", name: "Grok 4.7", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "grok-4.7-build-fast", name: "Grok 4.7 Fast", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "grok-4.6", name: "Grok 4.6", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "grok-4.5", name: "Grok 4.5", efforts: ["low", "medium", "high"] },
  ],
  defaults: [{ model: "grok-4.7", effort: "medium" }],
};

/**
 * The MCP meta-tools a locked-down Grok session has: `search_tool` finds the Drizzle Run tools, `use_tool` calls one.
 * A session whose server is connected when it starts may also list the Drizzle Run tools themselves.
 */
const GROK_META_TOOLS: readonly string[] = ["search_tool", "use_tool"];

/** The prefix Grok gives the Drizzle Run tools, such as `drizzle-run__get_project`. */
const GROK_TOOL_PREFIX = `${MCP_SERVER_NAME}__`;

/** Variables that switch off what Grok would load beyond its own defaults. */
export const GROK_ENVIRONMENT: Readonly<Record<string, string>> = {
  // Loads the chat folder's MCP server without a trust grant; the folder holds nothing else.
  GROK_FOLDER_TRUST: "0",
  // No instructions, hooks, MCP servers, rules or skills from Claude Code's or Cursor's settings.
  ...Object.fromEntries(
    ["CLAUDE", "CURSOR"].flatMap((vendor) =>
      ["AGENTS", "HOOKS", "MCPS", "RULES", "SKILLS"].map((kind) => [`GROK_${vendor}_${kind}_ENABLED`, "0"]),
    ),
  ),
  GROK_MEMORY: "0",
  GROK_SUBAGENTS: "0",
  GROK_WEB_FETCH: "0",
  GROK_LSP_TOOLS: "0",
  GROK_WORKFLOWS: "0",
  GROK_DISABLE_AUTOUPDATER: "1",
};

/** The `.grok/config.toml` that gives a chat folder the Drizzle Run MCP server. */
export function grokProjectConfig(mcp: TurnSpec["mcp"]): string {
  return [
    `[mcp_servers.${toTomlString(MCP_SERVER_NAME)}]`,
    `command = ${toTomlString(mcp.command)}`,
    `args = [${mcp.args.map(toTomlString).join(", ")}]`,
    "enabled = true",
    "",
  ].join("\n");
}

/**
 * Get the arguments for one Grok turn
 *
 * Throws for a turn without a session id.
 */
export function grokArgs(
  turn: Omit<TurnSpec, "prompt" | "workdir" | "pluginFolder" | "lockdown">,
  promptFile: string,
): string[] {
  if (turn.session === undefined) {
    throw new Error("A Grok turn needs a session id.");
  }

  return [
    "--prompt-file",
    promptFile,
    "--output-format",
    "streaming-messages-json",
    "--include-partial-messages",
    // Only the MCP meta-tools: no shell, files, web, images, goals or plans.
    "--tools",
    "use_tool",
    "--permission-mode",
    GROK_PERMISSION_MODE,
    ...connectToolsFor(turn.scope).flatMap((tool) => ["--allow", `MCPTool(${GROK_TOOL_PREFIX}${tool.name})`]),
    "--no-subagents",
    "--disable-web-search",
    "--no-plan",
    "--rules",
    turn.system,
    ...(turn.tuning?.model === undefined ? [] : ["--model", turn.tuning.model]),
    ...(turn.tuning?.effort === undefined ? [] : [GROK_EFFORT_FLAG, turn.tuning.effort]),
    ...(turn.first ? ["--session-id", turn.session] : ["--resume", turn.session]),
  ];
}

// A server that does not read counts as one that is on, so the lockdown never lets it through.
const GrokMcpServersSchema = z.array(
  z.catch(
    z.looseObject({
      name: z.catch(z.string(), "unnamed"),
      status: z.catch(z.optional(z.string()), undefined),
    }),
    { name: "unnamed", status: undefined },
  ),
);

const GrokUseToolInputSchema = z.looseObject({ tool_name: z.string() });

/** Why the MCP servers a Grok session lists go beyond Drizzle Run's, or undefined when they do not. */
function checkGrokServers(value: unknown): string | undefined {
  const servers = GrokMcpServersSchema.safeParse(value);

  if (!servers.success) {
    return "Grok did not say which MCP servers this turn has, so Drizzle Run stopped it.";
  }

  const otherServers = servers.data
    .filter((server) => server.name !== MCP_SERVER_NAME && server.status !== "disabled")
    .map((server) => server.name);

  if (otherServers.length > 0) {
    return [
      `Grok has other MCP servers on (${otherServers.join(", ")}), so Drizzle Run stopped it.`,
      "Turn them off with grok mcp disable <name> to chat through Grok.",
    ].join(" ");
  }

  return undefined;
}

export const grokPlugin: AgentPlugin = {
  id: "grok",
  executable: "grok",
  choices: GROK_CHOICES,
  sessionNaming: "companion",

  async check(command, run) {
    const [versionResult, help] = await Promise.all([run(command, ["--version"]), run(command, ["--help"])]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    const missingFlags = getMissingFlags(helpText, GROK_REQUIRED_FLAGS);

    if (!hasHelpWord(helpText, GROK_PERMISSION_MODE)) {
      missingFlags.push(`--permission-mode ${GROK_PERMISSION_MODE}`);
    }

    if (help.status !== 0 || missingFlags.length > 0) {
      return {
        ok: false,
        id: "grok",
        reason: `${AGENT_NAMES.grok} lacks options Drizzle Run needs to limit it to its tools (${missingFlags.join(", ") || "no help"}). Update it.`,
      };
    }

    const version = readVersion(versionResult);

    return {
      ok: true,
      command,
      lockdown: NO_LOCKDOWN,
      agent: {
        id: "grok",
        name: AGENT_NAMES.grok,
        ...(version ? { version } : {}),
        ...offerChoices({ choices: GROK_CHOICES, help: helpText, effortFlag: GROK_EFFORT_FLAG }),
      },
    };
  },

  async prepareTurn(turn) {
    if (turn.session === undefined) {
      throw new Error("A Grok turn needs a session id.");
    }

    // One folder per chat, so a resumed session finds the folder it started in.
    const chatFolder = join(turn.pluginFolder, "grok", turn.session);
    const projectFolder = join(chatFolder, "project");
    const configFolder = join(projectFolder, ".grok");
    const configFile = join(configFolder, "config.toml");
    const promptFile = join(chatFolder, "prompt.md");
    const removeTurnFiles = async () => {
      await Promise.all([rm(configFile, { force: true }), rm(promptFile, { force: true })]);
    };

    // Only this user reads them: the config holds the turn's token. A half-written turn leaves nothing behind.
    try {
      await mkdir(configFolder, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(configFile, grokProjectConfig(turn.mcp), { mode: 0o600 }),
        writeFile(promptFile, turn.prompt, { mode: 0o600 }),
      ]);
    } catch (cause) {
      await removeTurnFiles();
      throw cause;
    }

    return {
      args: grokArgs(turn, promptFile),
      stdin: "",
      cwd: projectFolder,
      env: GROK_ENVIRONMENT,
      cleanup: removeTurnFiles,
    };
  },

  createParser({ allowedTools }) {
    const allowedNames = new Set([...GROK_META_TOOLS, ...allowedTools.map((tool) => `${GROK_TOOL_PREFIX}${tool}`)]);

    return createStreamJsonParser({
      agentName: AGENT_NAMES.grok,
      checkInit: (init) => {
        const tools = readStringList(init.tools);
        const extraTools = tools?.filter((tool) => !allowedNames.has(tool));

        if (tools === undefined) {
          return "Grok did not say which tools this turn has, so Drizzle Run stopped it.";
        }

        if (extraTools !== undefined && extraTools.length > 0) {
          return `Grok offered tools beyond Drizzle Run's (${extraTools.join(", ")}), so Drizzle Run stopped it.`;
        }

        if (init.permissionMode !== GROK_PERMISSION_MODE) {
          return `Grok started in ${String(init.permissionMode)} mode instead of ${GROK_PERMISSION_MODE}, so Drizzle Run stopped it.`;
        }

        return checkGrokServers(init.mcp_servers);
      },
      getToolName: (block, partial) => {
        const name = getToolBlockName(block);

        if (name.startsWith(GROK_TOOL_PREFIX)) {
          return toDrizzleRunToolName(name.slice(GROK_TOOL_PREFIX.length));
        }

        if (!GROK_META_TOOLS.includes(name)) {
          return name;
        }

        // Searching lists the Drizzle Run tools only; a call names its tool once its input is complete.
        if (block.name === "search_tool" || partial) {
          return undefined;
        }

        const input = GrokUseToolInputSchema.safeParse(block.input);
        const toolName = input.success ? input.data.tool_name : "unnamed";

        if (toolName.startsWith(GROK_TOOL_PREFIX)) {
          return toDrizzleRunToolName(toolName.slice(GROK_TOOL_PREFIX.length));
        }

        return `grok:use_tool:${toolName}`;
      },
    });
  },
};
