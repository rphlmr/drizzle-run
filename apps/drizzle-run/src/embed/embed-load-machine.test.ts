import type { RecordedRunResult, RuntimeCapabilities } from "@drizzle-run/core/contracts";
import { fakeRunResult } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { createProject, isOneVersion } from "../project/projects";
import { PlaygroundNotFoundError } from "../share/playgrounds-contract";
import type { EmbedConnection, EmbedEvent } from "./bridge";
import { createEmbedLoadMachine, type EmbedRuntime } from "./embed-load-machine";
import type { EmbedSource, RecordedPlayground } from "./embed-source";

const connection: EmbedConnection = { nonce: "0123456789abcdef0123456789abcdef", origin: "https://blog.example.test" };

function makeRecordedResult(): RecordedRunResult {
  const result = fakeRunResult("succeeded");

  if (result.outcome !== "succeeded") {
    throw new Error(`Expected a succeeded run fixture, but got '${result.outcome}'.`);
  }

  const { database: _database, queryPlans: _queryPlans, ...recorded } = result;

  return recorded;
}

function makeRecorded(): RecordedPlayground {
  const project = createProject("Bank transfers", { dialect: "sqlite" });

  if (!isOneVersion(project)) {
    throw new Error("Expected a one-version project.");
  }

  return {
    kind: "one_version",
    project,
    result: makeRecordedResult(),
    recordedAt: "2026-01-01T00:00:00.000Z",
    reason: "browser_unsupported",
    recordedBy: "author",
  };
}

function makeRuntime(status: RuntimeCapabilities["status"] = "available") {
  return {
    checkCapabilities: vi.fn(async (): Promise<RuntimeCapabilities> => ({ status, reasons: [] })),
    dispose: vi.fn(async () => {}),
  } satisfies EmbedRuntime;
}

function startEmbed({
  runtime = makeRuntime(),
  source = {},
}: {
  runtime?: ReturnType<typeof makeRuntime> | Promise<ReturnType<typeof makeRuntime>>;
  source?: Partial<EmbedSource>;
} = {}) {
  const posted: EmbedEvent[] = [];
  const postUnsupportedHost = vi.fn();
  const actor = createActor(
    createEmbedLoadMachine({
      source: {
        target: { snapshotId: "snap_123" },
        playgroundHref: "/playground/snap_123",
        loadPlayground: async () => ({ project: createProject("Bank transfers", { dialect: "sqlite" }) }),
        findRecorded: async () => null,
        ...source,
      },
      createRuntime: async () => runtime,
      post: (to, event) => {
        expect(to).toEqual(connection);
        posted.push(event);
      },
      postUnsupportedHost,
    }),
  ).start();

  return { actor, posted, postUnsupportedHost };
}

