import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeDatabaseValue as decode, encodeDatabaseValue as encode } from "./database-codec.ts";
import type { DatabaseEngine } from "./database-engine.ts";
import type { WorkerScope } from "./worker-scope.ts";

const engineControls = vi.hoisted(() => ({
  createEngine: undefined as ((dialect: string) => Promise<DatabaseEngine>) | undefined,
}));

vi.mock("./database-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseEngineModule>()),
  createDatabaseEngine: (dialect: string) => {
    if (engineControls.createEngine === undefined) {
      throw new Error("Expected the test to set createEngine before the worker starts a database.");
    }

    return engineControls.createEngine(dialect);
  },
}));

import type * as DatabaseEngineModule from "./database-engine.ts";

/** The worker's global scope: it records what the worker posts and whether it closed itself. */
class FakeWorkerScope implements WorkerScope {
  readonly posted: unknown[] = [];
  closed = false;
  #listener: ((event: MessageEvent<unknown>) => void) | undefined;

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.#listener = listener;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  close(): void {
    this.closed = true;
  }

  send(data: unknown): void {
    if (this.#listener === undefined) {
      throw new Error("Expected the database worker to listen for messages.");
    }

    // The worker reads only `data` of a MessageEvent.
    this.#listener({ data } as MessageEvent<unknown>);
  }
}

function makeEngine({ call = async () => ({ rows: [] }) }: { call?: DatabaseEngine["call"] } = {}) {
  const engine = { call: vi.fn(call), close: vi.fn(async () => undefined) };

  return engine;
}

async function startWorker(engine = makeEngine()) {
  const scope = new FakeWorkerScope();
  vi.stubGlobal("self", scope);
  engineControls.createEngine = vi.fn(async () => engine);
  vi.resetModules();
  const { serveDatabase } = await import("./database-service.ts");
  serveDatabase(scope);

  return { scope, engine };
}

async function startReadyWorker(dialect = "sqlite", engine = makeEngine()) {
  const started = await startWorker(engine);
  started.scope.send({ kind: "init", dialect });
  await vi.waitFor(() => expect(started.scope.posted).toContainEqual({ kind: "ready" }));

  return started;
}

