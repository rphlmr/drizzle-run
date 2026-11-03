import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { connectToolsFor } from "@drizzle-run/core/connect";
import { afterEach, describe, expect, it } from "vitest";

import { makeFakeCli } from "../../test/fake-cli.ts";
import { tempFolder } from "../../test/harness.ts";
import { NO_LOCKDOWN } from "./contract.ts";
import {
  GROK_CHOICES,
  GROK_ENVIRONMENT,
  GROK_REQUIRED_FLAGS,
  grokArgs,
  grokPlugin,
  grokProjectConfig,
} from "./grok.ts";

const mcp = { command: "/usr/bin/node", args: ["/pkg/cli.js", "--mcp-ipc", "/tmp/s", "--turn", "tok"] };

const turn = { session: "s1", first: true, system: "sys", mcp, scope: "project" } as const;

const getFlagValue = (args: string[], name: string) => args[args.indexOf(name) + 1];

const getFlagValues = (args: string[], name: string) => args.filter((_, index) => args[index - 1] === name);

const toLine = (value: unknown) => JSON.stringify(value);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** A `system` `init` line of a locked-down Grok session, with `overrides`. */
function makeInitLine(overrides: Record<string, unknown> = {}): string {
  return toLine({
    type: "system",
    subtype: "init",
    permissionMode: "dontAsk",
    tools: ["search_tool", "use_tool"],
    mcp_servers: [{ name: "drizzle-run", status: "pending" }],
    ...overrides,
  });
}

/** An `assistant` line calling one tool. */
function makeToolLine(name: string, input: Record<string, unknown> = {}): string {
  return toLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] } });
}