describe("createEmbedLoadMachine", () => {
  it("should tell a parent connected while loading that the playground runs, then that it shows", async () => {
    const loaded = Promise.withResolvers<null>();
    const { actor, posted } = startEmbed({ source: { loadPlayground: () => loaded.promise.then(() => null) } });
    await waitFor(actor, (snapshot) => snapshot.matches("loading"));

    actor.send({ type: "parent.connect", connection });
    const whileLoading = [...posted];
    loaded.resolve(null);
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));

    expect(whileLoading).toEqual([{ kind: "capability", status: "available" }]);
    expect(posted.slice(1)).toEqual([{ kind: "error", code: "unopenable" }]);
  });

  it("should replay the capability and ready to a parent that connects once the playground has painted", async () => {
    const { actor, posted } = startEmbed();
    await waitFor(actor, (snapshot) => snapshot.matches("open"));
    actor.send({ type: "view.shown" });

    actor.send({ type: "parent.connect", connection });

    expect(posted).toEqual([{ kind: "capability", status: "available" }, { kind: "ready" }]);
  });

  it("should hold ready until the open playground has painted", async () => {
    const { actor, posted } = startEmbed();
    actor.send({ type: "parent.connect", connection });
    await waitFor(actor, (snapshot) => snapshot.matches("open"));
    const beforePaint = [...posted];

    actor.send({ type: "view.shown" });

    expect(beforePaint).toEqual([{ kind: "capability", status: "available" }]);
    expect(posted).toEqual([{ kind: "capability", status: "available" }, { kind: "ready" }]);
  });

  it("should announce a recorded run by its capability alone", async () => {
    const recorded = makeRecorded();
    const { actor, posted } = startEmbed({
      runtime: makeRuntime("browser_unsupported"),
      source: { findRecorded: async () => recorded },
    });
    await waitFor(actor, (snapshot) => snapshot.matches("recorded"));

    actor.send({ type: "parent.connect", connection });

    expect(actor.getSnapshot().context.recorded).toBe(recorded);
    expect(posted).toEqual([{ kind: "capability", status: "recorded" }]);
  });

  it("should report a browser that cannot run with no recording by its status, and a configuration error as one", async () => {
    const unsupported = startEmbed({ runtime: makeRuntime("embedding_context_unsupported") });
    const misconfigured = startEmbed({ runtime: makeRuntime("configuration_error") });
    await waitFor(unsupported.actor, (snapshot) => snapshot.matches("unavailable"));
    await waitFor(misconfigured.actor, (snapshot) => snapshot.matches("unavailable"));

    unsupported.actor.send({ type: "parent.connect", connection });
    misconfigured.actor.send({ type: "parent.connect", connection });

    expect(unsupported.posted).toEqual([{ kind: "capability", status: "embedding_context_unsupported" }]);
    expect(misconfigured.posted).toEqual([{ kind: "error", code: "initialization" }]);
  });

  it("should report a missing playground as not found, with no ready before it", async () => {
    const { actor, posted } = startEmbed({
      source: {
        loadPlayground: async () => {
          throw new PlaygroundNotFoundError("This shared playground no longer exists.");
        },
      },
    });
    actor.send({ type: "parent.connect", connection });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));

    expect(posted).toEqual([
      { kind: "capability", status: "available" },
      { kind: "error", code: "not_found" },
    ]);
  });

  it("should ignore a parent on another origin once one connected", async () => {
    const { actor, posted } = startEmbed();
    await waitFor(actor, (snapshot) => snapshot.matches("open"));
    actor.send({ type: "view.shown" });

    actor.send({ type: "parent.connect", connection });
    actor.send({ type: "parent.connect", connection: { ...connection, origin: "https://other.example.test" } });

    expect(posted).toHaveLength(2);
    expect(actor.getSnapshot().context.connection).toEqual(connection);
  });

  it("should tell an opaque host it cannot connect, once", () => {
    const { actor, postUnsupportedHost } = startEmbed();

    actor.send({ type: "parent.connect.opaque", nonce: connection.nonce });
    actor.send({ type: "parent.connect.opaque", nonce: connection.nonce });

    expect(postUnsupportedHost).toHaveBeenCalledExactlyOnceWith(connection.nonce);
  });

  it("should send a settled run only to a connected parent, without replaying it", async () => {
    const { actor, posted } = startEmbed();
    const run = { outcome: "succeeded", displays: [], truncated: false } as const;
    await waitFor(actor, (snapshot) => snapshot.matches("open"));

    actor.send({ type: "run.settled", run });
    actor.send({ type: "parent.connect", connection });
    actor.send({ type: "run.settled", run });

    expect(posted.filter((event) => event.kind === "run-settled")).toEqual([{ kind: "run-settled", run }]);
  });

  it("should fail with the page's error from an open playground", async () => {
    const { actor } = startEmbed();
    await waitFor(actor, (snapshot) => snapshot.matches("open"));

    actor.send({ type: "embed.fail", message: "The editor stopped." });

    expect(actor.getSnapshot().context.failure).toEqual({ code: "internal", message: "The editor stopped." });
  });

  it("should dispose the runtime when the embed closes, even one created after it closed", async () => {
    const runtime = makeRuntime();
    const created = Promise.withResolvers<ReturnType<typeof makeRuntime>>();
    const { actor } = startEmbed({ runtime: created.promise });

    actor.stop();
    created.resolve(runtime);
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());

    expect(runtime.checkCapabilities).not.toHaveBeenCalled();
  });
});
