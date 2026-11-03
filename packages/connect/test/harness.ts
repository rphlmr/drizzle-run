import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveConnectKeys,
  SecureChannel,
  type AgentId,
  type ConnectMessage,
  type RelayServerFrame,
} from "@drizzle-run/core/connect";
import { delay } from "es-toolkit";

import type { RelaySocketLike } from "../src/relay.ts";

/** Test helpers: a scripted agent on a temp PATH, a fake relay, and a tab that speaks the sealed protocol. */

/** The pairing secret every test pairs with. */
export const SECRET = "k7Pq-2xZm-9fLw";
/** Few key derivation rounds, so tests stay fast. */
export const ITERATIONS = 1_000;
/** The scripted stand-in for the agent CLIs. */
export const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
/** The command line entry, run from source. */
export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Create a temp folder; `remove` deletes it and everything in it. */
export async function tempFolder(prefix: string): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));

  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

/** Link the fake agent in `folder` under each agent's executable name (`claude`, `codex`, `grok`), for PATH. */
export async function fakeAgentBin(folder: string, names: readonly AgentId[]): Promise<string> {
  for (const name of names) {
    await symlink(FAKE_AGENT, join(folder, name));
  }

  return folder;
}

/**
 * Write a list of fake agent steps, or `{ byPrompt }` to script each turn by its prompt, to a new JSON file in
 * `folder`. Returns the file path.
 */
export async function writeScript(
  folder: string,
  steps: readonly Record<string, unknown>[] | { byPrompt: Record<string, readonly Record<string, unknown>[]> },
): Promise<string> {
  const path = join(folder, `script-${Math.random().toString(36).slice(2)}.json`);

  await writeFile(path, JSON.stringify(steps));

  return path;
}

/** One turn the fake agent ran, as it logged it. */
export interface AgentLogEntry {
  agent: string;
  argv: string[];
  cwd: string;
  prompt: string;
  tools: string[];
  results: { name: string; isError: boolean; text: string }[];
}

/** Read the fake agent's log. Returns an empty list when there is no log yet. */
export async function readAgentLog(path: string): Promise<AgentLogEntry[]> {
  try {
    const logText = await readFile(path, "utf8");

    return logText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentLogEntry);
  } catch {
    return [];
  }
}

type Listener = (event: never) => void;

/** One relay room with the companion's socket, seen from the relay. */
export class FakeRelay {
  url = "";
  /** The subprotocols the companion offered. */
  protocols: readonly string[] = [];
  /** Every frame the companion sent, as the relay sees it. */
  frames: string[] = [];
  private listeners = new Map<string, Listener[]>();
  closedWith: number | undefined;

  open = (url: string, protocols: readonly string[]): RelaySocketLike => {
    this.url = url;
    this.protocols = protocols;
    this.listeners = new Map();
    this.closedWith = undefined;

    const socket = {
      send: (text: string) => {
        this.frames.push(text);
        this.onSend?.(text);
      },
      close: (code?: number) => {
        this.closedWith = code;
        this.emit("close", { code: code ?? 1000, reason: "" });
      },
      addEventListener: (type: string, listener: Listener) => {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      },
    };

    // One untyped listener store stands in for the overloaded `addEventListener`.
    return socket;
  };

  onSend: ((text: string) => void) | undefined;

  /** Fire a socket event at the companion. */
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (value: unknown) => void)(event);
    }
  }

  /** Send a relay server frame to the companion. */
  server(frame: RelayServerFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

type Message = Exclude<ConnectMessage, { type: "hello" }>;

/** A Drizzle Run tab in the room: it opens what the companion sends it and answers tool calls. */
export class FakeTab {
  readonly id: string;
  readonly relay: FakeRelay;
  channel: SecureChannel | undefined;
  received: ConnectMessage[] = [];
  answer: ((call: Extract<Message, { type: "tool.call" }>) => Message | undefined) | undefined;

  constructor(relay: FakeRelay, id = "tab1") {
    this.relay = relay;
    this.id = id;
  }

  /** Join the room and wait for the companion's hello. */
  async join(): Promise<void> {
    const { key } = await deriveConnectKeys(SECRET, { iterations: ITERATIONS });

    this.channel = new SecureChannel({ key, role: "tab" });

    const previousOnSend = this.relay.onSend;

    this.relay.onSend = (text) => {
      previousOnSend?.(text);
      void this.onFrame(text);
    };
    this.relay.server({ t: "peer", event: "join", peer: { id: this.id, role: "tab" } });
    await this.until("hello");
  }

  private async onFrame(text: string): Promise<void> {
    const frame = JSON.parse(text) as { to: string; d: string };

    if (frame.to !== this.id || this.channel === undefined) {
      return;
    }

    const opened = await this.channel.open("companion", frame.d);

    if (!opened.ok) {
      return;
    }

    this.received.push(opened.message);

    if (opened.message.type === "hello" && opened.answerHello) {
      const hello = await this.channel.hello("companion", { type: "hello", role: "tab", protocol: { min: 1, max: 1 } });

      this.relay.server({ t: "data", from: this.id, d: hello });
    }

    if (opened.message.type === "tool.call") {
      const reply = this.answer?.(opened.message) ?? {
        type: "tool.result",
        id: opened.message.id,
        ok: true,
        result: { project: "Bank transfers" },
      };

      await this.say(reply);
    }
  }

  /** Send a sealed message to the companion. Throws before `join`. */
  async say(message: Message): Promise<void> {
    if (this.channel === undefined) {
      throw new Error("The tab has not joined.");
    }

    this.relay.server({ t: "data", from: this.id, d: await this.channel.seal("companion", message) });
  }

  /** Leave the room. */
  leave(): void {
    this.relay.server({ t: "peer", event: "leave", peer: { id: this.id, role: "tab" } });
  }

  /** Get every received message of one type, in order. */
  messages<Type extends ConnectMessage["type"]>(type: Type): Extract<ConnectMessage, { type: Type }>[] {
    return this.received.filter((message): message is Extract<ConnectMessage, { type: Type }> => message.type === type);
  }

  /** Wait until `count` messages of one type arrived. Throws, listing what did arrive, after `timeoutMs`. */
  async until<Type extends ConnectMessage["type"]>(
    type: Type,
    count = 1,
    timeoutMs = 10_000,
  ): Promise<Extract<ConnectMessage, { type: Type }>[]> {
    const startedAt = Date.now();

    while (this.messages(type).length < count) {
      if (Date.now() - startedAt > timeoutMs) {
        const receivedTypes = this.received.map((message) => message.type).join(", ");

        throw new Error(`No ${type} after ${timeoutMs} ms; got ${receivedTypes}`);
      }

      await delay(10);
    }

    return this.messages(type);
  }
}
