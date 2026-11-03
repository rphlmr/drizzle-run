import { describe, expect, it } from "vitest";

import { makeFakeCli } from "../../test/fake-cli.ts";
import { CLAUDE_REQUIRED_FLAGS, claudeArgs, claudePlugin } from "./claude.ts";
import { NO_LOCKDOWN } from "./contract.ts";

const mcp = { command: "/usr/bin/node", args: ["/pkg/cli.js", "--mcp-ipc", "/tmp/s", "--turn", "tok"] };

const turn = { session: "s1", first: true, system: "sys", mcp, scope: "project" } as const;

const getFlagValue = (args: string[], name: string) => args[args.indexOf(name) + 1];

const toLine = (value: unknown) => JSON.stringify(value);

describe("Claude Code plugin", () => {
  it("should give Claude Code no built-in tool, only the Drizzle Run server, no settings, and no prompts", () => {
    const first = claudeArgs(turn);
    const later = claudeArgs({ ...turn, first: false });

    expect(getFlagValue(first, "--tools")).toBe("");
    expect(getFlagValue(first, "--setting-sources")).toBe("");
    expect(getFlagValue(first, "--permission-mode")).toBe("dontAsk");
    expect(JSON.parse(getFlagValue(first, "--mcp-config") ?? "")).toEqual({
      mcpServers: { "drizzle-run": { type: "stdio", ...mcp } },
    });
    expect(first).toEqual(
      expect.arrayContaining(["--strict-mcp-config", "--restricted", "--disable-slash-commands", "--session-id"]),
    );
    expect(later).toContain("--resume");
    expect(later).not.toContain("--session-id");
    expect(() => claudeArgs({ first: true, system: "", mcp, scope: "project" })).toThrow(
      "A Claude Code turn needs a session id.",
    );
  });

  it("should pass the turn's model and effort in their own options", () => {
    const args = claudeArgs({ ...turn, tuning: { model: "opus", effort: "high" } });

    expect(getFlagValue(args, "--model")).toBe("opus");
    expect(getFlagValue(args, "--effort")).toBe("high");
    expect(claudeArgs(turn)).not.toContain("--model");
  });

  it("should run in the companion's folder with the prompt on stdin", async () => {
    const prepared = await claudePlugin.prepareTurn({
      ...turn,
      prompt: "Hi",
      workdir: "/tmp/w",
      pluginFolder: "/tmp/p",
      lockdown: NO_LOCKDOWN,
    });

    expect(prepared).toMatchObject({ stdin: "Hi", cwd: "/tmp/w" });
    expect(prepared.args).toContain("--session-id");
  });

  it("should offer Claude Code's aliases and defaults, with effort levels only when its help lists --effort", async () => {
    const withEffort = await claudePlugin.check(
      "/bin/claude",
      makeFakeCli({ flags: [...CLAUDE_REQUIRED_FLAGS, "--model", "--effort"] }),
    );
    const withoutEffort = await claudePlugin.check(
      "/bin/claude",
      makeFakeCli({ flags: [...CLAUDE_REQUIRED_FLAGS, "--model"] }),
    );
    const withoutModel = await claudePlugin.check("/bin/claude", makeFakeCli({ flags: CLAUDE_REQUIRED_FLAGS }));

    expect(withEffort).toMatchObject({
      ok: true,
      agent: {
        models: expect.arrayContaining([
          { id: "opus", name: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
        ]),
        defaults: { model: "opus", effort: "medium" },
      },
    });
    expect(withoutEffort).toMatchObject({
      ok: true,
      agent: {
        models: expect.arrayContaining([{ id: "opus", name: "Opus", efforts: [] }]),
        defaults: { model: "opus" },
      },
    });
    expect(withoutEffort).not.toHaveProperty("agent.defaults.effort");
    expect(withoutModel).toMatchObject({ ok: true });
    expect(withoutModel).not.toHaveProperty("agent.models");
  });

  it("should offer Claude Code only when its help lists every lockdown option and the dontAsk mode", async () => {
    expect(await claudePlugin.check("/bin/claude", makeFakeCli({ flags: CLAUDE_REQUIRED_FLAGS }))).toMatchObject({
      ok: true,
      lockdown: NO_LOCKDOWN,
      agent: { id: "claude", version: "1.2.3" },
    });

    const withoutRestricted = CLAUDE_REQUIRED_FLAGS.filter((flag) => flag !== "--restricted");

    expect(await claudePlugin.check("/bin/claude", makeFakeCli({ flags: withoutRestricted }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--restricted"),
    });

    const withLongerFlag = [...CLAUDE_REQUIRED_FLAGS.filter((flag) => flag !== "--tools"), "--tools-extra"];

    expect(await claudePlugin.check("/bin/claude", makeFakeCli({ flags: withLongerFlag }))).toMatchObject({
      ok: false,
    });
    expect(
      await claudePlugin.check(
        "/bin/claude",
        makeFakeCli({ flags: CLAUDE_REQUIRED_FLAGS, modes: '(choices: "default", "plan")' }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("--permission-mode dontAsk") });
  });

  it("should read stream-json: streamed text, whole messages without deltas, and the result", () => {
    const parse = claudePlugin.createParser({ allowedTools: ["get_project"] });
    const wholeMessage = toLine({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } });

    expect(parse(toLine({ type: "stream_event", event: { type: "message_start" } }))).toEqual([{ kind: "message" }]);
    expect(
      parse(
        toLine({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        }),
      ),
    ).toEqual([{ kind: "text", text: "Hi" }]);
    expect(parse(wholeMessage)).toEqual([]);
    expect(claudePlugin.createParser({ allowedTools: [] })(wholeMessage)).toEqual([
      { kind: "message" },
      { kind: "text", text: "Hi" },
    ]);
    expect(parse(toLine({ type: "result", subtype: "success", is_error: false }))).toEqual([{ kind: "finished" }]);
    expect(parse(toLine({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }))).toEqual([
      { kind: "failed", error: "Claude Code stopped (error_max_turns)." },
    ]);
  });

  it("should flag a session that starts with tools beyond the turn's, without its tool list, or in another mode", () => {
    const parse = claudePlugin.createParser({ allowedTools: ["get_project"] });
    const init = { type: "system", subtype: "init", permissionMode: "dontAsk" };

    expect(parse(toLine({ ...init, tools: ["mcp__drizzle-run__get_project", "ListMcpResourcesTool"] }))).toEqual([]);
    expect(parse(toLine({ ...init, tools: ["mcp__drizzle-run__get_project", "Bash"] }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("(Bash)") },
    ]);
    expect(parse(toLine(init))).toEqual([{ kind: "unsafe", reason: expect.stringContaining("did not say") }]);
    expect(parse(toLine({ ...init, tools: [], permissionMode: "default" }))).toEqual([
      { kind: "unsafe", reason: expect.stringContaining("default mode") },
    ]);
  });

  it("should name every tool the agent calls, a tool the API runs by its type", () => {
    const parse = claudePlugin.createParser({ allowedTools: [] });

    expect(
      parse(
        toLine({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", input: {} } },
        }),
      ),
    ).toEqual([{ kind: "tool", name: "Bash" }]);
    expect(
      parse(
        toLine({
          type: "assistant",
          message: {
            content: [
              { type: "server_tool_use", name: "web_search" },
              { type: "text", text: "Hi" },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: "tool", name: "server_tool_use:web_search" }]);
  });
});
