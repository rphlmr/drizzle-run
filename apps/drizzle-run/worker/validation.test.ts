import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as z from "zod/mini";

import { refuseInvalid, requireJson } from "./validation";

const HeadersSchema = z.object({
  "x-request-label": z.optional(z.string().check(z.regex(/^label-/))),
  "idempotency-key": z.string().check(z.minLength(16, "Provide a longer idempotency key.")),
});

function refuseHeaders(headers: unknown): Response | undefined {
  const parsed = HeadersSchema["~standard"].validate(headers);

  if (parsed instanceof Promise) {
    throw new Error("Expected the headers schema to validate synchronously.");
  }

  const refuse = refuseInvalid(
    { status: 400, code: "invalid_request_label", message: "The request label is malformed." },
    { "idempotency-key": { status: 400, code: "invalid_idempotency_key" } },
  );

  return refuse(parsed.issues === undefined ? { success: true } : { success: false, error: parsed.issues });
}

describe("refuseInvalid", () => {
  it("should let valid input through", () => {
    expect(refuseHeaders({ "idempotency-key": "k".repeat(16) })).toBeUndefined();
  });

  it("should refuse with the refusal of the field the first issue names", async () => {
    const response = refuseHeaders({ "x-request-label": "label-1", "idempotency-key": "short" });

    expect(response?.status).toBe(400);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({
      error: { code: "invalid_idempotency_key", message: "Provide a longer idempotency key." },
    });
  });

  it("should refuse with the route's refusal and its own message for any other field", async () => {
    const response = refuseHeaders({ "x-request-label": "other", "idempotency-key": "short" });

    expect(await response?.json()).toEqual({
      error: { code: "invalid_request_label", message: "The request label is malformed." },
    });
  });
});

/** A route that takes `{ count }` as JSON, behind `requireJson`. */
async function postCount(contentType: string): Promise<Response> {
  const app = new Hono().post(
    "/",
    requireJson("Send JSON."),
    sValidator("json", z.object({ count: z.number() })),
    (c) => c.json(c.req.valid("json")),
  );

  return app.request("/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify({ count: 1 }),
  });
}

describe("requireJson", () => {
  it("should let through every content type the JSON validator reads", async () => {
    for (const contentType of ["application/json", "application/json; charset=utf-8", "application/vnd.api+json"]) {
      const response = await postCount(contentType);

      expect(response.status, contentType).toBe(200);
      expect(await response.json()).toEqual({ count: 1 });
    }
  });

  it("should refuse a content type the JSON validator would skip, instead of reading an empty body", async () => {
    for (const contentType of ["text/plain+json", "application/json; charset"]) {
      const response = await postCount(contentType);

      expect(response.status, contentType).toBe(415);
    }
  });
});
