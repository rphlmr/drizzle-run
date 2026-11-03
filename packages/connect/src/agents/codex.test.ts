import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { connectToolsFor } from "@drizzle-run/core/connect";
import { afterEach, describe, expect, it } from "vitest";

import { makeFakeCli, type FakeFeature } from "../../test/fake-cli.ts";
import { tempFolder } from "../../test/harness.ts";
import {
  CODEX_CHOICES,
  CODEX_DISABLED_FEATURES,
  CODEX_MODEL_CATALOG_FILE,
  CODEX_REQUIRED_FLAGS,
  codexArgs,
  codexConfig,
  codexPlugin,
  parseCodexFeatures,
  parseCodexLine,
} from "./codex.ts";
import { NO_LOCKDOWN, type AgentLockdown, type RunCommand } from "./contract.ts";

const mcp = { command: "/usr/bin/node", args: ["/pkg/cli.js", "--mcp-ipc", "/tmp/s", "--turn", "tok"] };

const turn = { first: true, system: "sys", mcp, scope: "project", lockdown: NO_LOCKDOWN } as const;

const getFlagValue = (args: string[], name: string) => args[args.indexOf(name) + 1];

const getConfigs = (args: string[]) => args.filter((_, index) => args[index - 1] === "-c");

const toLine = (value: unknown) => JSON.stringify(value);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** A lockdown that switches off `switchedOff` and carries no model catalog. */
function makeLockdown(switchedOff: readonly string[]): AgentLockdown {
  return { switchedOff, files: {} };
}

/** Check a fake Codex that knows the lockdown's options and `--model`. */
function checkCodex(
  options: { forcedOn?: string[]; knowsShellTool?: boolean; extraFeatures?: (string | FakeFeature)[] } = {},
) {
  return codexPlugin.check("/bin/codex", makeFakeCli({ flags: [...CODEX_REQUIRED_FLAGS, "--model"], ...options }));
}

