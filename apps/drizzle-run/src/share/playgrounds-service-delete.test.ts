import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../lib/api";
import { createPlaygroundsService } from "./playgrounds-service";

const origin = "https://run.example.test";
const linkId = "123e4567-e89b-42d3-a456-426614174000";

function makeService(fetch: Fetch) {
  return createPlaygroundsService({ fetch, origin });
}

/** A Worker that answers every request with its `{ error: { code, message } }` envelope. */
function answerError(code: string, status: number) {
  return vi.fn<Fetch>(
    async () =>
      new Response(JSON.stringify({ error: { code, message: "Refused." } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function makeSignal() {
  return new AbortController().signal;
}

describe("deleting a shared playground", () => {
  it("should send DELETE with the caller's signal and no Authorization header, and settle on 204", async () => {
    const signal = makeSignal();
    const fetchMock = vi.fn<Fetch>(async () => new Response(null, { status: 204 }));

    await expect(makeService(fetchMock).deletePlayground({ linkId, signal })).resolves.toBe("deleted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/playgrounds/${linkId}`,
      expect.objectContaining({
        method: "DELETE",
        signal,
        headers: { accept: "application/json" },
      }),
    );
  });

  it("should settle as already gone when the Worker no longer has the link", async () => {
    for (const code of ["not_found", "playground_not_found"]) {
      await expect(
        makeService(answerError(code, 404)).deletePlayground({ linkId, signal: makeSignal() }),
      ).resolves.toBe("alreadyGone");
    }
  });

  it("should not take a bare 404 for a deleted link", async () => {
    const fetchMock = vi.fn<Fetch>(
      async () => new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } }),
    );

    await expect(makeService(fetchMock).deletePlayground({ linkId, signal: makeSignal() })).rejects.toThrow(
      "The playground request failed. Check your connection and try again.",
    );
  });

  it("should explain a refused or unavailable deletion", async () => {
    await expect(
      makeService(answerError("sign_in_required", 401)).deletePlayground({ linkId, signal: makeSignal() }),
    ).rejects.toThrow("Sign in with the GitHub account that shared it to stop sharing it.");
    await expect(
      makeService(answerError("not_link_owner", 403)).deletePlayground({ linkId, signal: makeSignal() }),
    ).rejects.toThrow("This share belongs to another GitHub account.");
    await expect(
      makeService(answerError("forbidden", 403)).deletePlayground({ linkId, signal: makeSignal() }),
    ).rejects.toThrow("Only the owner of this share can delete it.");
    await expect(
      makeService(answerError("storage_unavailable", 503)).deletePlayground({ linkId, signal: makeSignal() }),
    ).rejects.toThrow("Deleting shares is temporarily unavailable. Retry in a moment.");
  });

  it("should refuse an invalid link id without a request", async () => {
    const fetchMock = vi.fn<Fetch>(async () => new Response(null, { status: 204 }));

    await expect(makeService(fetchMock).deletePlayground({ linkId: "../me", signal: makeSignal() })).rejects.toThrow(
      "Invalid playground ID.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should name an unreachable Worker, and reject as cancelled when aborted", async () => {
    await expect(
      makeService(
        vi.fn<Fetch>(async () => {
          throw new TypeError("Failed to fetch");
        }),
      ).deletePlayground({ linkId, signal: makeSignal() }),
    ).rejects.toThrow("Drizzle Run could not be reached. Check your connection, then try again.");

    const controller = new AbortController();
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const pending = makeService(
      vi.fn<Fetch>(async () => {
        controller.abort();
        throw aborted;
      }),
    ).deletePlayground({ linkId, signal: controller.signal });

    await expect(pending).rejects.toBe(aborted);
  });
});
