import { access, rm } from "node:fs/promises";
import { createConnection, Server } from "node:net";
import { dirname } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { connectToolSocket, openToolSocket, type ToolSocket } from "./ipc.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function startToolSocket(): Promise<ToolSocket> {
  const toolSocket = await openToolSocket(async (token, name) => ({ ok: true, result: { token, name } }));

  cleanups.push(() => toolSocket.close());

  return toolSocket;
}

/** Send one raw line and resolve once the companion closes the connection. */
function sendRawLine(path: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection(path, () => socket.write(`${line}\n`));

    socket.on("error", () => undefined);
    socket.on("close", () => resolve());
  });
}

describe("tool socket", () => {
  it.skipIf(process.platform === "win32")("should remove its temporary directory when listening fails", async () => {
    let folder = "";
    const failure = new Error("listen denied");
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
      if (typeof args[0] === "string") {
        folder = dirname(args[0]);
      }

      queueMicrotask(() => this.emit("error", failure));
      return this;
    });

    try {
      await expect(openToolSocket(async () => ({ ok: true, result: null }))).rejects.toBe(failure);
      expect(folder).not.toBe("");

      await expect(access(folder)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      listen.mockRestore();

      if (folder !== "") {
        await rm(folder, { recursive: true, force: true });
      }
    }
  });
  it("should forward a call with its turn token and answer it", async () => {
    const toolSocket = await startToolSocket();
    const toolLink = connectToolSocket(toolSocket.path, "turn-1");

    cleanups.push(() => toolLink.close());

    expect(await toolLink.call("get_project", {})).toEqual({
      ok: true,
      result: { token: "turn-1", name: "get_project" },
    });
  });

  it.each(["null", "[]", "42", '"text"', "{ not json", '{"token":"t","id":1,"name":"Bash"}'])(
    "should close the connection on the malformed request %s and keep serving others",
    async (line) => {
      const toolSocket = await startToolSocket();

      await sendRawLine(toolSocket.path, line);

      const toolLink = connectToolSocket(toolSocket.path, "turn-1");

      cleanups.push(() => toolLink.close());

      expect(await toolLink.call("get_project", {})).toMatchObject({ ok: true });
    },
  );
});
