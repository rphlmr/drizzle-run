import { describe, expect, it, vi } from "vitest";

import { encodeDatabaseValue as encode } from "./database-codec.ts";
import { DatabaseWorkerClient, type DatabaseWorkerTransport } from "./database-rpc-client.ts";

class FakeDatabaseWorker implements DatabaseWorkerTransport {
  readonly sent: unknown[] = [];
  terminated = 0;
  #onMessage: ((message: unknown) => void) | undefined;
  #onError: ((cause: Error) => void) | undefined;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  terminate(): void | Promise<void> {
    this.terminated += 1;
  }

  subscribe(onMessage: (message: unknown) => void, onError: (cause: Error) => void): void {
    this.#onMessage = onMessage;
    this.#onError = onError;
  }

  emit(message: unknown): void {
    this.#onMessage?.(message);
  }

  fail(cause: Error): void {
    this.#onError?.(cause);
  }
}

const markReady = async (transport: FakeDatabaseWorker): Promise<void> => {
  transport.emit({ kind: "ready" });
  await Promise.resolve();
};

describe("DatabaseWorkerClient", () => {
  it.each(["dispose", "failure"] as const)("should await actual worker termination after %s", async (reason) => {
    const transport = new FakeDatabaseWorker();
    const terminated = Promise.withResolvers<void>();
    const terminate = vi.spyOn(transport, "terminate").mockImplementation(() => terminated.promise);
    const client = new DatabaseWorkerClient(transport, "sqlite");
    const published = vi.fn();

    if (reason === "failure") {
      transport.fail(new Error("worker failed"));
    }

    const disposal = client.dispose().then(published);
    await Promise.resolve();
    expect(published).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();

    terminated.resolve();
    await disposal;
    expect(published).toHaveBeenCalledOnce();
  });

  it("should reject disposal when worker termination fails without retrying", async () => {
    const transport = new FakeDatabaseWorker();
    const failure = new Error("termination failed");
    const terminate = vi.spyOn(transport, "terminate").mockImplementation(() => {
      throw failure;
    });
    const client = new DatabaseWorkerClient(transport, "sqlite");

    await expect(client.dispose()).rejects.toBe(failure);
    await expect(client.dispose()).rejects.toBe(failure);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("should wait for ready and decode replies", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "sqlite", { onFailure });
    const request = client.call("sqlite.execute", { sql: "SELECT 1" });

    expect(transport.sent).toEqual([{ kind: "init", dialect: "sqlite" }]);
    await markReady(transport);

    expect(transport.sent[1]).toEqual({
      id: 1,
      operation: "sqlite.execute",
      value: encode({ sql: "SELECT 1" }),
    });

    transport.emit({ id: 1, value: encode({ rows: [[1]] }) });

    await expect(request).resolves.toEqual({ rows: [[1]] });
    expect(onFailure).not.toHaveBeenCalled();
    await client.dispose();
    expect(transport.terminated).toBe(1);
  });

  it("should turn a duplicate response into one terminal failure even with no request pending", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "sqlite", { onFailure });
    const request = client.call("sqlite.execute", {});

    await markReady(transport);
    transport.emit({ id: 1, value: encode(undefined) });
    await expect(request).resolves.toBeUndefined();

    transport.emit({ id: 1, value: encode(undefined) });

    const failure = onFailure.mock.calls[0]?.[0] as Error;
    expect(failure.message).toMatch(/duplicate/i);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(transport.terminated).toBe(1);
    await expect(client.call("sqlite.begin", {})).rejects.toBe(failure);

    await client.dispose();
    expect(transport.terminated).toBe(1);
  });

  it("should reject active and future calls after a malformed response", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "postgresql", { onFailure });
    const request = client.call("pg.exchange", new Uint8Array([1]));

    await markReady(transport);
    transport.emit({ id: 1, error: { message: "missing serialized error name" } });

    const failure = onFailure.mock.calls[0]?.[0] as Error;
    await expect(request).rejects.toBe(failure);
    await expect(client.call("pg.exchange", new Uint8Array([2]))).rejects.toBe(failure);
    expect(failure.message).toMatch(/malformed/i);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(transport.terminated).toBe(1);
  });

  it("should reject the active request when its encoded value cannot be decoded", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "sqlite", { onFailure });
    const request = client.call("sqlite.execute", {});

    await markReady(transport);
    transport.emit({ id: 1, value: { type: "unsupported" } });

    const failure = onFailure.mock.calls[0]?.[0] as Error;
    await expect(request).rejects.toBe(failure);
    await expect(client.call("sqlite.execute", {})).rejects.toBe(failure);
    expect(failure.message).toMatch(/invalid database transport value/i);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(transport.terminated).toBe(1);
  });

  it("should keep an operation error request-scoped and usable for subsequent calls", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "sqlite", { onFailure });
    const failedRequest = client.call("sqlite.execute", {});

    await markReady(transport);
    transport.emit({
      id: 1,
      error: {
        name: "LibsqlError",
        message: "constraint violation",
        code: "SQLITE_CONSTRAINT",
        extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
        rawCode: 2067,
      },
    });

    await expect(failedRequest).rejects.toMatchObject({
      name: "LibsqlError",
      code: "SQLITE_CONSTRAINT",
      extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
      rawCode: 2067,
    });

    const succeedingRequest = client.call("sqlite.execute", {});
    await Promise.resolve();
    transport.emit({ id: 2, value: encode("ok") });

    await expect(succeedingRequest).resolves.toBe("ok");
    expect(onFailure).not.toHaveBeenCalled();
    await client.dispose();
    expect(transport.terminated).toBe(1);
  });

  it("should fail and terminate once when the worker errors", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "sqlite", { onFailure });
    const request = client.call("sqlite.execute", {});

    await markReady(transport);
    transport.fail(new Error("worker crashed"));

    const failure = onFailure.mock.calls[0]?.[0] as Error;
    await expect(request).rejects.toBe(failure);
    expect(failure.message).toBe("worker crashed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(transport.terminated).toBe(1);
  });

  it("should reject calls waiting for ready, calls in flight and later calls once disposed", async () => {
    const transport = new FakeDatabaseWorker();
    const client = new DatabaseWorkerClient(transport, "sqlite");
    const waiting = client.call("sqlite.execute", {});

    await markReady(transport);
    const inFlight = client.call("sqlite.execute", {});
    const pendingRejections = Promise.all(
      [waiting, inFlight].map(async (request) => {
        await expect(request).rejects.toThrow("Database worker client is closed");
      }),
    );
    await client.dispose();
    await pendingRejections;
    await expect(client.call("sqlite.execute", {})).rejects.toThrow("Database worker client is closed");
    expect(transport.terminated).toBe(1);
  });

  it("should fail on a reply that arrives before ready", async () => {
    const transport = new FakeDatabaseWorker();
    const onFailure = vi.fn();
    const client = new DatabaseWorkerClient(transport, "sqlite", { onFailure });
    const request = client.call("sqlite.execute", {});

    transport.emit({ id: 1, value: encode(undefined) });

    await expect(request).rejects.toThrow("Unexpected database worker response");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(transport.terminated).toBe(1);
  });
});
