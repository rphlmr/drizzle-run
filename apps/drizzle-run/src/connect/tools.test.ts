import { listSupportedTuples } from "@drizzle-run/core/catalog";
import { CONNECT_TOOLS, parseToolInput, type ConnectToolName, type ConnectToolScope } from "@drizzle-run/core/connect";
import { serializeValue, type QueryPlansReport, type RunResult } from "@drizzle-run/core/contracts";
import { editPairFile, pairSide, type PairSideIndex } from "@drizzle-run/core/pair";
import type { ConnectToolOutcome, PendingEdit } from "@drizzle-run/runtime/machines";
import { fakeRunResult } from "@drizzle-run/test-fixtures";
import { assert, describe, expect, it, vi } from "vitest";

import { findGuide } from "../guides/catalog";
import {
  createProject,
  createSideBySideProject,
  editProject,
  isSideBySide,
  toCommunityProject,
  transitionProjectTrust,
  type ProjectRecord,
} from "../project/projects";
import { VolatileProjectStorage } from "../store/storage";
import { QUERY_PLANS_OFF, type QueryPlansFlag } from "../ui/query-plans";
import { connectServices, getTabRoomUrl } from "./connect-provider";
import type { ConnectGuide, FetchText } from "./guide-tools";
import { PENDING_EDITS_SETTING } from "./pending-edits";
import { createConnectTools, type ConnectHost } from "./tools";

const postgres = { dialect: "postgresql" as const };

const plans: QueryPlansReport = {
  settings: { size: "1m", measureRealTime: false },
  dialect: "postgresql",
  fills: [{ size: "1m", tables: [{ name: "posts", rows: 1_000_000 }], durationMs: 900 }],
  queries: [
    {
      sequences: [4],
      sql: "select * from posts where author_id = $1",
      parameters: [serializeValue(1)],
      raw: [
        { database: "postgresql", size: "1m", json: '[{"Plan":{"Node Type":"Seq Scan"}}]', text: "Seq Scan on posts" },
      ],
      reading: {
        summary: "Full scan of posts, reads 1M rows to return 10",
        verdict: { kind: "grows", tables: ["posts"] },
        indexes: [],
      },
    },
  ],
  skipped: [],
  durationMs: 1_200,
};

function makeRunResult(outcome: "succeeded" | "failed", withPlans = false): RunResult {
  const result = fakeRunResult(outcome, {
    target: postgres,
    displays: [
      { label: "Balances", values: [serializeValue([{ name: "Ada", balance: 130 }])], source: "query.ts", line: 9 },
    ],
    message: "boom",
    timings: { total: 92 },
  });

  return {
    ...result,
    diagnostics:
      outcome === "failed" ? [{ severity: "error" as const, message: "boom", source: "query.ts", line: 3 }] : [],
    sql: [
      {
        sequence: 1,
        phase: "run" as const,
        origin: "drizzle" as const,
        kind: "executed" as const,
        sql: "select 1",
        parameters: [],
        outcome: "succeeded" as const,
        source: "query.ts",
        line: 2,
      },
    ],
    logs: [
      {
        sequence: 2,
        phase: "run" as const,
        level: "log" as const,
        values: [serializeValue("hello"), serializeValue({ a: 1n })],
      },
    ],
    ...(withPlans ? { queryPlans: plans } : {}),
  };
}

interface SetupOptions {
  scope?: ConnectToolScope;
  /** A shared link's own fork, as SharedPlayground lends it. */
  fork?: (name: string) => Promise<ProjectRecord>;
  guide?: ConnectGuide;
  fetchText?: FetchText;
}

const noFetch: FetchText = () => Promise.reject(new Error("No fetch in this test."));

const toPendingEdit = (outcome: ConnectToolOutcome): PendingEdit => {
  if (!outcome.ok || outcome.pendingEdit === undefined) {
    throw new Error("No pending edit.");
  }

  return { ...outcome.pendingEdit, id: "edit-c1", toolCallId: "c1", createdAt: 0 };
};