beforeEach(() => {
  engineControls.createEngine = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("database worker", () => {
  it("should start the requested dialect and answer a request with its encoded result", async () => {
    const engine = makeEngine({ call: async () => ({ rows: [[1, "Ada"]] }) });
    const { scope } = await startReadyWorker("sqlite", engine);

    scope.send({ id: 1, operation: "sqlite.execute", value: encode({ sql: "select 1" }) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(2));

    expect(engineControls.createEngine).toHaveBeenCalledExactlyOnceWith("sqlite");
    expect(engine.call).toHaveBeenCalledExactlyOnceWith("sqlite.execute", { sql: "select 1" });
    const reply = scope.posted[1] as { id: number; value: unknown };
    expect(reply.id).toBe(1);
    expect(decode(reply.value)).toEqual({ rows: [[1, "Ada"]] });
  });

  it("should refuse an unsupported dialect and a second init as startup errors", async () => {
    const { scope } = await startWorker();

    scope.send({ kind: "init", dialect: "mysql" });
    scope.send({ kind: "init", dialect: "postgresql" });
    scope.send({ kind: "init", dialect: "postgresql" });
    await vi.waitFor(() => expect(scope.posted).toContainEqual({ kind: "ready" }));

    expect(scope.posted).toEqual([
      { kind: "startup_error", error: expect.objectContaining({ message: "Unsupported database dialect" }) },
      {
        kind: "startup_error",
        error: expect.objectContaining({ message: "Database worker was initialized more than once" }),
      },
      { kind: "ready" },
    ]);
  });

  it("should report an engine that fails to start", async () => {
    const { scope } = await startWorker();
    engineControls.createEngine = async () => {
      throw new Error("PGlite failed to start");
    };

    scope.send({ kind: "init", dialect: "postgresql" });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(1));

    expect(scope.posted[0]).toEqual({
      kind: "startup_error",
      error: expect.objectContaining({ message: "PGlite failed to start" }),
    });
  });

  it("should refuse a request before init, a reused id, and an operation the dialect does not allow", async () => {
    const { scope } = await startWorker();

    scope.send({ id: 1, operation: "sqlite.execute", value: encode({}) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(1));
    scope.send({ kind: "init", dialect: "sqlite" });
    await vi.waitFor(() => expect(scope.posted).toContainEqual({ kind: "ready" }));
    scope.send({ id: 1, operation: "sqlite.execute", value: encode({}) });
    scope.send({ id: 2, operation: "pg.exchange", value: encode({}) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(4));

    expect(scope.posted).toEqual([
      { id: 1, error: expect.objectContaining({ message: "Database worker has not been initialized" }) },
      { kind: "ready" },
      { id: 1, error: expect.objectContaining({ message: "Database worker request ID was reused" }) },
      { id: 2, error: expect.objectContaining({ message: "Unsupported database operation: pg.exchange" }) },
    ]);
  });

  it("should close itself on a malformed request", async () => {
    const { scope } = await startReadyWorker();

    scope.send({ id: 0, operation: "sqlite.execute" });
    await vi.waitFor(() => expect(scope.closed).toBe(true));

    expect(scope.posted.at(-1)).toEqual({
      kind: "protocol_error",
      error: expect.objectContaining({ message: "Invalid database worker request" }),
    });
  });

  it("should refuse a request over 2 MiB without calling the engine", async () => {
    const { scope, engine } = await startReadyWorker();

    scope.send({ id: 1, operation: "sqlite.execute", value: "x".repeat(2 * 1024 * 1024 + 1) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(2));

    expect(scope.posted[1]).toEqual({
      id: 1,
      error: expect.objectContaining({ name: "RangeError", message: "Database request exceeds 2 MiB" }),
    });
    expect(engine.call).not.toHaveBeenCalled();
  });

  it("should answer an engine failure with the request's id and keep serving", async () => {
    const engine = makeEngine({
      call: async (operation) => {
        if (operation === "sqlite.execute") {
          throw new Error("no such table: users");
        }

        return { tables: [] };
      },
    });
    const { scope } = await startReadyWorker("sqlite", engine);

    scope.send({ id: 1, operation: "sqlite.execute", value: encode({ sql: "select * from users" }) });
    scope.send({ id: 2, operation: "inspect", value: encode(undefined) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(3));

    expect(scope.posted[1]).toEqual({ id: 1, error: expect.objectContaining({ message: "no such table: users" }) });
    expect((scope.posted[2] as { id: number }).id).toBe(2);
  });

  it("should close the engine, answer, then close the worker on close", async () => {
    const { scope, engine } = await startReadyWorker("postgresql");

    scope.send({ id: 1, operation: "close", value: encode(undefined) });
    await vi.waitFor(() => expect(scope.closed).toBe(true));

    expect(engine.close).toHaveBeenCalledOnce();
    expect(scope.posted.at(-1)).toMatchObject({ id: 1 });
  });

  it("should answer a request queued behind close with an error instead of dropping it", async () => {
    const engineClose = Promise.withResolvers<undefined>();
    const engine = makeEngine();
    engine.close.mockImplementation(() => engineClose.promise);
    const { scope } = await startReadyWorker("postgresql", engine);

    scope.send({ id: 1, operation: "close", value: encode(undefined) });
    scope.send({ id: 2, operation: "inspect", value: encode(undefined) });
    await vi.waitFor(() => expect(engine.close).toHaveBeenCalledOnce());
    engineClose.resolve(undefined);
    await vi.waitFor(() => expect(scope.closed).toBe(true));

    expect(engine.call).not.toHaveBeenCalled();
    expect(scope.posted.slice(1)).toEqual([
      { id: 1, value: encode(undefined) },
      { id: 2, error: expect.objectContaining({ message: "Database worker is closed" }) },
    ]);
  });

  it("should answer requests with the startup failure once the engine failed to start", async () => {
    const { scope } = await startWorker();
    engineControls.createEngine = async () => {
      throw new Error("PGlite failed to start");
    };

    scope.send({ kind: "init", dialect: "postgresql" });
    scope.send({ id: 1, operation: "inspect", value: encode(undefined) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(2));
    scope.send({ id: 2, operation: "inspect", value: encode(undefined) });
    await vi.waitFor(() => expect(scope.posted).toHaveLength(3));

    expect(scope.posted).toEqual([
      { kind: "startup_error", error: expect.objectContaining({ message: "PGlite failed to start" }) },
      { id: 1, error: expect.objectContaining({ message: "PGlite failed to start" }) },
      { id: 2, error: expect.objectContaining({ message: "PGlite failed to start" }) },
    ]);
  });
});
