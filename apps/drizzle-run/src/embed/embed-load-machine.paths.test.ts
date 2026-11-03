import { listSupportedTuples } from "@drizzle-run/core/catalog";
import type { RecordedRunResult, RuntimeCapabilities } from "@drizzle-run/core/contracts";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { fakeRunResult } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, type SnapshotFrom } from "xstate";

import { createProject, isOneVersion } from "../project/projects";
import type { EmbedConnection } from "./bridge";
import { resolveEmbedLoad, type EmbedLoadState } from "./embed-load";
import { createEmbedLoadMachine, type EmbedRuntime } from "./embed-load-machine";
import type { EmbedSource, RecordedPlayground } from "./embed-source";

const project = createProject("Bank transfers", { dialect: "postgresql" });
const firstParent: EmbedConnection = { nonce: "0123456789abcdef0123456789abcdef", origin: "https://blog.example.test" };
const otherParent: EmbedConnection = { nonce: "fedcba9876543210fedcba9876543210", origin: "https://blog.example.test" };
const nextTuple = listSupportedTuples({ dialect: "postgresql" }).find((tuple) => tuple.releaseLine === "next");

if (nextTuple === undefined) {
  throw new Error("Expected the catalog to support a PostgreSQL pair on the next release line");
}

function makeRecorded(): RecordedPlayground {
  const recordedProject = createProject("Bank transfers", { dialect: "sqlite" });
  const result = fakeRunResult("succeeded");

  if (!isOneVersion(recordedProject) || result.outcome !== "succeeded") {
    throw new Error("Expected a one-version project and a succeeded run fixture.");
  }

  const { database: _database, queryPlans: _queryPlans, ...recordedResult } = result;

  return {
    kind: "one_version",
    project: recordedProject,
    result: recordedResult satisfies RecordedRunResult,
    recordedAt: "2026-01-01T00:00:00.000Z",
    reason: "browser_unsupported",
    recordedBy: "author",
  };
}

const retiredDependencies = { "drizzle-orm": "1.0.0-rc.3", "drizzle-kit": "1.0.0-rc.3" };
const loadedProject: EmbedLoadState = { kind: "project", project };
const loadedRetired = resolveEmbedLoad({
  retired: {
    snapshot: {
      snapshotVersion: 1,
      name: project.name,
      manifest: { ...project.manifest, dependencies: retiredDependencies },
    },
    retiredPair: {
      target: { dialect: "postgresql" },
      releaseLine: "next",
      ormVersion: "1.0.0-rc.3",
      kitVersion: "1.0.0-rc.3",
    },
    digest: "a".repeat(64),
    updatedAt: "2026-10-11T00:00:00.000Z",
    description: null,
    community: null,
  },
});
const loadedUnopenable = resolveEmbedLoad(null);
const available: RuntimeCapabilities = { status: "available", reasons: [] };
const browserUnsupported: RuntimeCapabilities = { status: "browser_unsupported", reasons: [] };
const misconfigured: RuntimeCapabilities = { status: "configuration_error", reasons: [] };
const recorded = makeRecorded();
const outcomes = {
  checkCapabilities: {
    outputs: [available, browserUnsupported, misconfigured],
    error: new Error("The capability check crashed."),
  },
  findRecorded: { outputs: [recorded, null], error: new Error("The recording could not be read.") },
  loadPlayground: {
    outputs: [loadedProject, loadedRetired, loadedUnopenable],
    error: new Error("The playground could not be loaded."),
  },
} satisfies Record<string, ActorOutcome<unknown>>;

const runtime = { checkCapabilities: vi.fn(), dispose: vi.fn() } satisfies EmbedRuntime;
const connectFirstParent = { type: "parent.connect", connection: firstParent } as const;
const connectOtherParent = { type: "parent.connect", connection: otherParent } as const;
const eventLabels = new Map<unknown, string>([
  [connectFirstParent, "parent.connect"],
  [connectOtherParent, "parent.connect of another parent"],
]);
const outputLabels = new Map<unknown, string>([
  [available, "done(checkCapabilities) available"],
  [browserUnsupported, "done(checkCapabilities) browser unsupported"],
  [misconfigured, "done(checkCapabilities) configuration error"],
  [recorded, "done(findRecorded) with a recording"],
  [null, "done(findRecorded) without a recording"],
  [loadedProject, "done(loadPlayground) with a project"],
  [loadedRetired, "done(loadPlayground) on a removed pair"],
  [loadedUnopenable, "done(loadPlayground) unopenable"],
]);

function describeEvent(event: ModelEvent) {
  if (event.type.startsWith("xstate.done.actor.") && outputLabels.has(event.output)) {
    return outputLabels.get(event.output);
  }

  return eventLabels.get(event);
}

const source: EmbedSource = {
  target: { snapshotId: "snap_123" },
  playgroundHref: "/playground/snap_123",
  loadPlayground: vi.fn(),
  findRecorded: vi.fn(),
};

function makeEmbedLoadMachine() {
  return createEmbedLoadMachine({
    source,
    createRuntime: vi.fn(),
    post: vi.fn(),
    postUnsupportedHost: vi.fn(),
  });
}

const embedLoadMachine = makeEmbedLoadMachine();

function toModelState(snapshot: SnapshotFrom<typeof embedLoadMachine>) {
  return {
    value: snapshot.value,
    connected: snapshot.context.connection !== undefined,
    toldOpaqueHost: snapshot.context.toldOpaqueHost,
  };
}

function startEmbedLoad() {
  const settler = createActorSettler();
  const machine = makeEmbedLoadMachine().provide({
    actors: {
      runtime: fromCallback(() => {}),
      checkCapabilities: settler.fromOutcome(outcomes.checkCapabilities),
      findRecorded: settler.fromOutcome(outcomes.findRecorded),
      loadPlayground: settler.fromOutcome(outcomes.loadPlayground),
    },
  });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(embedLoadMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    { type: "runtime.ready", runtime },
    { type: "runtime.failed", error: new Error("WebAssembly is disabled.") },
    { type: "release.choose", choices: [{ tupleId: nextTuple.id }] },
    { type: "project.update", project },
    { type: "embed.fail", message: "The editor crashed." },
    connectFirstParent,
    connectOtherParent,
    { type: "parent.connect.opaque", nonce: firstParent.nonce },
    { type: "run.settled", run: { outcome: "succeeded", displays: [], truncated: false } },
    { type: "view.shown" },
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("embed load machine paths", () => {
  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startEmbedLoad();

      await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