/** A host over a real project record, as a project view would be. */
function createHost(initial: ProjectRecord, options: SetupOptions = {}) {
  const state = {
    project: initial,
    projects: [initial] as ProjectRecord[],
    runs: [undefined, undefined] as (RunResult | undefined)[],
    flag: QUERY_PLANS_OFF,
    created: [] as ProjectRecord[],
    ran: 0,
    open: true,
    running: false,
  };
  const host: ConnectHost = {
    project: () => state.project,
    save: (next) => {
      state.project = next;
      state.projects = state.projects.map((item) => (item.id === next.id ? next : item));
    },
    problems: () => [{ path: "query.ts", line: 1, column: 1, severity: "error", message: "Cannot find name 'x'." }],
    latestRun: (side: PairSideIndex) => state.runs[side],
    run: async () => {
      state.ran += 1;
      state.runs = [
        makeRunResult("succeeded", state.flag.on),
        isSideBySide(state.project) ? makeRunResult("failed", state.flag.on) : undefined,
      ];
    },
    running: () => state.running,
    queryPlans: {
      get: () => state.flag,
      set: (next: QueryPlansFlag) => {
        state.flag = next;
      },
    },
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.guide ? { guide: () => options.guide } : {}),
    ...(options.fork ? { canFork: true, fork: options.fork } : {}),
  };
  const tools = createConnectTools({
    host: () => (state.open ? host : undefined),
    projects: () => state.projects,
    update: (next) => {
      state.projects = state.projects.map((item) => (item.id === next.id ? next : item));
    },
    create: async (next) => {
      state.created.push(next);
      state.projects = [...state.projects, next];
    },
    projectUrl: (projectId) => `https://drizzle.run/p/${projectId}`,
    fetchText: options.fetchText ?? noFetch,
  });
  /** A call checked against the open project, as the connect machine checks it; `projectId` overrides that. */
  const call = async (
    name: ConnectToolName,
    input: unknown = {},
    checked: { projectId?: string } = state.open ? { projectId: state.project.id } : {},
  ): Promise<ConnectToolOutcome> => {
    const parsed = parseToolInput(name, input);

    if (!parsed.ok) {
      throw new Error(parsed.message);
    }

    return tools.execute({ id: "c1", call: parsed.call, mode: "edit", ...checked }, new AbortController().signal);
  };

  return { state, host, call, tools, pending: toPendingEdit };
}

/** Writes query.ts as the user would in the editor. */
function editByHand(state: { project: ProjectRecord }, content: string): void {
  const current = state.project;

  if (isSideBySide(current)) {
    throw new Error("Expected a one-version project.");
  }

  state.project = editProject(current, {
    ...current.manifest,
    files: { ...current.manifest.files, "query.ts": content },
  });
}

function readResult(outcome: ConnectToolOutcome) {
  if (!outcome.ok) {
    throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  }

  return outcome.result as Record<string, unknown>;
}

const createBankProject = () => createProject("Bank transfers", postgres);

