import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { seedTestSession } from "../test/worker/sessions";
import { SqliteD1 } from "../test/worker/sqlite-d1";
import { createD1AuthRepository } from "./auth-repository";

describe("createD1AuthRepository", () => {
  it("should preserve a newer renewal when an older request renews or removes an expired session", async () => {
    const database = new SqliteD1();
    const signedIn = seedTestSession(database, { expiresAt: "2026-10-17T10:00:00.000Z" });
    const tokenHash = createHash("sha256")
      .update(signedIn.cookie.slice(signedIn.cookie.indexOf("=") + 1))
      .digest("hex");
    const repository = createD1AuthRepository(database);

    const renewed = await repository.renewSession({
      tokenHash,
      now: "2026-10-17T09:59:59.000Z",
      renewBefore: "2026-11-15T09:59:59.000Z",
      expiresAt: "2026-11-16T09:59:59.000Z",
    });
    const older = await repository.renewSession({
      tokenHash,
      now: "2026-10-17T09:59:58.000Z",
      renewBefore: "2026-11-15T09:59:58.000Z",
      expiresAt: "2026-11-16T09:59:58.000Z",
    });
    await repository.deleteExpiredSession(tokenHash, "2026-10-17T10:00:00.000Z");

    expect(renewed).toBe("2026-11-16T09:59:59.000Z");
    expect(older).toBe(renewed);
    expect((await repository.findSession(tokenHash))?.expiresAt).toBe(renewed);
  });

  it("should never extend an expired or deleted session", async () => {
    const database = new SqliteD1();
    const signedIn = seedTestSession(database, { expiresAt: "2026-10-17T10:00:00.000Z" });
    const tokenHash = createHash("sha256")
      .update(signedIn.cookie.slice(signedIn.cookie.indexOf("=") + 1))
      .digest("hex");
    const repository = createD1AuthRepository(database);
    const renewal = {
      tokenHash,
      now: "2026-10-17T10:00:00.000Z",
      renewBefore: "2026-11-15T10:00:00.000Z",
      expiresAt: "2026-11-16T10:00:00.000Z",
    };

    expect(await repository.renewSession(renewal)).toBeNull();
    await repository.deleteSession(tokenHash);
    expect(await repository.renewSession(renewal)).toBeNull();
    expect(await repository.findSession(tokenHash)).toBeNull();
  });
});
