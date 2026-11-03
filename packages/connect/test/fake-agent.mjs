#!/usr/bin/env node
// A scripted stand-in for the Claude Code, Codex and Grok CLIs: never a real agent session.
// Installed as `claude`, `codex` or `grok` in a temp PATH folder. It answers --version, --help,
// `features list` and `debug models` like the real CLIs, and for a turn it starts the MCP server it was given,
// follows FAKE_AGENT_SCRIPT (a JSON file of steps), and prints the CLI's JSON lines.
// Each turn appends {argv, cwd, prompt, results} to FAKE_AGENT_LOG, and each call to FAKE_AGENT_CALLS as it returns.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const agent = ["codex", "grok"].find((name) => basename(process.argv[1] ?? "").startsWith(name)) ?? "claude";
// Grok prints Claude Code's stream-json.
const isStreamJson = agent !== "codex";
const argv = process.argv.slice(2);
const print = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);

const CLAUDE_HELP = [
  "-p, --print",
  "--output-format <format>",
  "--include-partial-messages",
  "--verbose",
  "--tools <tools...>",
  "--strict-mcp-config",
  "--mcp-config <configs...>",
  "--allowedTools, --allowed-tools <tools...>",
  '--permission-mode <mode> (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")',
  "--permission-prompts <target>",
  "--setting-sources <sources>",
  "--disable-slash-commands",
  "--restricted",
  "--append-system-prompt <prompt>",
  "--session-id <uuid>",
  "--resume [value]",
  "--model <model>",
  "--effort <level>",
].filter(
  (flag) =>
    !(process.env.FAKE_AGENT_DROP_FLAG ?? "").split(",").some((dropped) => dropped !== "" && flag.includes(dropped)),
);
const CODEX_HELP = [
  "-c, --config <key=value>",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--json",
  "-m, --model <MODEL>",
];
const GROK_HELP = [
  "--prompt-file <PATH>",
  "--output-format <FMT>",
  "--include-partial-messages",
  "--tools <TOOLS>",
  "--permission-mode <MODE>  [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]",
  "--allow <RULE>",
  "--no-subagents",
  "--disable-web-search",
  "--no-plan",
  "--rules <RULES>",
  "-s, --session-id <ID>",
  "-r, --resume <ID>",
  "-m, --model <MODEL>",
  "--reasoning-effort <EFFORT>  [aliases: --effort]",
];
const HELP = { claude: CLAUDE_HELP, codex: CODEX_HELP, grok: GROK_HELP };

if (argv[0] === "--version") {
  print(`9.9.9 (${agent})`);
  process.exit(0);
}

if (argv.includes("--help")) {
  print(`Usage: ${agent}\n\nOptions:\n${HELP[agent].map((flag) => `  ${flag}  something`).join("\n")}`);
  process.exit(0);
}

if (argv[0] === "debug" && argv[1] === "models") {
  // The account's models: FAKE_AGENT_MODELS, comma-separated.
  const slugs = (process.env.FAKE_AGENT_MODELS ?? "").split(",").filter((slug) => slug !== "");

  print({ models: slugs.map((slug) => ({ slug, visibility: "list" })) });
  process.exit(0);
}

const configs = [];

for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "-c") {
    configs.push(argv[index + 1] ?? "");
  }
}

if (argv.at(-2) === "features" && argv.at(-1) === "list") {
  // Every feature it is told about, plus FAKE_AGENT_EXTRA_FEATURES (on unless turned off); FAKE_AGENT_FORCE_ON stay on.
  const forcedOn = (process.env.FAKE_AGENT_FORCE_ON ?? "").split(",");
  const features = new Map(
    (process.env.FAKE_AGENT_EXTRA_FEATURES ?? "")
      .split(",")
      .filter(Boolean)
      .map((name) => [name, "true"]),
  );

  for (const config of configs) {
    const match = /^features\.([a-z0-9_]+)=(true|false)$/.exec(config);

    if (match) {
      features.set(match[1], match[2]);
    }
  }

  for (const [name, value] of features) {
    print(`${name.padEnd(40)} stable             ${forcedOn.includes(name) ? "true" : value}`);
  }

  process.exit(0);
}

const readCodexConfig = (key) =>
  JSON.parse(configs.find((config) => config.startsWith(`${key}=`)).slice(key.length + 1));

const readGrokConfig = (key) => {
  const config = readFileSync(join(process.cwd(), ".grok", "config.toml"), "utf8");
  const line = config.split("\n").find((entry) => entry.startsWith(`${key} = `));

  return JSON.parse(line.slice(key.length + 3));
};

const mcpLaunch = () => {
  if (agent === "grok") {
    return { command: readGrokConfig("command"), args: readGrokConfig("args") };
  }

  if (agent === "claude") {
    const json = argv[argv.indexOf("--mcp-config") + 1];
    const server = JSON.parse(json).mcpServers["drizzle-run"];
    return { command: server.command, args: server.args };
  }

  return {
    command: readCodexConfig("mcp_servers.drizzle-run.command"),
    args: readCodexConfig("mcp_servers.drizzle-run.args"),
  };
};

