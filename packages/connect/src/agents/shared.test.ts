import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { agentEnvironment, findExecutable, getMissingFlags, pickAgentDefault, runCommand } from "./shared.ts";

describe("agent plugin helpers", () => {
  it("should resolve a native Windows executable suffix on PATH", async () => {
    const folder = await mkdtemp(join(tmpdir(), "connect-path-"));
    const executable = join(folder, "codex.exe");
    await writeFile(executable, "");
    await chmod(executable, 0o700);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      expect(await findExecutable("codex", folder)).toBe(executable);
    } finally {
      platform.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  });
  it("should drop variables that would make an agent think it runs inside another session", () => {
    expect(agentEnvironment({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HOME: "/h" })).toEqual({
      PATH: "/bin",
      HOME: "/h",
    });
  });

  it("should stop a check whose signal aborts, without waiting for its timeout", async () => {
    const controller = new AbortController();
    const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], controller.signal);

    controller.abort();

    await expect(result).resolves.toMatchObject({ status: null });
  });

  it("should find a flag only when the help lists it whole", () => {
    expect(getMissingFlags("  --tools <list>\n  --allow-all", ["--tools", "--allow"])).toEqual(["--allow"]);
  });

  it("should start on the first default the account has, else the last", () => {
    const defaults = [{ model: "big" }, { model: "small" }] as const;

    expect(pickAgentDefault(defaults)).toEqual({ model: "big" });
    expect(pickAgentDefault(defaults, new Set(["small"]))).toEqual({ model: "small" });
    expect(pickAgentDefault(defaults, new Set())).toEqual({ model: "small" });
  });
});
