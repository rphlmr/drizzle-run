import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempFolder } from "../test/harness.ts";
import { clearPairing, connectHome, readPairing, writePairing } from "./home.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function makeHome() {
  const folder = await tempFolder("drizzle-run-home-test-");

  cleanups.push(folder.remove);

  return join(folder.path, ".drizzle-run");
}

const pairing = { secret: "k7Pq-2xZm-9fLw", relay: "https://drizzle.run", pairedAt: "2026-10-15T10:00:00.000Z" };

describe("pairing memory", () => {
  it("should live in ~/.drizzle-run unless DRIZZLE_RUN_HOME moves it", () => {
    expect(connectHome({})).toBe(join(homedir(), ".drizzle-run"));
    expect(connectHome({ DRIZZLE_RUN_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("should remember a pairing owner-only, and forget it", async () => {
    const path = await makeHome();

    expect(await readPairing(path)).toBeUndefined();
    await writePairing(pairing, path);
    expect(await readPairing(path)).toEqual(pairing);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(path, "connect.json"))).mode & 0o777).toBe(0o600);

    await clearPairing(path);
    expect(await readPairing(path)).toBeUndefined();
    await clearPairing(path);
  });

  it("should tighten a folder or file that others could read", async () => {
    const path = await makeHome();

    await writePairing(pairing, path);
    await chmod(path, 0o755);
    await chmod(join(path, "connect.json"), 0o644);
    expect(await readPairing(path)).toEqual(pairing);
    expect((await stat(join(path, "connect.json"))).mode & 0o777).toBe(0o600);

    await writePairing({ ...pairing, relay: "http://127.0.0.1:4173" }, path);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(path, "connect.json"), "utf8"))).toMatchObject({
      relay: "http://127.0.0.1:4173",
    });
  });

  it("should ignore a damaged file and refuse a link", async () => {
    const path = await makeHome();

    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, "connect.json"), "{ not json", { mode: 0o600 });
    expect(await readPairing(path)).toBeUndefined();
    await writeFile(join(path, "connect.json"), JSON.stringify({ ...pairing, secret: "short" }), { mode: 0o600 });
    expect(await readPairing(path)).toBeUndefined();

    await clearPairing(path);
    await writeFile(join(path, "elsewhere.json"), JSON.stringify(pairing));
    await symlink(join(path, "elsewhere.json"), join(path, "connect.json"));
    await expect(readPairing(path)).rejects.toThrow("not a plain file");
  });

  it("should report a pairing file it cannot read instead of calling the computer unpaired", async () => {
    const path = await makeHome();

    await writePairing(pairing, path);
    await chmod(join(path, "connect.json"), 0o000);

    await expect(readPairing(path)).rejects.toThrow("Cannot read the pairing");
  });
});