const prompt = readFileSync(agent === "grok" ? argv[argv.indexOf("--prompt-file") + 1] : 0, "utf8");
// A script is a list of steps, or { byPrompt: { "<text in the prompt>": steps } } to script each turn.
const script = process.env.FAKE_AGENT_SCRIPT
  ? JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT, "utf8"))
  : [{ say: "Hello from the fake agent." }];
const steps = Array.isArray(script)
  ? script
  : (Object.entries(script.byPrompt).find(([key]) => prompt.includes(key))?.[1] ?? [
      { say: "No script for this prompt." },
    ]);
const launch = mcpLaunch();
const server = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "inherit"] });
const replies = new Map();
let nextId = 0;

createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(message.id)?.(message);
});

const request = (method, params) =>
  new Promise((resolve) => {
    nextId += 1;
    replies.set(nextId, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`);
  });

const say = (text) => {
  if (isStreamJson) {
    print({ type: "stream_event", event: { type: "message_start" } });
    for (const piece of text.match(/.{1,8}/gs) ?? []) {
      print({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } },
      });
    }
  } else {
    print({ type: "item.completed", item: { type: "agent_message", text } });
  }
};

if (agent === "claude") {
  // Like Claude Code: the session's tools (the allowed ones, plus FAKE_AGENT_EXTRA_TOOLS) and its permission mode.
  const allowed = (argv.find((arg) => arg.startsWith("--allowedTools=")) ?? "")
    .slice("--allowedTools=".length)
    .split(",")
    .filter(Boolean);
  const extra = (process.env.FAKE_AGENT_EXTRA_TOOLS ?? "").split(",").filter(Boolean);
  print({
    type: "system",
    subtype: "init",
    session_id: argv[argv.indexOf(argv.includes("--session-id") ? "--session-id" : "--resume") + 1],
    tools: [...allowed, ...extra],
    permissionMode: argv[argv.indexOf("--permission-mode") + 1],
  });
} else if (agent === "grok") {
  // Like Grok: the MCP meta-tools (plus FAKE_AGENT_EXTRA_TOOLS), its MCP servers (plus FAKE_AGENT_EXTRA_SERVERS, on).
  const extraTools = (process.env.FAKE_AGENT_EXTRA_TOOLS ?? "").split(",").filter(Boolean);
  const extraServers = (process.env.FAKE_AGENT_EXTRA_SERVERS ?? "").split(",").filter(Boolean);
  print({
    type: "system",
    subtype: "init",
    session_id: argv[argv.indexOf(argv.includes("--session-id") ? "--session-id" : "--resume") + 1],
    tools: ["search_tool", "use_tool", ...extraTools],
    permissionMode: argv[argv.indexOf("--permission-mode") + 1],
    mcp_servers: [
      { name: "drizzle-run", status: "connected" },
      ...extraServers.map((name) => ({ name, status: "connected" })),
    ],
  });
} else {
  print({ type: "thread.started", thread_id: "thread-1" });
  print({ type: "turn.started" });
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "fake", version: "1" },
});
const listed = await request("tools/list", {});
const results = [];

for (const step of steps) {
  if (step.say !== undefined) {
    say(step.say);
  } else if (step.call !== undefined) {
    if (agent === "grok") {
      // Grok reaches every MCP tool through use_tool.
      print({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "u1", name: "use_tool", input: { tool_name: `drizzle-run__${step.call}` } },
          ],
        },
      });
    }

    const reply = await request("tools/call", { name: step.call, arguments: step.args ?? {} });
    results.push({
      name: step.call,
      isError: reply.result?.isError === true,
      text: reply.result?.content?.[0]?.text ?? reply.error?.message,
    });
    // Each call as it returns, for a turn that may be stopped before it logs.
    if (process.env.FAKE_AGENT_CALLS) {
      appendFileSync(process.env.FAKE_AGENT_CALLS, `${JSON.stringify(results.at(-1))}\n`);
    }
    say(`${step.call}: ${reply.result?.isError ? "error" : "ok"}`);
  } else if (step.use !== undefined) {
    // A tool beyond Drizzle Run's, as the CLI reports it: Claude Code's tool_use block, or a Codex item.
    if (isStreamJson) {
      print({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t1", name: step.use, input: {} },
        },
      });
    } else {
      print({ type: "item.started", item: { id: "i1", type: step.use, command: "ls", status: "in_progress" } });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  } else if (step.wait !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, step.wait));
  } else if (step.fail !== undefined) {
    print(
      isStreamJson
        ? { type: "result", subtype: "error_during_execution", is_error: true, result: step.fail }
        : { type: "turn.failed", error: { message: step.fail } },
    );
    server.stdin.end();
    appendFileSync(
      process.env.FAKE_AGENT_LOG ?? "/dev/null",
      `${JSON.stringify({ agent, argv, cwd: process.cwd(), prompt, tools: listed.result.tools.map((tool) => tool.name), results })}\n`,
    );
    process.exit(1);
  }
}

if (process.env.FAKE_AGENT_LOG) {
  appendFileSync(
    process.env.FAKE_AGENT_LOG,
    `${JSON.stringify({ agent, argv, cwd: process.cwd(), prompt, tools: listed.result.tools.map((tool) => tool.name), results })}\n`,
  );
}

print(isStreamJson ? { type: "result", subtype: "success", is_error: false, result: "" } : { type: "turn.completed" });
server.stdin.end();
process.exit(0);
