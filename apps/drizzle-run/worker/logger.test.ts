import { afterEach, describe, expect, it, vi } from "vitest";

import { getRequestId, logWorkerFailure, runDurableObjectCallback, serializeWorkerError } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Worker logging", () => {
  it("should emit one JSON line with a stable event, request id and nested cause", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = new Error("Storage failed");
    const error = Object.assign(new Error("Query failed", { cause }), { params: ["private-value"] });
    const request = new Request("https://run.test/api/community?token=private-token", {
      headers: { authorization: "Bearer private-auth", "x-request-id": "forged-id" },
    });

    logWorkerFailure({ event: "community_read_failed", cause: error, message: "Loading Community failed", request });

    expect(output).toHaveBeenCalledTimes(1);
    const line = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: 50,
      time: expect.any(Number),
      event: "community_read_failed",
      msg: "Loading Community failed",
      request_id: getRequestId(request),
      method: "GET",
      path: "/api/community",
      err: {
        type: "Error",
        message: "Query failed",
        stack: expect.any(String),
        cause: { type: "Error", message: "Storage failed", stack: expect.any(String) },
      },
    });
    expect(line).not.toMatch(/private-value|private-token|private-auth|forged-id/);
    expect(getRequestId(new Request(request))).not.toBe(getRequestId(request));
  });

  it("should serialize non-Error throws and circular causes", () => {
    const error = new Error("Loop");
    error.cause = error;

    expect(serializeWorkerError(error).cause).toEqual({ type: "Error", message: "Circular error cause." });
    expect(serializeWorkerError("failure")).toEqual({ type: "string", message: "failure" });
    expect(() => JSON.stringify(serializeWorkerError({ token: "private", value: 1n }))).not.toThrow();
  });

  it.each(["connect_message_failed", "connect_alarm_failed", "connect_close_failed"])(
    "should log %s once and preserve the thrown value for the runtime",
    async (event) => {
      const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const failure = new Error("Storage unavailable");

      await expect(
        runDurableObjectCallback(event, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ event, err: { message: failure.message } });
    },
  );
});
