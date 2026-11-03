import { AGENT_IDS, type AgentId } from "@drizzle-run/core/connect";

import { claudePlugin } from "./claude.ts";
import { codexPlugin } from "./codex.ts";
import type { AgentPlugin, RefusedAgent, RunCommand, UsableAgent } from "./contract.ts";
import { grokPlugin } from "./grok.ts";
import { findExecutable, runCommand } from "./shared.ts";

/**
 * The agent CLIs the companion can chat through, one plugin each
 *
 * Only the latest version of each CLI is supported: a plugin checks the options its lockdown needs and refuses a
 * CLI that lacks one, instead of running it with more power. Adding a CLI means an id in core's `AGENT_IDS` and a
 * plugin here; the record fails to compile until both exist.
 */
export const AGENT_PLUGINS = {
  claude: claudePlugin,
  codex: codexPlugin,
  grok: grokPlugin,
} as const satisfies Record<AgentId, AgentPlugin>;

export { MCP_SERVER_NAME, NO_LOCKDOWN } from "./contract.ts";
export type {
  AgentCheck,
  AgentLockdown,
  AgentPlugin,
  McpLaunch,
  PreparedTurn,
  RefusedAgent,
  RunCommand,
  TurnEvent,
  TurnParser,
  TurnSpec,
  UsableAgent,
} from "./contract.ts";
export { agentEnvironment, findExecutable, runCommand, toDrizzleRunToolName } from "./shared.ts";

/**
 * Detect the agent CLIs
 *
 * Returns every supported CLI on PATH that passes its checks, plus why the others were refused, both in
 * `AGENT_IDS` order. A CLI that is not installed is in neither list. `signal` stops the checks still running.
 */
export async function detectAgents(options: { path?: string; run?: RunCommand; signal?: AbortSignal } = {}): Promise<{
  usable: UsableAgent[];
  refused: RefusedAgent[];
}> {
  const checks = await Promise.all(
    AGENT_IDS.map(async (id) => {
      const plugin = AGENT_PLUGINS[id];
      const command = await findExecutable(plugin.executable, options.path);

      const run: RunCommand = options.run ?? ((program, args) => runCommand(program, args, options.signal));

      return command === undefined ? undefined : plugin.check(command, run);
    }),
  );
  const usable: UsableAgent[] = [];
  const refused: RefusedAgent[] = [];

  for (const check of checks) {
    if (check === undefined) {
      continue;
    }

    if (check.ok) {
      usable.push(check);
    } else {
      refused.push(check);
    }
  }

  return { usable, refused };
}
