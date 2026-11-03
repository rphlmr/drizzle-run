import { describe, expect, it } from "vitest";

import { createStartupResources } from "./startup-resources.ts";

describe("startup resources", () => {
  it("should release created resources newest first", async () => {
    const resources = createStartupResources();
    const released: string[] = [];

    await resources.track(Promise.resolve("folder"), async (name) => {
      released.push(name);
    });
    await resources.track(Promise.resolve("socket"), async (name) => {
      released.push(name);
    });
    await resources.release();

    expect(released).toEqual(["socket", "folder"]);
  });

  it("should wait for a resource still being created, then release it", async () => {
    const resources = createStartupResources();
    const creation = Promise.withResolvers<string>();
    const released: string[] = [];

    void resources.track(creation.promise, async (name) => {
      released.push(name);
    });

    const releasing = resources.release();

    expect(released).toEqual([]);

    creation.resolve("folder");
    await releasing;

    expect(released).toEqual(["folder"]);
  });

  it("should skip a creation that failed and keep releasing past a release that throws", async () => {
    const resources = createStartupResources();
    const released: string[] = [];

    await resources.track(Promise.resolve("folder"), async (name) => {
      released.push(name);
    });
    await resources.track(Promise.resolve("socket"), async () => {
      throw new Error("Socket already closed");
    });
    await expect(
      resources.track(Promise.reject(new Error("No space left")), async () => {
        released.push("never");
      }),
    ).rejects.toThrow("No space left");
    await resources.release();

    expect(released).toEqual(["folder"]);
  });

  it("should release each resource once", async () => {
    const resources = createStartupResources();
    let releases = 0;

    await resources.track(Promise.resolve("folder"), async () => {
      releases += 1;
    });
    await Promise.all([resources.release(), resources.release()]);

    expect(releases).toBe(1);
  });
});