describe("connect tools on a one-version project", () => {
  it("should describe the project, its files, releases, and Query plans with get_project", async () => {
    const { call } = createHost(createBankProject());
    const read = readResult(await call("get_project"));

    expect(read).toMatchObject({
      name: "Bank transfers",
      kind: "one_version",
      database: "postgresql",
      latest_run: "none",
      query_plans: { on: false, size: "1m" },
    });
    expect((read.files as { path: string }[]).map((file) => file.path).toSorted()).toEqual([
      "query.ts",
      "schema.ts",
      "seed.ts",
    ]);
    expect((read.releases as unknown[]).length).toBe(listSupportedTuples(postgres).length);
    expect(read.libraries).toContainEqual({ name: "zod", version: "4.4.3" });
    expect((read.libraries as { name: string }[]).map((library) => library.name)).not.toContain("drizzle-orm");
  });

  it("should return numbered lines with read_file, and name a missing file", async () => {
    const { call, state } = createHost(createBankProject());
    const read = readResult(await call("read_file", { path: "schema.ts" }));
    const first = (state.project.manifest.files["schema.ts"] ?? "").split("\n")[0];

    expect(read.content).toEqual(expect.stringContaining(`   1| ${first}`));
    expect(await call("read_file", { path: "nope.ts" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call("read_file", { path: "schema.ts", side: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("should list the editor's and the latest run's problems with get_problems", async () => {
    const { call, state } = createHost(createBankProject());

    state.runs = [makeRunResult("failed"), undefined];
    expect(readResult(await call("get_problems"))).toEqual({
      editor: [{ path: "query.ts", line: 1, column: 1, severity: "error", message: "Cannot find name 'x'." }],
      run: [{ severity: "error", message: "boom", at: "query.ts:3" }],
    });
  });

  it("should press Run and return the run as the output panel shows it with run, and read it again with get_latest_run", async () => {
    const { call, state } = createHost(createBankProject());

    expect(readResult(await call("get_latest_run"))).toMatchObject({ outcome: "none" });

    const ran = readResult(await call("run"));

    expect(state.ran).toBe(1);
    expect(ran).toMatchObject({
      outcome: "succeeded",
      duration_ms: 92,
      displays: [{ label: "Balances", at: "query.ts:9", values: [[{ name: "Ada", balance: 130 }]] }],
      console: [{ level: "log", text: 'hello {"a":"1n"}' }],
      sql: [{ phase: "run", sql: "select 1", at: "query.ts:2", outcome: "succeeded" }],
    });
    expect(readResult(await call("get_latest_run"))).toEqual(ran);
  });

  it("should mark the run row rolled back when the code rolled back a whole transaction, not only a savepoint", async () => {
    const { call, state, host } = createHost(createBankProject());
    const transaction = {
      id: 1,
      phase: "run" as const,
      outcome: "rolled_back" as const,
      writes: "undone" as const,
      statements: [],
      durationMs: 1,
    };
    const runWith = (transactions: RunResult["transactions"]) => {
      host.run = async () => {
        state.runs = [{ ...makeRunResult("succeeded"), transactions }, undefined];
      };
    };

    runWith([transaction]);
    const rolledBack = await call("run");
    runWith([
      { ...transaction, outcome: "committed", writes: "kept" },
      { ...transaction, id: 2, parent: 1 },
    ]);
    const committed = await call("run");

    expect(rolledBack).toMatchObject({ summary: { label: "Ran the project", rolledBack: true } });
    expect(committed.summary).not.toHaveProperty("rolledBack");
  });

  it("should change files at once with apply_edits, wait as a pending edit, and put them back on Undo", async () => {
    const { call, state, tools, pending } = createHost(createBankProject());
    const before = state.project.manifest.files["query.ts"] ?? "";
    const outcome = await call("apply_edits", {
      edits: [
        { path: "query.ts", new_text: "export {};\n" },
        { path: "helpers.ts", new_text: "export const x = 1;\n" },
      ],
      summary: "Simplify",
    });

    expect(readResult(outcome)).toMatchObject({ files: [{ path: "query.ts" }, { path: "helpers.ts", created: true }] });
    expect(outcome).toMatchObject({
      summary: { label: "Edited", target: "query.ts, helpers.ts" },
      pendingEdit: { projectName: "Bank transfers", summary: "Simplify" },
    });
    expect(state.project.manifest.files["query.ts"]).toBe("export {};\n");
    expect(state.project.manifest.files["helpers.ts"]).toBe("export const x = 1;\n");

    await tools.undo(pending(outcome));
    expect(state.project.manifest.files["query.ts"]).toBe(before);
    expect(state.project.manifest.files).not.toHaveProperty("helpers.ts");
  });

  it("should refuse Undo when a file changed since the edit, and undo on a project that is no longer open", async () => {
    const { call, state, tools, pending } = createHost(createBankProject());
    const edit = pending(await call("apply_edits", { edits: [{ path: "query.ts", new_text: "export {};\n" }] }));

    editByHand(state, "changed by hand");
    await expect(tools.undo(edit)).rejects.toThrow("query.ts changed since this edit");

    editByHand(state, "export {};\n");
    state.projects = [state.project];
    state.open = false;
    await tools.undo(edit);
    expect(state.projects[0]?.manifest.files["query.ts"]).not.toBe("export {};\n");
  });

  it("should refuse in apply_edits an anchor that is missing or ambiguous, and paths outside the project", async () => {
    const { call } = createHost(createBankProject());

    expect(
      await call("apply_edits", { edits: [{ path: "query.ts", old_text: "no such text", new_text: "x" }] }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(parseToolInput("apply_edits", { edits: [{ path: "../escape.ts", new_text: "x" }] })).toMatchObject({
      ok: false,
    });
    expect(await call("apply_edits", { edits: [{ path: "missing.ts", old_text: "a", new_text: "b" }] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("should move the project to a tested release with switch_release and refuse others", async () => {
    const start = createBankProject();
    const { call, state } = createHost(start);
    const other = listSupportedTuples(postgres).find(
      (tuple) => tuple.ormVersion !== start.manifest.dependencies["drizzle-orm"],
    );

    expect(other).toBeDefined();
    expect(await call("switch_release", { orm_version: other?.ormVersion })).toMatchObject({
      ok: true,
      summary: { label: "Switched to", target: other?.ormVersion.startsWith("0.") ? "0.45" : "rc.5" },
    });
    expect(isSideBySide(state.project) ? undefined : state.project.manifest.dependencies).toEqual({
      "drizzle-orm": other?.ormVersion,
      "drizzle-kit": other?.kitVersion,
    });
    expect(await call("switch_release", { orm_version: "0.0.1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await call("switch_release", { orm_version: other?.ormVersion, database: "sqlite" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("stays on its database") },
    });
  });

  it("should save a project with create_project and link to it, leaving the open project in front", async () => {
    const { call, state, host } = createHost(createBankProject());
    const open = state.project;
    const created = await call("create_project", {
      name: "Blog",
      dialect: "sqlite",
      files: { "query.ts": "export {};\n" },
    });
    const id = state.created[0]?.id;

    expect(created).toMatchObject({
      ok: true,
      result: { id, name: "Blog", url: `https://drizzle.run/p/${id}`, guest_flavor: "slim" },
      summary: { label: "Created a project", target: "Blog", createdProject: { id, name: "Blog" } },
    });
    expect(host.project()).toBe(open);
    expect(readResult(await call("get_project"))).toMatchObject({ id: open.id });
    expect(state.created[0]?.manifest).toMatchObject({ target: { dialect: "sqlite" } });
    expect(state.created[0]?.manifest.files["query.ts"]).toBe("export {};\n");
    expect(state.created[0]?.manifest.files).toHaveProperty("schema.ts");
    expect(await call("create_project", { name: "Bad", dialect: "sqlite", orm_version: "9.9.9" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("should create, switch and describe projects with Effect, and refuse Effect where no image ships it", async () => {
    const rc = listSupportedTuples(postgres).find((tuple) => tuple.ormVersion.includes("-rc."));
    const legacy = listSupportedTuples(postgres).find((tuple) => tuple.ormVersion.startsWith("0."));

    if (rc === undefined || legacy === undefined) {
      throw new Error("Expected an RC and a Legacy PostgreSQL pair.");
    }

    const { call, state } = createHost(createProject("Plain", postgres, rc.id));

    expect(
      await call("create_project", {
        name: "Fx",
        dialect: "postgresql",
        orm_version: rc.ormVersion,
        guest_flavor: "effect",
      }),
    ).toMatchObject({ ok: true, result: { guest_flavor: "effect" } });
    expect(state.created[0]?.manifest).toMatchObject({
      dependencies: { "drizzle-orm": rc.ormVersion, "drizzle-kit": rc.kitVersion },
      guestFlavor: "effect",
    });
    expect(
      await call("create_project", {
        name: "No",
        dialect: "postgresql",
        orm_version: legacy.ormVersion,
        guest_flavor: "effect",
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_input", message: `guest_flavor effect runs only on ${rc.ormVersion} for postgresql.` },
      summary: { label: "Created a project", target: "No" },
    });

    const described = readResult(await call("get_project"));

    expect(described).toMatchObject({ guest_flavor: "slim" });
    expect(described).toHaveProperty(
      "releases",
      expect.arrayContaining([
        expect.objectContaining({ drizzle_orm: rc.ormVersion, guest_flavors: ["slim", "effect"] }),
        expect.objectContaining({ drizzle_orm: legacy.ormVersion, guest_flavors: ["slim"] }),
      ]),
    );

    expect(await call("switch_release", { orm_version: rc.ormVersion, guest_flavor: "effect" })).toMatchObject({
      ok: true,
      result: { guest_flavor: "effect" },
      summary: { label: "Switched to", target: "rc.5 + Effect" },
    });
    const withEffect = readResult(await call("get_project"));

    expect(withEffect).toMatchObject({ guest_flavor: "effect" });
    expect(withEffect.libraries).toContainEqual({ name: "effect", version: "4.0.5" });
    expect(await call("switch_release", { orm_version: rc.ormVersion })).toMatchObject({
      result: { guest_flavor: "effect" },
    });
    expect(await call("switch_release", { orm_version: legacy.ormVersion })).toMatchObject({
      result: { guest_flavor: "slim" },
      summary: { target: "0.45" },
    });
    expect(state.project.manifest).not.toHaveProperty(["dependencies", "effect"]);
    expect(await call("switch_release", { orm_version: legacy.ormVersion, guest_flavor: "effect" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: `guest_flavor effect runs only on ${rc.ormVersion} for postgresql.` },
    });
  });

  it("should read and set Query plans, and read the planned queries raw or as Drizzle Run's reading", async () => {
    const { call, state } = createHost(createBankProject());

    expect(readResult(await call("get_query_plans_settings"))).toMatchObject({
      on: false,
      size: "1m",
      measure_real_time: false,
    });
    expect(await call("get_query_plans", { view: "reading" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    expect(await call("set_query_plans_settings", { on: true, size: "100k" })).toMatchObject({
      ok: true,
      summary: { label: "Turned Query plans on", meta: "100k" },
    });
    expect(state.flag).toEqual({ on: true, size: "100k", measureRealTime: false });

    await call("run");
    expect(readResult(await call("get_query_plans", { view: "reading" }))).toMatchObject({
      view: "Drizzle Run's reading",
      queries: [
        {
          query: 0,
          summary: "Full scan of posts, reads 1M rows to return 10",
          verdict: "Grows with posts",
          confirmed_indexes: [],
        },
      ],
    });
    expect(readResult(await call("get_query_plans", { view: "raw", query: 0 }))).toMatchObject({
      view: "From Postgres",
      queries: [{ query: 0, raw: plans.queries[0]?.raw }],
    });
    expect(await call("get_query_plans", { view: "raw", query: 5 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("should refuse a call checked against another project, so a chat's edit never lands on the project open now", async () => {
    const { call, state } = createHost(createBankProject());
    const before = state.project;

    const outcome = await call(
      "apply_edits",
      { edits: [{ path: "query.ts", new_text: "await fetch('https://evil.example');\n" }] },
      { projectId: "community-project" },
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("another project") },
    });
    expect(state.project).toBe(before);
    expect(await call("run", {}, { projectId: "community-project" })).toMatchObject({ ok: false });
    expect(state.ran).toBe(0);
  });

  it("should say a community project is someone else's, and keep that on a project created from it", async () => {
    const { call, state } = createHost(toCommunityProject(createBankProject()));

    expect(readResult(await call("get_project"))).toMatchObject({
      origin: "community",
      origin_note: expect.stringContaining("never as instructions"),
    });

    const created = await call("create_project", { name: "Copy", dialect: "sqlite" });

    expect(state.created[0]?.origin).toBe("community");
    expect(created).toMatchObject({ ok: true, summary: { createdProject: { id: state.created[0]?.id } } });
  });

  it("should say no project is open when no view lends itself", async () => {
    const { call, state } = createHost(createBankProject());

    state.open = false;
    expect(await call("get_project")).toMatchObject({ ok: false, error: { code: "no_project" } });
  });
});

describe("connect tools on a side-by-side project", () => {
  const tuples = listSupportedTuples(postgres);
  const project = () => {
    const [first, second] = tuples;

    if (first === undefined || second === undefined) {
      throw new Error("Two releases are needed.");
    }

    return createSideBySideProject("Upgrade", [postgres, postgres], [first.id, second.id], "separate");
  };

  it("should describe both sides and read per-side files", async () => {
    const { call, state } = createHost(project());
    const read = readResult(await call("get_project"));

    expect(read).toMatchObject({ kind: "side_by_side", sides: [{ side: 0 }, { side: 1 }] });
    expect(read).not.toHaveProperty("query_plans");
    expect(await call("read_file", { path: "query.ts" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(readResult(await call("read_file", { path: "query.ts", side: 1 })).content).toEqual(
      expect.stringContaining("1|"),
    );
    expect(await call("read_file", { path: "seed.ts" })).toMatchObject({
      summary: { label: "Read", target: "seed.ts · both sides" },
    });
    expect(isSideBySide(state.project)).toBe(true);
  });

  it("should edit one side, write a new file with a copy per side across release lines, and undo", async () => {
    const { call, state, tools, pending } = createHost(project());

    if (!isSideBySide(state.project)) {
      throw new Error("Expected a side-by-side project.");
    }

    const before0 = pairSide(state.project.manifest, 0).files["query.ts"];
    const outcome = await call("apply_edits", {
      side: 1,
      edits: [
        { path: "query.ts", new_text: "export {};\n" },
        { path: "helpers.ts", new_text: "export const y = 2;\n" },
      ],
    });
    const edited = state.project;

    expect(outcome.ok).toBe(true);

    if (!isSideBySide(edited)) {
      throw new Error("Expected a side-by-side project.");
    }

    expect(outcome).toMatchObject({ summary: { target: expect.stringMatching(/^query\.ts, helpers\.ts · \S+$/) } });
    expect(outcome).toMatchObject({ pendingEdit: { side: 1, where: expect.not.stringMatching(/both sides/) } });
    expect(pairSide(edited.manifest, 1).files["query.ts"]).toBe("export {};\n");
    expect(pairSide(edited.manifest, 0).files["query.ts"]).toBe(before0);
    expect(edited.manifest.files).not.toHaveProperty("helpers.ts");
    expect(edited.manifest.sides.map((side) => side.files["helpers.ts"])).toEqual([
      "export const y = 2;\n",
      "export const y = 2;\n",
    ]);

    await tools.undo(pending(outcome));

    const undone = state.project;

    if (!isSideBySide(undone)) {
      throw new Error("Expected a side-by-side project.");
    }

    expect(undone.manifest.sides.map((side) => Object.hasOwn(side.files, "helpers.ts"))).toEqual([false, false]);
    expect(pairSide(undone.manifest, 1).files["query.ts"]).toBe(before0);
  });

  it("should refuse to undo a created file in a pair once the other side's copy changed", async () => {
    const { call, state, tools, pending } = createHost(project());
    const outcome = await call("apply_edits", {
      side: 1,
      edits: [{ path: "helpers.ts", new_text: "export const y = 2;\n" }],
    });
    const edited = state.project;

    if (!isSideBySide(edited)) {
      throw new Error("Expected a side-by-side project.");
    }

    const otherCopy = editPairFile(edited.manifest, 0, "helpers.ts", "export const y = 3;\n");
    state.project = { ...edited, manifest: otherCopy, revision: edited.revision + 1 };

    await expect(tools.undo(pending(outcome))).rejects.toThrow("helpers.ts changed since this edit");
    expect(pairSide(otherCopy, 0).files["helpers.ts"]).toBe("export const y = 3;\n");
  });

  it("should run both sides and read each, and move a side to the other side's release", async () => {
    const { call, state } = createHost(project());
    const ran = readResult(await call("run"));

    expect(ran).toMatchObject({ sides: [{ outcome: "succeeded" }, { outcome: "failed", error: { message: "boom" } }] });
    expect(readResult(await call("get_latest_run", { side: 1 }))).toMatchObject({ outcome: "failed" });
    expect(await call("switch_release", { orm_version: tuples[0]?.ormVersion })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await call("switch_release", { orm_version: tuples[0]?.ormVersion, side: 1 })).toMatchObject({ ok: true });
    expect(isSideBySide(state.project) && state.project.manifest.sides[1].dependencies["drizzle-orm"]).toBe(
      tuples[0]?.ormVersion,
    );
  });

  it("should move one side to the other database with switch_release, its schema left to rewrite", async () => {
    const { call, state } = createHost(project());
    const sqlite = listSupportedTuples({ dialect: "sqlite" }).at(-1);

    assert.isDefined(sqlite);
    expect(
      readResult(await call("switch_release", { orm_version: sqlite.ormVersion, side: 1, database: "sqlite" })),
    ).toMatchObject({
      database: "sqlite",
      note: expect.stringContaining("rewrite it for SQLite"),
    });

    const moved = state.project;

    if (!isSideBySide(moved)) {
      throw new Error("Expected a side-by-side project.");
    }

    expect(moved.manifest.sides.map((side) => side.target.dialect)).toEqual(["postgresql", "sqlite"]);
    expect(readResult(await call("get_project"))).toMatchObject({
      sides: [{ database: "postgresql" }, { database: "sqlite" }],
    });
    expect(await call("switch_release", { orm_version: "0.0.1", side: 0, database: "sqlite" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("SQLite") },
    });
  });

  it("should refuse to move a side while a run is going", async () => {
    const { call, state } = createHost(project());
    const sqlite = listSupportedTuples({ dialect: "sqlite" }).at(-1);
    const before = state.project;

    assert.isDefined(sqlite);
    state.running = true;

    expect(await call("switch_release", { orm_version: sqlite.ormVersion, side: 1, database: "sqlite" })).toMatchObject(
      { ok: false, error: { code: "busy", message: expect.stringContaining("Wait for it to settle") } },
    );
    expect(state.project).toBe(before);
  });

  it.runIf(tuples.length > 2)("should switch one side to a third release", async () => {
    const { call, state } = createHost(project());
    const third = tuples[2];

    assert.isDefined(third);
    expect(await call("switch_release", { orm_version: third.ormVersion, side: 1 })).toMatchObject({ ok: true });
    expect(isSideBySide(state.project) && state.project.manifest.sides[1].dependencies["drizzle-orm"]).toBe(
      third.ormVersion,
    );
  });

  it("should set Query plans for both sides and read one side's planned queries", async () => {
    const { call, state } = createHost(project());

    expect(await call("set_query_plans_settings", { on: true })).toMatchObject({ ok: true });
    expect(state.flag.on).toBe(true);

    await call("run");
    state.runs[1] = makeRunResult("failed");

    expect(readResult(await call("get_query_plans", { view: "reading" }))).toMatchObject({
      queries: [{ query: 0, verdict: "Grows with posts" }],
    });
    expect(await call("get_query_plans", { view: "reading", side: 1 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("connect tools in a guided view", () => {
  const transactions = findGuide("transactions");
  const relations = findGuide("relational-queries");

  if (transactions === undefined || relations === undefined) {
    throw new Error("The transactions and relational-queries guides are needed.");
  }

  const guided = (fetchText?: FetchText) =>
    createHost(createProject("Transactions", postgres), {
      scope: "guide",
      guide: { manifest: transactions, index: 1, stage: "before" },
      ...(fetchText ? { fetchText } : {}),
    });

  it("should refuse edits and runs, and name the guide's pair in every result it gives", async () => {
    const { call, state } = guided();

    for (const [name, input] of [
      ["apply_edits", { edits: [{ path: "query.ts", new_text: "x" }] }],
      ["run", {}],
      ["switch_release", { orm_version: "0.45.4" }],
      ["create_project", { name: "x", dialect: "sqlite" }],
      ["set_query_plans_settings", { on: true }],
    ] as const) {
      expect(await call(name, input)).toMatchObject({
        ok: false,
        error: { code: "unavailable", message: expect.stringContaining("not available during a guide") },
      });
    }

    expect(state.ran).toBe(0);
    expect(readResult(await call("read_file", { path: "query.ts" }))).toMatchObject({
      path: "query.ts",
      guide: { id: transactions.id, pair: [{ drizzle_orm: "1.0.0-rc.5", drizzle_kit: "1.0.0-rc.5" }] },
    });
    expect(readResult(await call("get_project")).guide).not.toHaveProperty("note");
  });

  it("should read the step, what it changes, and every step's title with get_guide", async () => {
    const { call } = guided();
    const outcome = await call("get_guide");
    const read = readResult(outcome);

    expect(outcome).toMatchObject({ summary: { label: "Read the guide", target: "step 2 of 3" } });
    expect(read).toMatchObject({
      id: transactions.id,
      position: "step 2 of 3",
      step: {
        number: 2,
        title: "Keep the savepoint's update",
        run: "required",
        code_changes: [{ path: "query.ts", lines: [expect.stringContaining("- ")] }],
      },
      steps: [{ number: 1 }, { number: 2 }, { number: 3 }],
      sources: [{ href: "https://orm.drizzle.team/docs/transactions" }],
    });
    expect(read.step).not.toHaveProperty("what_changed");
  });

  it("should list the guide's sources with read_docs, read an allowed page as text, and refuse the rest", async () => {
    const fetched: string[] = [];
    const { call } = guided(async (url) => {
      fetched.push(url);

      if (url.endsWith("/moved")) {
        return {
          ok: true,
          status: 200,
          type: "text/html",
          text: "<main>Elsewhere</main>",
          url: "https://example.com/docs/moved",
        };
      }

      return url.endsWith("/missing")
        ? { ok: false, status: 404, type: "text/html", text: "" }
        : {
            ok: true,
            status: 200,
            type: "text/html; charset=utf-8",
            text: "<html><body><nav>Menu</nav><main><h1>Transactions</h1><p>Use <code>db.transaction</code>.</p></main></body></html>",
          };
    });

    expect(readResult(await call("read_docs"))).toMatchObject({
      sources: [{ href: "https://orm.drizzle.team/docs/transactions" }],
      index: "https://orm.drizzle.team/llms.txt",
    });

    const page = await call("read_docs", { url: "/docs/transactions" });

    expect(page).toMatchObject({
      ok: true,
      summary: { label: "Read docs", target: "orm.drizzle.team/docs/transactions" },
    });
    expect(readResult(page)).toMatchObject({
      url: "https://orm.drizzle.team/docs/transactions",
      kind: "source",
      text: "# Transactions\nUse db.transaction.",
    });
    expect(await call("read_docs", { url: "/docs/missing" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await call("read_docs", { url: "https://example.com/docs/transactions" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await call("read_docs", { url: "/docs/moved" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("redirected") },
    });
    expect(fetched).toEqual([
      "https://orm.drizzle.team/docs/transactions",
      "https://orm.drizzle.team/docs/missing",
      "https://orm.drizzle.team/docs/moved",
    ]);
  });

  it("should name both sides for a Legacy guide and say the docs describe v1", async () => {
    const pair = relations.project;

    if (pair.kind !== "drizzle-run-pair") {
      throw new Error("Expected a side-by-side guide.");
    }

    const [first, second] = [pair.sides[0].dependencies["drizzle-orm"], pair.sides[1].dependencies["drizzle-orm"]];
    const { call } = createHost(createProject("Relations", postgres), {
      scope: "guide",
      guide: { manifest: relations, index: 0, stage: "before" },
    });
    const read = readResult(await call("get_project"));

    expect(read.guide).toMatchObject({
      pair: [
        { side: 0, drizzle_orm: first },
        { side: 1, drizzle_orm: second },
      ],
      note: expect.stringContaining("documents v1"),
    });
    expect(readResult(await call("read_docs")).note).toEqual(expect.stringContaining("read the guide's sources first"));
  });

  it("should refuse the guide tools outside a guide", async () => {
    const { call } = createHost(createProject("Bank transfers", postgres));

    expect(await call("get_guide")).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await call("read_docs", { url: "/docs/select" })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("should only read on a shared link", async () => {
    const { call } = createHost(createProject("Shared", postgres), { scope: "snapshot" });

    expect(await call("run")).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(readResult(await call("get_project"))).toMatchObject({ name: "Shared" });
  });
});

const createCommunityFork = () => toCommunityProject(createProject("Community bank", postgres));

describe("connect tools on someone else's project", () => {
  const editInput = { edits: [{ path: "query.ts", new_text: "await fetch('https://evil.example');\n" }] };

  it("should only read an untrusted project: no edit, run, release switch, new project or Query plans change", async () => {
    const { call, state } = createHost(createCommunityFork(), { scope: "untrusted" });
    const before = state.project;

    for (const [name, input] of [
      ["apply_edits", editInput],
      ["run", {}],
      ["switch_release", { orm_version: "0.45.4" }],
      ["create_project", { name: "Mine", dialect: "sqlite" }],
      ["set_query_plans_settings", { on: true }],
    ] as const) {
      expect(await call(name, input)).toMatchObject({
        ok: false,
        error: { code: "unavailable", message: expect.stringContaining("until the user presses Allow AI edits") },
      });
    }

    expect(state.project).toBe(before);
    expect(state.ran).toBe(0);
    expect(state.created).toEqual([]);
    expect(readResult(await call("get_project"))).toMatchObject({ name: "Community bank", origin: "community" });
  });

  it("should edit and run a fork once the user trusts it, and keep it someone else's", async () => {
    const trusted = transitionProjectTrust(createCommunityFork(), { type: "project.trust" });
    const { call, state } = createHost(trusted, { scope: "project" });

    expect(await call("apply_edits", editInput)).toMatchObject({ ok: true });
    expect(state.project).toMatchObject({ origin: "community", trust: "trusted" });
    expect(await call("run")).toMatchObject({ ok: true });
    expect(state.ran).toBe(1);
  });

  it("should let nothing the AI sends change trust", async () => {
    for (const tool of CONNECT_TOOLS) {
      expect(parseToolInput(tool.name, { trust: "trusted" })).toMatchObject({ ok: false });
    }

    const { call, state } = createHost(createCommunityFork(), { scope: "untrusted" });

    for (const name of ["get_project", "get_problems", "get_latest_run", "fork_project"] as const) {
      await call(name);
    }

    await call("read_file", { path: "query.ts" });
    expect(state.project.trust).toBe("untrusted");
    expect(state.projects.map((project) => project.trust)).toEqual(["untrusted", "untrusted"]);

    const trusted = createHost(transitionProjectTrust(createCommunityFork(), { type: "project.trust" }), {
      scope: "project",
    });
    const created = await trusted.call("create_project", { name: "From a fork", dialect: "sqlite" });

    expect(created).toMatchObject({ ok: true });
    expect(trusted.state.created[0]).toMatchObject({ origin: "community", trust: "untrusted" });
  });

  it("should fork the open project untrusted with fork_project, link to it, and keep the view in front", async () => {
    const { call, state } = createHost(createCommunityFork(), { scope: "untrusted" });
    const outcome = await call("fork_project", { name: "My copy" });
    const copy = state.created[0];

    expect(copy).toMatchObject({ name: "My copy", origin: "community", trust: "untrusted" });
    expect(copy?.manifest).toEqual(state.project.manifest);
    expect(outcome).toMatchObject({
      ok: true,
      result: { id: copy?.id, url: `https://drizzle.run/p/${copy?.id}`, trust: "untrusted" },
      summary: { createdProject: { id: copy?.id, name: "My copy" }, meta: "AI reads only until you allow edits" },
    });
    expect(state.project.name).toBe("Community bank");
  });

  it("should fork a shared link through the link's own fork, and refuse fork_project on the user's own project", async () => {
    const saved: ProjectRecord[] = [];
    const sharedFork = async (name: string) => {
      const copy = toCommunityProject(createProject(name, postgres));
      saved.push(copy);

      return copy;
    };
    const { call, state } = createHost(createCommunityFork(), { scope: "snapshot", fork: sharedFork });

    expect(readResult(await call("fork_project"))).toMatchObject({ id: saved[0]?.id, name: "Community bank" });
    expect(state.created).toEqual([]);

    const own = createHost(createProject("Mine", postgres));
    expect(await own.call("fork_project")).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("tab room address", () => {
  it("should use the page's own origin, ws on http and wss on https", () => {
    expect(getTabRoomUrl({ protocol: "http:", host: "127.0.0.1:4173" }, "r".repeat(43))).toBe(
      `ws://127.0.0.1:4173/api/connect/rooms/${"r".repeat(43)}?role=tab`,
    );
    expect(getTabRoomUrl({ protocol: "https:", host: "drizzle.run" }, "abc")).toBe(
      "wss://drizzle.run/api/connect/rooms/abc?role=tab",
    );
  });
});

const makeEdit = (id: string): PendingEdit => ({
  id,
  toolCallId: id,
  createdAt: 1,
  projectId: "p1",
  projectName: "Bank",
  files: [{ path: "query.ts", before: "a", after: "b", added: 1, removed: 1 }],
});

describe("pending edits kept across pages", () => {
  it("should persist a pending edit after its first save failed and storage recovered", async () => {
    const settings = new VolatileProjectStorage();
    const tools = createConnectTools({
      host: () => undefined,
      projects: () => [],
      update: () => undefined,
      create: async () => undefined,
      projectUrl: (projectId) => `https://drizzle.run/p/${projectId}`,
      fetchText: noFetch,
    });
    const services = connectServices({ settings, tools });
    const merge = vi.spyOn(settings, "mergePendingEdits").mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(services.savePendingEdits?.([makeEdit("mine")])).rejects.toThrow("storage unavailable");
    await services.savePendingEdits?.([makeEdit("mine"), makeEdit("later")]);

    expect(merge).toHaveBeenCalledTimes(2);
    expect(await connectServices({ settings, tools }).loadPendingEdits?.()).toEqual([
      makeEdit("mine"),
      makeEdit("later"),
    ]);
  });

  it.each([
    { stored: [makeEdit("edit-1")], expected: [makeEdit("edit-1")] },
    { stored: [makeEdit("edit-1"), { id: "edit-2", files: "all" }], expected: [] },
  ])(
    "should bring back the edits a reload left pending, or none when the store is unreadable",
    async ({ stored, expected }) => {
      const settings = new VolatileProjectStorage();
      const tools = createConnectTools({
        host: () => undefined,
        projects: () => [],
        update: () => undefined,
        create: async () => undefined,
        projectUrl: (projectId) => `https://drizzle.run/p/${projectId}`,
        fetchText: noFetch,
      });

      await settings.writeSetting(PENDING_EDITS_SETTING, stored);

      const services = connectServices({ settings, tools });

      expect(await services.loadPendingEdits?.()).toEqual(expected);
    },
  );

  it("should save this page's edits and keep another tab's", async () => {
    const settings = new VolatileProjectStorage();
    const tools = createConnectTools({
      host: () => undefined,
      projects: () => [],
      update: () => undefined,
      create: async () => undefined,
      projectUrl: (projectId) => `https://drizzle.run/p/${projectId}`,
      fetchText: noFetch,
    });
    const services = connectServices({ settings, tools });

    await services.loadPendingEdits?.();
    await settings.writeSetting(PENDING_EDITS_SETTING, [makeEdit("other-tab")]);
    await services.savePendingEdits?.([makeEdit("mine")]);
    expect(await settings.readSetting(PENDING_EDITS_SETTING)).toEqual([makeEdit("other-tab"), makeEdit("mine")]);

    await services.savePendingEdits?.([]);
    expect(await settings.readSetting(PENDING_EDITS_SETTING)).toEqual([makeEdit("other-tab")]);
  });

  it("should keep both tabs' edits when two tabs save at once", async () => {
    const settings = new VolatileProjectStorage();
    const tools = createConnectTools({
      host: () => undefined,
      projects: () => [],
      update: () => undefined,
      create: async () => undefined,
      projectUrl: (projectId) => `https://drizzle.run/p/${projectId}`,
      fetchText: noFetch,
    });
    const [firstTab, secondTab] = [connectServices({ settings, tools }), connectServices({ settings, tools })];
    await Promise.all([firstTab.loadPendingEdits?.(), secondTab.loadPendingEdits?.()]);

    await Promise.all([
      firstTab.savePendingEdits?.([makeEdit("first")]),
      secondTab.savePendingEdits?.([makeEdit("second")]),
    ]);

    expect(await settings.readSetting(PENDING_EDITS_SETTING)).toEqual([makeEdit("first"), makeEdit("second")]);
  });
});