describe("Grok plugin", () => {
  it("should give Grok only the MCP meta-tools, in dontAsk mode, with the scope's Drizzle Run tools allowed", () => {
    const args = grokArgs({ ...turn, scope: "snapshot" }, "/tmp/prompt.md");

    expect(getFlagValue(args, "--prompt-file")).toBe("/tmp/prompt.md");
    expect(getFlagValue(args, "--output-format")).toBe("streaming-messages-json");
    expect(getFlagValue(args, "--tools")).toBe("use_tool");
    expect(getFlagValue(args, "--permission-mode")).toBe("dontAsk");
    expect(getFlagValues(args, "--allow")).toEqual(
      connectToolsFor("snapshot").map((tool) => `MCPTool(drizzle-run__${tool.name})`),
    );
    expect(getFlagValue(args, "--rules")).toBe("sys");
    expect(args).toEqual(
      expect.arrayContaining(["--include-partial-messages", "--no-subagents", "--disable-web-search", "--no-plan"]),
    );
    expect(getFlagValue(args, "--session-id")).toBe("s1");
    expect(getFlagValue(grokArgs({ ...turn, first: false }, "/tmp/p"), "--resume")).toBe("s1");
    expect(() => grokArgs({ ...turn, session: undefined }, "/tmp/p")).toThrow("A Grok turn needs a session id.");
  });

  it("should pass the turn's model and effort in their own options", () => {
    const args = grokArgs({ ...turn, tuning: { model: "grok-4.7", effort: "xhigh" } }, "/tmp/p");

    expect(getFlagValue(args, "--model")).toBe("grok-4.7");
    expect(getFlagValue(args, "--reasoning-effort")).toBe("xhigh");
    expect(grokArgs(turn, "/tmp/p")).not.toContain("--model");
  });

  it("should switch off Claude Code and Cursor settings, memory, subagents, web fetch and folder trust", () => {
    expect(GROK_ENVIRONMENT).toMatchObject({
      GROK_FOLDER_TRUST: "0",
      GROK_CLAUDE_MCPS_ENABLED: "0",
      GROK_CLAUDE_HOOKS_ENABLED: "0",
      GROK_CURSOR_MCPS_ENABLED: "0",
      GROK_MEMORY: "0",
      GROK_SUBAGENTS: "0",
      GROK_WEB_FETCH: "0",
    });
  });

  it("should write the Drizzle Run server and the prompt for one turn in the chat's private folder", async () => {
    const workdir = await tempFolder("drizzle-run-grok-test-");

    cleanups.push(workdir.remove);

    const prepared = await grokPlugin.prepareTurn({
      ...turn,
      prompt: "Hi",
      workdir: join(workdir.path, "agent"),
      pluginFolder: join(workdir.path, "plugins"),
      lockdown: NO_LOCKDOWN,
    });
    const configFile = join(prepared.cwd, ".grok", "config.toml");
    const promptFile = getFlagValue(prepared.args, "--prompt-file") ?? "";

    expect(prepared.cwd).toBe(join(workdir.path, "plugins", "grok", "s1", "project"));
    expect(prepared.env).toBe(GROK_ENVIRONMENT);
    expect(await readFile(configFile, "utf8")).toBe(grokProjectConfig(mcp));
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(promptFile, "utf8")).toBe("Hi");
    expect(promptFile.startsWith(prepared.cwd)).toBe(false);

    await prepared.cleanup?.();

    await expect(access(configFile)).rejects.toThrow("ENOENT");
    await expect(access(promptFile)).rejects.toThrow("ENOENT");
  });

  it("should name the server in TOML", () => {
    expect(grokProjectConfig({ command: "/bin/node", args: ['a "b"', "c"] })).toBe(
      ['[mcp_servers."drizzle-run"]', 'command = "/bin/node"', 'args = ["a \\"b\\"", "c"]', "enabled = true", ""].join(
        "\n",
      ),
    );
  });

  it("should offer Grok's models, starting on Grok 4.7 at medium, when its help lists every lockdown option", async () => {
    const check = await grokPlugin.check(
      "/bin/grok",
      makeFakeCli({ flags: [...GROK_REQUIRED_FLAGS, "--model", "--reasoning-effort"] }),
    );

    expect(check).toMatchObject({
      ok: true,
      lockdown: NO_LOCKDOWN,
      agent: {
        id: "grok",
        name: "Grok",
        version: "1.2.3",
        models: GROK_CHOICES.models,
        defaults: { model: "grok-4.7", effort: "medium" },
      },
    });

    const withoutAllow = GROK_REQUIRED_FLAGS.filter((flag) => flag !== "--allow");

    expect(await grokPlugin.check("/bin/grok", makeFakeCli({ flags: withoutAllow }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--allow"),
    });
    expect(
      await grokPlugin.check("/bin/grok", makeFakeCli({ flags: GROK_REQUIRED_FLAGS, modes: '(choices: "default")' })),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("--permission-mode dontAsk") });
  });

  it("should accept a session with the meta-tools, the chat's Drizzle Run tools, and the Drizzle Run server only", () => {
    const parse = grokPlugin.createParser({ allowedTools: ["get_project"] });

    expect(parse(makeInitLine())).toEqual([]);
    expect(parse(makeInitLine({ tools: ["search_tool", "use_tool", "drizzle-run__get_project"] }))).toEqual([]);
    expect(parse(makeInitLine({ tools: ["use_tool", "drizzle-run__run"] }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("(drizzle-run__run)") },
    ]);
    expect(
      parse(
        makeInitLine({
          mcp_servers: [
            { name: "drizzle-run", status: "connected" },
            { name: "linear", status: "disabled" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("should flag a session with other tools, another MCP server on, another mode, or no server list", () => {
    const parse = grokPlugin.createParser({ allowedTools: ["get_project"] });

    expect(parse(makeInitLine({ tools: ["search_tool", "use_tool", "run_terminal_command"] }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("(run_terminal_command)") },
    ]);
    expect(
      parse(
        makeInitLine({
          mcp_servers: [
            { name: "drizzle-run", status: "connected" },
            { name: "linear", status: "pending" },
          ],
        }),
      ),
    ).toEqual([{ kind: "unsafe", reason: expect.stringContaining("other MCP servers on (linear)") }]);
    expect(parse(makeInitLine({ permissionMode: "default" }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("default mode") },
    ]);
    expect(parse(makeInitLine({ mcp_servers: undefined }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("which MCP servers") },
    ]);
    expect(parse(makeInitLine({ tools: undefined }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("which tools") },
    ]);
  });

  it("should name the tool a use_tool call reaches, once its input is complete", () => {
    const parse = grokPlugin.createParser({ allowedTools: ["get_project"] });
    const startedCall = toLine({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "use_tool", input: {} } },
    });

    expect(parse(startedCall)).toEqual([]);
    expect(parse(makeToolLine("search_tool", { query: "drizzle-run" }))).toEqual([]);
    expect(parse(makeToolLine("use_tool", { tool_name: "drizzle-run__get_project", tool_input: {} }))).toEqual([
      { kind: "tool", name: "mcp__drizzle-run__get_project" },
    ]);
    expect(parse(makeToolLine("drizzle-run__read_file", { path: "schema.ts" }))).toEqual([
      { kind: "tool", name: "mcp__drizzle-run__read_file" },
    ]);
    expect(parse(makeToolLine("use_tool", { tool_name: "linear__create_issue" }))).toEqual([
      { kind: "tool", name: "grok:use_tool:linear__create_issue" },
    ]);
    expect(parse(makeToolLine("run_terminal_command", { command: "ls" }))).toEqual([
      { kind: "tool", name: "run_terminal_command" },
    ]);
  });

  it("should read streamed text and the result like Claude Code's stream", () => {
    const parse = grokPlugin.createParser({ allowedTools: [] });

    expect(
      parse(
        toLine({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
        }),
      ),
    ).toEqual([{ kind: "text", text: "OK" }]);
    expect(parse(toLine({ type: "result", subtype: "error_during_execution", is_error: true }))).toEqual([
      { kind: "failed", error: "Grok stopped (error_during_execution)." },
    ]);
  });
});
