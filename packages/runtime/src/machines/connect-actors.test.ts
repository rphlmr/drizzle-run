import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { createEditStoreLogic } from "./connect-actors.ts";
import type { ConnectServices } from "./connect-contract.ts";

function makeServices(overrides: Partial<ConnectServices> = {}): ConnectServices {
  return {
    loadPairing: async () => undefined,
    savePairing: async () => undefined,
    clearPairing: async () => undefined,
    roomUrl: (roomId) => `wss://run.test/api/connect/rooms/${roomId}?role=tab`,
    openSocket: () => ({ send: () => undefined, close: () => undefined }),
    executeTool: async () => ({ ok: true, result: null }),
    undoEdit: async () => undefined,
    ...overrides,
  };
}

describe("createEditStoreLogic", () => {
  it("should log a pending edit save that fails, and still save the next edits", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storageFailure = new Error("IndexedDB quota exceeded");
    const saved: number[] = [];
    const savePendingEdits = vi
      .fn<NonNullable<ConnectServices["savePendingEdits"]>>()
      .mockRejectedValueOnce(storageFailure)
      .mockImplementation(async (edits) => {
        saved.push(edits.length);
      });
    const store = createActor(createEditStoreLogic(makeServices({ savePendingEdits }))).start();

    store.send({ type: "edits.save", edits: [] });
    store.send({ type: "edits.save", edits: [] });
    await vi.waitFor(() => expect(saved).toEqual([0]));

    expect(consoleError).toHaveBeenCalledWith("Saving the pending AI edits failed", storageFailure);
    consoleError.mockRestore();
  });
});
