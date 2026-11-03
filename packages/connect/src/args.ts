import {
  AGENT_IDS,
  AGENT_NAMES,
  CONNECT_TOOL_SCOPES,
  DEFAULT_CONNECT_ORIGIN,
  isConnectToolScope,
  isLocalOrigin,
  normalizePairingSecret,
  type AgentId,
  type ConnectToolScope,
} from "@drizzle-run/core/connect";

/** What one run of the command line asked for, after its arguments were read. */
export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "forget" }
  | { kind: "mcp_ipc"; socket: string; token: string; scope: ConnectToolScope }
  | { kind: "connect"; secret?: string; relay?: string; mcp: boolean; agent?: AgentId };

const orList = new Intl.ListFormat("en-GB", { type: "disjunction" });

/** Every agent the companion chats through, by name: "Claude Code, Codex or Grok". */
export const AGENT_NAME_LIST = orList.format(AGENT_IDS.map((id) => AGENT_NAMES[id]));

const OPTION_ROWS: readonly (readonly [flag: string, help: string])[] = [
  [`--agent ${AGENT_IDS.join("|")}`, "Chat through this agent"],
  ["--relay <origin>", `A Drizzle Run other than ${DEFAULT_CONNECT_ORIGIN}, such as a local server`],
  ["--forget", "Forget the pairing on this computer"],
  ["--version, --help", ""],
];
const optionFlagWidth = Math.max(26, ...OPTION_ROWS.map(([flag]) => flag.length)) + 2;
const OPTIONS = OPTION_ROWS.map(([flag, help]) => `  ${flag.padEnd(optionFlagWidth)}${help}`.trimEnd()).join("\n");

/** The `--help` text, also printed after an argument error. */
export const USAGE = `Links your Drizzle Run tabs to your own ${AGENT_NAME_LIST}.
Run it once: it serves every Drizzle Run tab in this browser, a tab you open later joins on its own,
and each project's chat is its own agent session, with nothing shared between them.

  npx @drizzle-run/connect <code>    Pair this computer with the code Drizzle Run shows, then chat
  npx @drizzle-run/connect           Start again once paired, for every tab
  npx @drizzle-run/connect --mcp     Serve the Drizzle Run tools to a terminal agent (as its MCP server),
                                     acting on the tab in front

Options:
${OPTIONS}
`;

/**
 * Read a relay origin
 *
 * Accepts an https origin, or http on this computer only. Any path is dropped.
 * Returns `undefined` for an invalid URL or any other protocol.
 */
export function readRelayOrigin(value: string): string | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const isLocal = isLocalOrigin(url.origin);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    return undefined;
  }

  return url.origin;
}

/**
 * Parse the command line
 *
 * `--help`, `--version` and `--forget` win as soon as they appear. `--mcp-ipc` and `--turn` must come
 * together. Returns an `error` command, with the message to print, for anything it does not accept.
 */
export function parseArgs(argv: readonly string[]): CliCommand | { kind: "error"; message: string } {
  let secret: string | undefined;
  let relay: string | undefined;
  let agent: AgentId | undefined;
  let mcp = false;
  let socket: string | undefined;
  let token: string | undefined;
  let scope: ConnectToolScope = "project";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const readFlagValue = () => {
      index += 1;

      return argv[index];
    };

    switch (arg) {
      case "--help":
      case "-h": {
        return { kind: "help" };
      }

      case "--version":
      case "-v": {
        return { kind: "version" };
      }

      case "--forget": {
        return { kind: "forget" };
      }

      case "--mcp": {
        mcp = true;
        break;
      }

      case "--agent": {
        const agentName = readFlagValue();
        const agentId = AGENT_IDS.find((id) => id === agentName);

        if (agentId === undefined) {
          return { kind: "error", message: `--agent takes ${orList.format(AGENT_IDS)}.` };
        }

        agent = agentId;
        break;
      }

      case "--relay": {
        const origin = readRelayOrigin(readFlagValue() ?? "");

        if (origin === undefined) {
          return { kind: "error", message: "--relay takes an https origin, or http://localhost for a local server." };
        }

        relay = origin;
        break;
      }

      case "--mcp-ipc": {
        socket = readFlagValue();
        break;
      }

      case "--turn": {
        token = readFlagValue();
        break;
      }

      case "--scope": {
        const scopeName = readFlagValue();

        if (!isConnectToolScope(scopeName)) {
          return { kind: "error", message: `--scope takes ${orList.format(CONNECT_TOOL_SCOPES)}.` };
        }

        scope = scopeName;
        break;
      }

      default: {
        if (arg.startsWith("-") || secret !== undefined) {
          return { kind: "error", message: `Unknown argument ${arg}.` };
        }

        secret = normalizePairingSecret(arg);

        if (secret === undefined) {
          return {
            kind: "error",
            message: "That is not a Drizzle Run pairing code. Copy the command Drizzle Run shows.",
          };
        }
      }
    }
  }

  if (socket !== undefined || token !== undefined) {
    if (socket === undefined || token === undefined) {
      return { kind: "error", message: "--mcp-ipc needs --turn." };
    }

    return { kind: "mcp_ipc", socket, token, scope };
  }

  if (mcp && agent !== undefined) {
    return {
      kind: "error",
      message: "--agent picks the chat agent, which --mcp does not start. Use one or the other.",
    };
  }

  return {
    kind: "connect",
    mcp,
    ...(secret ? { secret } : {}),
    ...(relay ? { relay } : {}),
    ...(agent ? { agent } : {}),
  };
}
