import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunObservation } from "../../../../guests/quickjs-observation.ts";

afterEach(() => vi.unstubAllGlobals());

describe("guest SQLite batch observation", () => {
  it("should preserve named bindings for individual statements and batches", async () => {
    const emit = vi.fn();
    vi.stubGlobal("hostRuntimeEvent", emit);
    const client = createRunObservation().observeClient(
      {
        execute: async (_input: unknown) => ({}),
        batch: async (_input: unknown[]) => [],
      },
      "sqlite",
    );
    const input = { sql: "select :a as first, :b as second", args: { b: 2, a: 1 } };

    await client.execute(input);
    await client.batch([input]);

    expect(emit).toHaveBeenCalledTimes(2);
    for (const [message] of emit.mock.calls) {
      expect(JSON.parse(message)).toMatchObject({
        payload: {
          parameters: [],
          namedParameters: { b: { type: "primitive", value: 2 }, a: { type: "primitive", value: 1 } },
        },
      });
    }
  });

  it("should preserve the batch error while reporting failed SQL", async () => {
    const emit = vi.fn();
    vi.stubGlobal("hostRuntimeEvent", emit);
    const failure = new Error("batch database failure");
    const batch = vi.fn(async (_input: unknown[]) => {
      throw failure;
    });
    const client = createRunObservation().observeClient({ batch }, "sqlite");

    await expect(client.batch(["INSERT INTO missing VALUES (1)"])).rejects.toBe(failure);

    expect(batch).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('"outcome":"failed"'));
    expect(emit).toHaveBeenCalledWith(expect.stringContaining("batch database failure"));
  });

  it("should reject malformed SQL before executing any batch statements", async () => {
    const batch = vi.fn(async (_input: unknown[]) => []);
    const client = createRunObservation().observeClient({ batch }, "sqlite");

    await expect(client.batch(["INSERT INTO users VALUES (1)", { sql: 123 }])).rejects.toThrow(
      "A batch statement requires SQL text",
    );

    expect(batch).not.toHaveBeenCalled();
  });
});
