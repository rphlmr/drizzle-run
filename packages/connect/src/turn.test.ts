import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import type { TurnEvent } from "./agents/index.ts";
import { startTurn, type RunningTurn } from "./turn.ts";

/** A script for `node -e` that prints each event as a JSON line, in one write, then waits or exits. */
function makeAgentScript({
  events,
  exit = "wait",
  stderr = "",
}: {
  events: readonly TurnEvent[];
  exit?: "wait" | number;
  stderr?: string;
}) {
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  const ending = exit === "wait" ? "setInterval(() => {}, 1000);" : `process.exit(${exit});`;

  return `process.stderr.write(${JSON.stringify(stderr)}); process.stdout.write(${JSON.stringify(lines)}, () => { ${ending} });`;
}

function startScriptedTurn({
  script,
  onEvent,
  allowedTools = [],
}: {
  script: string;
  onEvent?: (event: TurnEvent, turn: RunningTurn) => void;
  allowedTools?: readonly string[];
}) {
  const onText = vi.fn();
  const turn: RunningTurn = startTurn({
    command: process.execPath,
    args: ["-e", script],
    prompt: "",
    cwd: tmpdir(),
    env: process.env,
    onText,
    parser: (line) => {
      const event = JSON.parse(line) as TurnEvent;

      queueMicrotask(() => onEvent?.(event, turn));

      return [event];
    },
    allowedTools,
    batchMs: 5,
  });

  return { turn, onText };
}

describe("startTurn", () => {
  it.skipIf(process.platform === "win32")(
    "should kill surviving helpers after the process group leader exits",
    async () => {
      const ready = Promise.withResolvers<void>();
      let helperPid = 0;
      const helper = `process.on('SIGTERM', () => {}); console.log(JSON.stringify({kind:'text',text:String(process.pid)})); setInterval(() => {}, 1000);`;
      const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit']}); child.unref(); process.exit(0);`;
      const { turn } = startScriptedTurn({
        script,
        onEvent: (event) => {
          if (event.kind === "text") {
            helperPid = Number(event.text);
            ready.resolve();
          }
        },
      });

      try {
        await ready.promise;
        turn.stop();
        const outcome = await Promise.race([
          turn.done,
          new Promise<"timeout">((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), 4_000);
            timer.unref();
          }),
        ]);
        expect(outcome).toEqual({ state: "stopped" });
        expect(() => process.kill(helperPid, 0)).toThrow(/ESRCH/);
      } finally {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {}
        turn.stop();
        await turn.done;
      }
    },
    6_000,
  );
  it("should send the text of separate messages as one batch, apart by a blank line, and end done", async () => {
    const { turn, onText } = startScriptedTurn({
      script: makeAgentScript({
        events: [{ kind: "text", text: "Hi" }, { kind: "message" }, { kind: "text", text: "There" }],
        exit: 0,
      }),
    });

    expect(await turn.done).toEqual({ state: "done" });
    expect(onText.mock.calls).toEqual([["Hi\n\nThere"]]);
  });

  it("should end stopped when the user stops it", async () => {
    const { turn } = startScriptedTurn({
      script: makeAgentScript({ events: [{ kind: "text", text: "Working" }] }),
      onEvent: (_, running) => running.stop(),
    });

    expect(await turn.done).toEqual({ state: "stopped" });
  });

  it("should fail with the last stderr lines when the agent exits non-zero without saying why", async () => {
    const { turn } = startScriptedTurn({
      script: makeAgentScript({ events: [], exit: 3, stderr: "one\ntwo\nthree\nfour\n" }),
    });

    expect(await turn.done).toEqual({ state: "failed", error: "two\nthree\nfour" });
  });

  it("should keep a refusal's reason when a stop comes before the agent is gone", async () => {
    const { turn } = startScriptedTurn({
      script: makeAgentScript({ events: [{ kind: "unsafe", reason: "The CLI started with a shell." }] }),
      onEvent: (event, running) => {
        if (event.kind === "unsafe") {
          running.stop();
        }
      },
    });

    expect(await turn.done).toEqual({ state: "failed", error: "The CLI started with a shell." });
  });

  it("should not forward what the agent writes after a refusal", async () => {
    const { turn, onText } = startScriptedTurn({
      script: makeAgentScript({
        events: [
          { kind: "text", text: "Before" },
          { kind: "tool", name: "Bash" },
          { kind: "text", text: "After" },
        ],
      }),
    });

    expect(await turn.done).toEqual({
      state: "failed",
      error: "The agent tried Bash, which is not a Drizzle Run tool of this chat, so Drizzle Run stopped it.",
    });
    expect(onText.mock.calls).toEqual([["Before"]]);
  });
});
