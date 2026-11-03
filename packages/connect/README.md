# @drizzle-run/connect

Links your Drizzle Run tabs to your own Claude Code, Codex or Grok CLI. The agent gets the Drizzle Run tools and nothing else: it reads, edits (each edit waits for Keep or Undo), and runs the project open in your browser.

Run it once. One companion serves every Drizzle Run tab in the paired browser, and a tab you open later joins on its own. Each project's chat is its own agent session: two tabs can chat at the same time, and neither sees the other's conversation.

You need Node 22.4 or later and the latest Claude Code, Codex, or Grok CLI, installed and signed in. The companion
offers only agents that pass its compatibility checks.

On Windows, install the agent's native `.exe` or `.com` executable on PATH. Batch wrappers (`.cmd` and `.bat`)
are not supported because agents launch directly without a command shell.

```sh
npx @drizzle-run/connect <code>   # pair this computer with the code Drizzle Run shows
npx @drizzle-run/connect          # later: start again, for every tab
npx @drizzle-run/connect --mcp    # serve the same tools to a terminal agent, acting on the tab in front
```

Options: `--agent claude|codex|grok`, `--relay <origin>` (a Drizzle Run other than https://drizzle.run, such as a local server), `--forget`, `--version`, `--help`.

## Try it locally

To try changes that are not on npm yet, a local server runs this repository's build. `pnpm dev` builds it and serves the app and the relay rooms (the Worker runs through the Cloudflare Vite plugin) at http://127.0.0.1:4173. A linked worktree serves on its own port ([Ports](../../README.md#ports-and-local-state)); use that origin below.

1. Run `pnpm dev` from the repository root.
2. Open a project at http://127.0.0.1:4173 and press AI chat. On a local server the tab shows the exact command to copy, `node packages/connect/dist/cli.js <code> --relay http://127.0.0.1:4173`.
3. Run it in a second terminal, from the repository root, and pick the agent in the tab.

Later, `node packages/connect/dist/cli.js` alone links every tab of that browser again: the companion saved the pairing, relay included, in `~/.drizzle-run/connect.json`. "Forget this computer" in the tab, or `--forget`, deletes it. To try without touching that file, give the companion a throwaway folder for the pairing:

```sh
DRIZZLE_RUN_HOME=$(mktemp -d) node packages/connect/dist/cli.js <code> --relay http://127.0.0.1:4173
```

After changing only this package, rebuild it with `pnpm --filter @drizzle-run/connect build`.

## How it works

- **Relay.** The tab and the companion meet in a Cloudflare Durable Object room of the Drizzle Run Worker (`/api/connect/rooms/<roomId>`). Browsers block `ws://localhost` from HTTPS pages, so there is no loopback path.
- **End to end.** The pairing code is the key. PBKDF2 (200,000 rounds) and HKDF derive, separately, a companion proof and an AES-GCM key the relay never sees. The room id the relay routes by is the proof's SHA-256: the tab and the companion show the proof when they join, so someone who only knows the room id cannot fill the room with tabs or take it from your companion. The proof travels in the `Sec-WebSocket-Protocol` header, never in a URL, and it stays valid as long as the pairing: anyone who reads it can join the room (though not read or forge a message, which takes the key). Forget the pairing in the AI chat to make a new code, and a new proof, if it may have leaked. Every message is sealed with the sender's role, a session per peer, and a growing counter, so the relay cannot read, forge, replay, or reflect them.
- **Memory.** The pairing is kept in `~/.drizzle-run/connect.json` (folder 0700, file 0600); `DRIZZLE_RUN_HOME` moves the folder. "Forget this computer" in the tab, or `--forget` here, clears it.
- **Agents.** Each chat has its own agent session and Drizzle Run tool set. See
  [Agent isolation details](#agent-isolation-details) for the CLI flags and runtime checks.
- **Tools.** The agent's MCP server is this package (`--mcp-ipc`), which forwards calls over a private Unix socket to the companion, which seals them for the tab. The tab checks every input, refuses edit tools in Ask mode, and runs them against its open project.
- **Untrusted content.** Anyone can publish a project, so a project's files, names, console and errors may be written to steer an agent. Every tool result reaches the agent inside a `<drizzle-run-data>` block whose tags carry a random nonce, after a line saying it is data; the MCP server's instructions and the chat's system prompt say tool content is never instructions. With `--mcp`, your own terminal agent reads that content with all of its own tools, so prefer chat mode for projects you did not write.

## Development checks

From the repository root:

```bash
pnpm --filter @drizzle-run/connect test
pnpm --filter @drizzle-run/connect test:pack
```

Tests use a temporary home and a scripted fake agent; they never start a real agent session.

## Agent isolation details

Each CLI is a plugin in `src/agents/` (its lockdown, its check, its models, how a turn starts and how its output reads); `src/agents/index.ts` lists them. Only the latest version of each CLI is supported. The companion offers each installed CLI that passes its checks, and runs one process per chat turn in an empty temp folder:

- Claude Code: `--print --tools "" --strict-mcp-config --mcp-config <drizzle-run> --allowedTools <drizzle-run tools> --permission-mode dontAsk --permission-prompts none --setting-sources "" --restricted --disable-slash-commands`, with `--session-id` then `--resume`.
- Codex: `exec --json --ignore-user-config --ignore-rules`, a permission profile that reads only the empty folder with no network, `approval_policy="never"`, web search, agents, skills and every extra feature off (`shell_tool` included), and the Drizzle Run MCP server as `required`, with only the chat's tools, approved; `exec resume <thread>` for later turns. Codex reaches MCP tools only through code mode, a JavaScript `exec` with no `require`, `process` or `fetch`, so `code_mode_host` stays on. Each turn runs on Codex's own model catalog (`codex debug models`) with `apply_patch` removed, once Codex has read it back that way; when it cannot, turns run without it and the read-only profile still rejects its edits. The system prompt goes in `developer_instructions`, which Codex ranks above the user's global `AGENTS.md`; that file still reaches the model, as Codex reads it from `CODEX_HOME` with the sign-in.
- Grok: `--prompt-file --output-format streaming-messages-json --tools use_tool --permission-mode dontAsk` with one `--allow MCPTool(drizzle-run__<tool>)` per tool of the chat, `--no-subagents --disable-web-search --no-plan`, and variables that turn off memory, workflows, web fetch, and Claude Code's and Cursor's settings; `--session-id` then `--resume`. Grok has no MCP option, so each chat gets a private folder whose `.grok/config.toml` names the Drizzle Run server, written for each turn and removed after it. Files a plugin writes stay out of the empty folder Claude Code and Codex run in. Grok's own hooks and instructions in `~/.grok` still apply, as when you run it yourself.
- Before offering a CLI, the companion checks its `--help` for every option above (and, for Claude Code and Grok, the `dontAsk` permission mode), and refuses a CLI that lacks one. For Codex it also turns off every feature `features list` names, known or not, and refuses Codex when one still reads true, apart from the code mode host and unified exec, which only shapes the shell tools `shell_tool` removes.
- During a turn, the companion reads what the CLI reports: the tools and mode the Claude Code or Grok session starts with (and Grok's MCP servers, which must be Drizzle Run's only), and every tool any CLI calls. Anything beyond the Drizzle Run tools of the chat (a shell, files, web, another MCP server) fails the turn and ends the CLI at once.
