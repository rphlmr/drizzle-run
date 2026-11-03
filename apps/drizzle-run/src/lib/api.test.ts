import { describe, expect, it } from "vitest";

import { readJsonBody, sendApiRequest } from "./api";

async function fetchOffline(): Promise<Response> {
  throw new TypeError("Failed to fetch");
}

describe("sendApiRequest", () => {
  it("should say Drizzle Run could not be reached when the request never arrives", async () => {
    const sent = sendApiRequest(fetchOffline, "https://run.test/api", { signal: new AbortController().signal });

    await expect(sent).rejects.toThrow("Drizzle Run could not be reached. Check your connection, then try again.");
    await expect(sent).rejects.toMatchObject({ cause: new TypeError("Failed to fetch") });
  });

  it("should reject a cancelled request as it did", async () => {
    const controller = new AbortController();
    const cancelled = new DOMException("The operation was aborted.", "AbortError");
    const fetch = async () => {
      controller.abort();
      throw cancelled;
    };

    await expect(sendApiRequest(fetch, "https://run.test/api", { signal: controller.signal })).rejects.toBe(cancelled);
  });

  it("should resolve with the response, whatever its status", async () => {
    const response = new Response(null, { status: 503 });

    await expect(
      sendApiRequest(async () => response, "https://run.test/api", { signal: new AbortController().signal }),
    ).resolves.toBe(response);
  });
});

describe("readJsonBody", () => {
  it("should read a JSON body", async () => {
    const response = Response.json({ ok: true });

    await expect(readJsonBody(response, new AbortController().signal)).resolves.toEqual({ ok: true });
  });

  it("should read a failed response that is not JSON, such as a proxy's 502 page, as undefined", async () => {
    const response = new Response("<html>Bad gateway</html>", { status: 502 });

    await expect(readJsonBody(response, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("should say Drizzle Run could not be reached when a successful body cannot be read", async () => {
    const response = new Response('{"rows": [', { status: 200 });

    await expect(readJsonBody(response, new AbortController().signal)).rejects.toThrow(
      "Drizzle Run could not be reached. Check your connection, then try again.",
    );
  });

  it("should reject a request cancelled while its body was read as it did", async () => {
    const controller = new AbortController();
    const cancelled = new DOMException("The operation was aborted.", "AbortError");
    const response = new Response("{}");
    Object.defineProperty(response, "json", {
      value: async () => {
        controller.abort();
        throw cancelled;
      },
    });

    await expect(readJsonBody(response, controller.signal)).rejects.toBe(cancelled);
  });
});
