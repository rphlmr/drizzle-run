import { spawn } from "node:child_process";
import { mkdir, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI, fakeAgentBin, tempFolder } from "../test/harness.ts";
import { readPairing } from "./home.ts";

/** The real command line, with a temp home and fake agents on PATH. It never reaches a relay. */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function makeCliEnvironment() {
  const scratch = await tempFolder("drizzle-run-cli-test-");
  const bin = join(scratch.path, "bin");
  const home = join(scratch.path, "home");

  await mkdir(bin);
  await fakeAgentBin(bin, ["claude"]);
  await symlink(process.execPath, join(bin, "node"));
  cleanups.push(scratch.remove);

  return { home, env: { ...process.env, DRIZZLE_RUN_HOME: home, PATH: `${bin}:/usr/bin:/bin` } };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";

  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  cleanups.push(() => {
    child.kill("SIGKILL");
  });

  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

  return { child, exited, output: () => output };
}

describe("npx @drizzle-run/connect", () => {
  it("should pair with a code, remember it owner-only, then rejoin without it", async () => {
    const { home, env } = await makeCliEnvironment();
    // Port 9 refuses connections: the companion keeps retrying, which is enough here.
    const paired = runCli(["k7Pq-2xZm-9fLw", "--relay", "http://127.0.0.1:9"], env);

    await vi.waitFor(() => expect(paired.output()).toContain("Paired."), { timeout: 10_000 });
    expect(await readPairing(home)).toMatchObject({ secret: "k7Pq-2xZm-9fLw", relay: "http://127.0.0.1:9" });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "connect.json"))).mode & 0o777).toBe(0o600);
    await vi.waitFor(() => expect(paired.output()).toContain("Agents: Claude Code (9.9.9 (claude))."), {
      timeout: 10_000,
    });
    paired.child.kill("SIGINT");
    expect(await paired.exited).toBe(0);

    const rejoined = runCli([], env);

    await vi.waitFor(() => expect(rejoined.output()).toContain("relay http://127.0.0.1:9"), { timeout: 10_000 });
    expect(rejoined.output()).not.toContain("Paired.");
    rejoined.child.kill("SIGINT");
    await rejoined.exited;

    const forgot = runCli(["--forget"], env);

    expect(await forgot.exited).toBe(0);
    expect(await readPairing(home)).toBeUndefined();
  });

  it("should exit cleanly on Ctrl+C during startup, leaving no agent folder behind", async () => {
    const { env } = await makeCliEnvironment();
    const tempRoot = await tempFolder("drizzle-run-cli-tmp-");

    cleanups.push(tempRoot.remove);

    const started = runCli(["k7Pq-2xZm-9fLw", "--relay", "http://127.0.0.1:9"], { ...env, TMPDIR: tempRoot.path });

    await vi.waitFor(() => expect(started.output()).toContain("Agents:"), { timeout: 10_000, interval: 1 });
    started.child.kill("SIGINT");
    expect(await started.exited).toBe(0);
    expect(await readdir(tempRoot.path)).toEqual([]);
  });

  it("should serve the Drizzle Run tools over stdio with --mcp, answering no_tab until a tab connects", async () => {
    const { env } = await makeCliEnvironment();
    const served = runCli(["k7Pq-2xZm-9fLw", "--mcp", "--relay", "http://127.0.0.1:9"], env);
    const replies: {
      id: number;
      result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
    }[] = [];
    let buffer = "";

    served.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;

      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        replies.push(JSON.parse(buffer.slice(0, index)) as (typeof replies)[number]);
        buffer = buffer.slice(index + 1);
      }
    });

    const sendRequest = (id: number, method: string, params: Record<string, unknown> = {}) => {
      served.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };

    sendRequest(1, "initialize", { protocolVersion: "2025-06-18" });
    sendRequest(2, "tools/list");
    sendRequest(3, "tools/call", { name: "get_project", arguments: {} });
    await vi.waitFor(() => expect(replies).toHaveLength(3), { timeout: 10_000 });
    expect(replies[1]?.result?.tools?.map((tool) => tool.name)).toContain("apply_edits");
    expect(replies[2]?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no_tab") }] });
    expect(served.output()).toContain("Paired.");

    served.child.stdin.end();
    expect(await served.exited).toBe(0);
  });

  it("should ask to pair first when this computer has no pairing", async () => {
    const { env } = await makeCliEnvironment();
    const unpaired = runCli([], env);

    expect(await unpaired.exited).toBe(1);
    expect(unpaired.output()).toContain("not paired yet");
  });

  it("should refuse an agent CLI that lacks a lockdown option", async () => {
    const { env } = await makeCliEnvironment();
    const refused = runCli(["k7Pq-2xZm-9fLw", "--relay", "http://127.0.0.1:9"], {
      ...env,
      FAKE_AGENT_DROP_FLAG: "--restricted",
    });

    expect(await refused.exited).toBe(1);
    expect(refused.output()).toContain("lacks options Drizzle Run needs");
    expect(refused.output()).toContain("--restricted");
  });
});