describe("Codex plugin", () => {
  it("should give Codex a no-network profile on the empty folder, its features off, and only the scope's tools", () => {
    const settings = getConfigs(codexConfig(mcp, { scope: "guide" }));
    const guideTools = connectToolsFor("guide").map((tool) => JSON.stringify(tool.name));

    expect(
      codexConfig(mcp)
        .filter((_, index) => index % 2 === 0)
        .every((flag) => flag === "-c"),
    ).toBe(true);
    expect(settings).toEqual(
      expect.arrayContaining([
        'default_permissions="drizzle-run"',
        'permissions.drizzle-run.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
        "permissions.drizzle-run.network.enabled=false",
        'approval_policy="never"',
        "agents.enabled=false",
        "features.multi_agent_v2={enabled=false,disable_native_tools=true}",
        'mcp_servers.drizzle-run.command="/usr/bin/node"',
        'mcp_servers.drizzle-run.args=["/pkg/cli.js","--mcp-ipc","/tmp/s","--turn","tok"]',
        `mcp_servers.drizzle-run.enabled_tools=[${guideTools.join(",")}]`,
        'mcp_servers.drizzle-run.default_tools_approval_mode="approve"',
        "skills.include_instructions=false",
        ...CODEX_DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
      ]),
    );
    expect(settings).not.toContain("features.code_mode_host=false");
    expect(settings).not.toContain("features.multi_agent_v2=false");
  });

  it("should start a thread, then resume it, with the prompt on stdin", () => {
    expect(codexArgs(turn).slice(0, 2)).toEqual(["exec", "--json"]);
    expect(codexArgs({ ...turn, session: "t1", first: false }).slice(0, 3)).toEqual(["exec", "resume", "t1"]);
    expect(codexArgs(turn).at(-1)).toBe("-");
  });

  it("should pass the turn's model, and its effort as an override", () => {
    const args = codexArgs({ ...turn, tuning: { model: "gpt-6-luna", effort: "high" } });

    expect(getFlagValue(args, "--model")).toBe("gpt-6-luna");
    expect(getConfigs(args)).toContain('model_reasoning_effort="high"');
    expect(codexArgs(turn).join(" ")).not.toContain("model_reasoning");
  });

  it("should give every turn the system prompt as developer instructions, and the prompt alone as input", async () => {
    const first = await codexPlugin.prepareTurn({
      ...turn,
      system: 'Be "brief".',
      prompt: "Hi",
      workdir: "/tmp/w",
      pluginFolder: "/tmp/p",
    });
    const later = await codexPlugin.prepareTurn({
      ...turn,
      session: "t1",
      first: false,
      prompt: "Hi",
      workdir: "/tmp/w",
      pluginFolder: "/tmp/p",
    });

    expect(first).toMatchObject({ stdin: "Hi", cwd: "/tmp/w" });
    expect(getConfigs(first.args)).toContain('developer_instructions="Be \\"brief\\"."');
    expect(later.stdin).toBe("Hi");
    expect(getConfigs(later.args)).toContain('developer_instructions="sys"');
    expect(first.args.join(" ")).not.toContain("model_catalog_json");
  });

  it("should run each turn on the check's model catalog, written in its own folder out of the agent's reach", async () => {
    const workdir = await tempFolder("drizzle-run-codex-test-");

    cleanups.push(workdir.remove);

    const lockdown = { switchedOff: [], files: { [CODEX_MODEL_CATALOG_FILE]: '{"models":[]}' } };
    const prepared = await codexPlugin.prepareTurn({
      ...turn,
      lockdown,
      prompt: "Hi",
      workdir: join(workdir.path, "agent"),
      pluginFolder: join(workdir.path, "plugins"),
    });
    const catalogSetting = getConfigs(prepared.args).find((setting) => setting.startsWith("model_catalog_json="));
    const catalogFile = String(JSON.parse(catalogSetting?.slice("model_catalog_json=".length) ?? '""'));

    expect(prepared.cwd).toBe(join(workdir.path, "agent"));
    expect(dirname(dirname(catalogFile))).toBe(join(workdir.path, "plugins", "codex"));
    expect(await readFile(catalogFile, "utf8")).toBe('{"models":[]}');
    expect((await stat(catalogFile)).mode & 0o777).toBe(0o600);

    await prepared.cleanup?.();

    await expect(access(dirname(catalogFile))).rejects.toThrow("ENOENT");
  });

  it("should offer Codex's documented models, starting on GPT-6 Sol when the account has it, else GPT-6 Luna", async () => {
    const flags = [...CODEX_REQUIRED_FLAGS, "--model"];
    const withSol = await codexPlugin.check(
      "/bin/codex",
      makeFakeCli({ flags, accountModels: ["gpt-6-luna", "gpt-6-sol"] }),
    );
    const freePlan = await codexPlugin.check("/bin/codex", makeFakeCli({ flags, accountModels: ["gpt-6-luna"] }));
    const unreadable = await codexPlugin.check("/bin/codex", makeFakeCli({ flags }));
    const withoutModel = await codexPlugin.check("/bin/codex", makeFakeCli({ flags: CODEX_REQUIRED_FLAGS }));

    expect(withSol).toMatchObject({
      ok: true,
      agent: { models: CODEX_CHOICES.models, defaults: { model: "gpt-6-sol", effort: "medium" } },
    });
    expect(freePlan).toMatchObject({
      ok: true,
      agent: { models: CODEX_CHOICES.models, defaults: { model: "gpt-6-luna", effort: "medium" } },
    });
    expect(unreadable).toMatchObject({ ok: true, agent: { defaults: { model: "gpt-6-luna" } } });
    expect(withoutModel).toMatchObject({ ok: true });
    expect(withoutModel).not.toHaveProperty("agent.models");
  });

  it("should keep the account's model catalog for every turn, with each model's file editing tool removed", async () => {
    const flags = [...CODEX_REQUIRED_FLAGS, "--model"];
    const check = await codexPlugin.check("/bin/codex", makeFakeCli({ flags, accountModels: ["gpt-6-luna"] }));
    const fakeCodex = makeFakeCli({ flags });
    const withoutCatalog: RunCommand = async (command, args) =>
      args[0] === "debug" ? { status: 1, stdout: "", stderr: "unknown command" } : fakeCodex(command, args);

    expect(check.ok).toBe(true);

    const catalog: unknown = JSON.parse(check.ok ? (check.lockdown.files[CODEX_MODEL_CATALOG_FILE] ?? "") : "");

    expect(catalog).toEqual({
      models: [
        {
          slug: "gpt-6-luna",
          visibility: "list",
          apply_patch_tool_type: null,
          base_instructions: "You are gpt-6-luna.",
        },
      ],
    });
    expect(await codexPlugin.check("/bin/codex", withoutCatalog)).toMatchObject({ ok: true, lockdown: { files: {} } });
    expect(
      await codexPlugin.check(
        "/bin/codex",
        makeFakeCli({ flags, accountModels: ["gpt-6-luna"], ignoresModelCatalog: true }),
      ),
    ).toMatchObject({ ok: true, lockdown: { files: {} } });
  });

  it("should refuse Codex when its help lacks a lockdown option", async () => {
    const withoutRules = CODEX_REQUIRED_FLAGS.filter((flag) => flag !== "--ignore-rules");

    expect(await codexPlugin.check("/bin/codex", makeFakeCli({ flags: withoutRules }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--ignore-rules"),
    });
  });

  it("should turn off a feature Drizzle Run does not know, dotted names too, and pass them to every turn", async () => {
    const check = await checkCodex({ extraFeatures: ["remote_shell_v3", "guardianv2.thread_context"] });

    expect(check).toMatchObject({
      ok: true,
      lockdown: { switchedOff: ["remote_shell_v3", "guardianv2.thread_context"] },
    });
    expect(codexArgs({ ...turn, lockdown: makeLockdown(["remote_shell_v3", "guardianv2.thread_context"]) })).toEqual(
      expect.arrayContaining(["features.remote_shell_v3=false", "features.guardianv2.thread_context=false"]),
    );
    expect(await checkCodex({ extraFeatures: ["guardianv2..x"] })).toMatchObject({ ok: false });
  });

  it("should refuse Codex when a feature stays on, or command execution is unknown", async () => {
    expect(await checkCodex({ forcedOn: ["remote_shell_v3"], extraFeatures: ["remote_shell_v3"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("remote_shell_v3"),
    });
    expect(await checkCodex({ forcedOn: ["hooks"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("hooks"),
    });
    expect(await checkCodex({ knowsShellTool: false })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("shell_tool"),
    });
  });

  it("should keep code mode and unified exec on, and leave removed and deprecated features alone", async () => {
    const check = await checkCodex({
      forcedOn: ["code_mode_host", "unified_exec"],
      extraFeatures: [
        "code_mode_host",
        "unified_exec",
        { name: "tool_search_always_defer_mcp_tools", stage: "removed" },
        { name: "web_search_cached", stage: "deprecated", enabled: false },
      ],
    });

    expect(check).toMatchObject({ ok: true, lockdown: { switchedOff: [] } });
    expect(
      await checkCodex({ extraFeatures: [{ name: "web_search_request", stage: "deprecated", enabled: true }] }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("web_search_request") });
  });

  it("should read codex features list with each feature's stage, whatever columns follow", () => {
    const featureList = [
      "Feature                      Stage              Enabled",
      "shell_tool                   stable             false",
      "code_mode                    under development  false",
      "unified_exec    stable   true",
      "fancy_tool  stable  true  (default)",
      "web-fetch  stable  true",
      "noise",
    ].join("\n");

    expect(parseCodexFeatures(featureList)).toEqual(
      new Map([
        ["shell_tool", { stage: "stable", enabled: false }],
        ["code_mode", { stage: "under development", enabled: false }],
        ["unified_exec", { stage: "stable", enabled: true }],
        ["fancy_tool", { stage: "stable", enabled: true }],
        ["web-fetch", { stage: "stable", enabled: true }],
      ]),
    );
  });

  it("should refuse Codex when a feature has a name Drizzle Run cannot turn off", async () => {
    expect(await checkCodex({ extraFeatures: ["web-fetch"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("web-fetch"),
    });
  });

  it("should read exec JSONL: the thread, messages, failures and the end", () => {
    expect(parseCodexLine(toLine({ type: "thread.started", thread_id: "t1" }))).toEqual([
      { kind: "session", id: "t1" },
    ]);
    expect(parseCodexLine(toLine({ type: "item.completed", item: { type: "agent_message", text: "Hi" } }))).toEqual([
      { kind: "message" },
      { kind: "text", text: "Hi" },
    ]);
    expect(parseCodexLine(toLine({ type: "item.completed", item: { type: "reasoning", text: "hmm" } }))).toEqual([]);
    expect(parseCodexLine(toLine({ type: "turn.failed", error: { message: "401" } }))).toEqual([
      { kind: "failed", error: "401" },
    ]);
    expect(parseCodexLine(toLine({ type: "turn.completed" }))).toEqual([{ kind: "finished" }]);
  });

  it("should name every tool item, so a turn can refuse any beyond Drizzle Run's", () => {
    const mcpCall = (server: string) =>
      toLine({ type: "item.started", item: { type: "mcp_tool_call", server, tool: "read_file" } });

    expect(parseCodexLine(mcpCall("drizzle-run"))).toEqual([{ kind: "tool", name: "mcp__drizzle-run__read_file" }]);
    expect(parseCodexLine(mcpCall("filesystem"))).toEqual([{ kind: "tool", name: "mcp__filesystem__read_file" }]);
    expect(parseCodexLine(toLine({ type: "item.started", item: { type: "command_execution" } }))).toEqual([
      { kind: "tool", name: "codex:command_execution" },
    ]);
  });
});
