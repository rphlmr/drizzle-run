import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  isConnectToolName,
  isToolErrorCode,
  type ConnectToolName,
  type ToolErrorCode,
} from "@drizzle-run/core/connect";
import * as z from "zod/mini";

import type { CallTool, ToolOutcome } from "./mcp-server.ts";

/**
 * The private line between the companion and the MCP server its agent starts: a Unix
 * socket in a fresh owner-only folder, apart from the agent's working folder, or a named
 * pipe with a random name on Windows, which has no Unix sockets. Each request carries the
 * turn's random token, so a call is tied to the chat turn that made it.
 */

/** The companion's side of a tool call: `token` names the chat turn that made it. */
export type HandleToolCall = (token: string, name: ConnectToolName, input: unknown) => Promise<ToolOutcome>;

/** The open tool socket. `close` stops listening and removes its folder. */
export interface ToolSocket {
  path: string;
  close(): Promise<void>;
}

// macOS caps a socket path near 104 bytes; long temp folders fall back to /tmp.
const MAX_SOCKET_PATH_LENGTH = 100;

const SOCKET_FILE_NAME = "s";

const ToolRequestSchema = z.object({
  token: z.string(),
  id: z.number(),
  name: z.custom<ConnectToolName>((value) => isConnectToolName(value)),
  input: z.unknown(),
});

const ToolOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.custom<ToolErrorCode>((value) => isToolErrorCode(value)), message: z.string() }),
  }),
]);

const ToolReplySchema = z.object({ id: z.number(), outcome: ToolOutcomeSchema });

/** A line's JSON value, or undefined when it is not JSON. */
function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function onEachLine(socket: Socket, onLine: (line: string) => void): void {
  createInterface({ input: socket, crlfDelay: Infinity }).on("line", onLine);
}

/** A fresh owner-only folder for the socket file, in /tmp when the temp folder's path is too long for a socket. */
async function createSocketFolder(): Promise<string> {
  const tempFolder = await mkdtemp(join(tmpdir(), "drizzle-run-ipc-"));

  if (join(tempFolder, SOCKET_FILE_NAME).length <= MAX_SOCKET_PATH_LENGTH) {
    return tempFolder;
  }

  await rm(tempFolder, { recursive: true, force: true });

  return mkdtemp("/tmp/drizzle-run-ipc-");
}

/**
 * Open the companion's tool socket
 *
 * A request that is not JSON, or lacks a string token, a numeric id, or a known tool name, closes
 * its connection. A handler that throws answers `failed` with the error message.
 */
export async function openToolSocket(handle: HandleToolCall): Promise<ToolSocket> {
  const folder = process.platform === "win32" ? undefined : await createSocketFolder();
  const path = folder === undefined ? `\\\\.\\pipe\\drizzle-run-ipc-${randomUUID()}` : join(folder, SOCKET_FILE_NAME);
  const server = createServer((socket) => {
    onEachLine(socket, (line) => {
      const request = ToolRequestSchema.safeParse(parseJsonLine(line));

      if (!request.success) {
        socket.destroy();
        return;
      }

      const { token, id, name, input } = request.data;

      // The catch turns every tool failure into an outcome, so the chain only answers the socket.
      void handle(token, name, input)
        .catch((error: unknown): ToolOutcome => ({
          ok: false,
          error: {
            code: "failed",
            message: error instanceof Error ? error.message : "The tool failed.",
          },
        }))
        .then((outcome) => {
          if (!socket.destroyed) {
            socket.write(`${JSON.stringify({ id, outcome })}\n`);
          }
        });
    });
    socket.on("error", () => socket.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // mkdtemp made the folder 0700, so only this user can reach a Unix socket.
      server.listen(path, () => resolve());
    });
  } catch (cause) {
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true });
    }

    throw cause;
  }

  return {
    path,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));

      if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}

/** Read one reply line from the companion, or undefined when it is not JSON or not a tool reply */
function readToolReply(line: string): { id: number; outcome: ToolOutcome } | undefined {
  const reply = ToolReplySchema.safeParse(parseJsonLine(line));

  return reply.success ? reply.data : undefined;
}

/**
 * Connect the MCP server to its companion
 *
 * Every tool call goes to the companion. Once the socket errors or closes, waiting and later calls
 * answer `unavailable`.
 */
export function connectToolSocket(path: string, token: string): { call: CallTool; close(): void } {
  const socket = createConnection(path);
  const waitingCalls = new Map<number, (outcome: ToolOutcome) => void>();
  let lastCallId = 0;
  let brokenReason: string | undefined;

  const failWaitingCalls = (message: string) => {
    brokenReason = message;

    for (const resolve of waitingCalls.values()) {
      resolve({ ok: false, error: { code: "unavailable", message } });
    }

    waitingCalls.clear();
  };

  onEachLine(socket, (line) => {
    const reply = readToolReply(line);

    // A broken line from our own companion; the call times out on the agent's side.
    if (reply === undefined) {
      return;
    }

    const resolve = waitingCalls.get(reply.id);

    waitingCalls.delete(reply.id);
    resolve?.(reply.outcome);
  });
  socket.on("error", () => failWaitingCalls("The Drizzle Run companion is gone."));
  socket.on("close", () => failWaitingCalls("The Drizzle Run companion is gone."));

  return {
    call: (name, input) => {
      if (brokenReason !== undefined) {
        return Promise.resolve({ ok: false, error: { code: "unavailable", message: brokenReason } });
      }

      lastCallId += 1;

      const id = lastCallId;

      return new Promise((resolve) => {
        waitingCalls.set(id, resolve);
        socket.write(`${JSON.stringify({ token, id, name, input })}\n`);
      });
    },
    close: () => socket.end(),
  };
}
