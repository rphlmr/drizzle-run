import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { CompanionAgent } from "@drizzle-run/core/connect";

import { MCP_SERVER_NAME, type AgentChoices, type AgentDefault, type CommandResult } from "./contract.ts";

/** Helpers every agent plugin shares: running a CLI's probes, reading its help, and offering its models. */

const PROBE_TIMEOUT_MS = 15_000;

/** Get the name a turn reports for a Drizzle Run tool, such as `mcp__drizzle-run__get_project`. */
export function toDrizzleRunToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

/** Quote a string as a TOML basic string; JSON's escapes are all valid TOML. */
export function toTomlString(value: string): string {
  return JSON.stringify(value);
}

/** An environment for the agent without variables that would make it think it runs inside another session. */
export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const agentEnv: NodeJS.ProcessEnv = { ...env };

  for (const key of Object.keys(agentEnv)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key.startsWith("CODEX_SANDBOX")) {
      delete agentEnv[key];
    }
  }

  return agentEnv;
}

/**
 * Run a command to completion
 *
 * Runs with the agent environment and is killed after 15 s, or when `signal` aborts. A command that cannot start, or
 * that `signal` stopped, resolves with a `null` status and the error message as stderr; it never rejects.
 */
export function runCommand(command: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: agentEnvironment(process.env),
      signal,
    });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(killTimer);
      resolve({ status: null, stdout, stderr: error.message });
    });
    child.on("close", (status) => {
      clearTimeout(killTimer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Find the first executable named `name` on PATH. Returns `undefined` when there is none. */
export async function findExecutable(name: string, path = process.env.PATH ?? ""): Promise<string | undefined> {
  const windows = process.platform === "win32";
  const names = windows && !/\.(exe|com)$/i.test(name) ? [name, `${name}.exe`, `${name}.com`] : [name];

  for (const directory of path.split(windows ? ";" : delimiter)) {
    if (directory === "") {
      continue;
    }

    for (const executableName of names) {
      const candidate = join(directory, executableName);

      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return undefined;
}

/** Get the flags a CLI's help does not list. A longer flag that merely starts with one does not count. */
export function getMissingFlags(help: string, flags: readonly string[]): string[] {
  return flags.filter((flag) => {
    const listedFlag = new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, "\\-")}(?=[\\s,=<]|$)`, "m");

    return !listedFlag.test(help);
  });
}

/** Whether a CLI's help names a word, such as a permission mode among an option's choices. */
export function hasHelpWord(help: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(help);
}

/** The version a CLI prints first, such as `2.1.300 (Claude Code)`. */
export function readVersion(result: CommandResult): string | undefined {
  return result.stdout.trim().split("\n")[0]?.trim() || undefined;
}

/**
 * Pick the default a chat starts on
 *
 * Without the account's models, the first default; with them, the first default the account has, else the last.
 */
export function pickAgentDefault(
  defaults: AgentChoices["defaults"],
  accountModels?: ReadonlySet<string>,
): AgentDefault {
  if (accountModels === undefined) {
    return defaults[0];
  }

  return defaults.find((option) => accountModels.has(option.model)) ?? defaults.at(-1) ?? defaults[0];
}

/**
 * Get the models and effort levels an installed CLI offers, and the ones a chat starts on
 *
 * The plugin's choices, narrowed to what the CLI's help shows it takes: without `--model`, nothing, so its chats run
 * on its own defaults; without `effortFlag`, the models and default model without effort levels. A plugin that sets
 * the effort another way passes no `effortFlag`. `accountModels` picks the default (see `pickAgentDefault`).
 */
export function offerChoices({
  choices,
  help,
  effortFlag,
  accountModels,
}: {
  choices: AgentChoices;
  help: string;
  effortFlag?: string;
  accountModels?: ReadonlySet<string>;
}): Pick<CompanionAgent, "models" | "defaults"> {
  if (getMissingFlags(help, ["--model"]).length > 0) {
    return {};
  }

  const defaults = pickAgentDefault(choices.defaults, accountModels);

  if (effortFlag !== undefined && getMissingFlags(help, [effortFlag]).length > 0) {
    return {
      models: choices.models.map((model) => ({ ...model, efforts: [] })),
      defaults: { model: defaults.model },
    };
  }

  return { models: choices.models, defaults };
}
