import { listSupportedTuples } from "@drizzle-run/core/catalog";
import { moveManifestToPair, type RunManifest } from "@drizzle-run/core/manifest";
import { projectManifest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";

import { createReleaseSwitchMachine, type ReleaseSwitchEmitted, type ReleaseSwitchServices } from "./release-switch.ts";

const [legacy, next] = listSupportedTuples({ dialect: "postgresql" });
const sqliteNext = listSupportedTuples({ dialect: "sqlite" }).find((tuple) => tuple.releaseLine === "next");

if (sqliteNext === undefined) {
  throw new Error("Expected the catalog to support a SQLite pair on the next release line");
}

function start(services: Partial<ReleaseSwitchServices> = {}, locked = false) {
  const apply = vi.fn<ReleaseSwitchServices["apply"]>(async () => undefined);
  const emitted: ReleaseSwitchEmitted[] = [];
  const actor = createActor(createReleaseSwitchMachine({ apply, ...services }), { input: { locked } });

  actor.on("release.switched", (event) => emitted.push(event));
  actor.on("release.switch.failed", (event) => emitted.push(event));
  actor.start();

  return { actor, apply, emitted };
}

describe("release switch machine", () => {
  it("should have the two pairs it switches between", () => {
    expect(legacy.releaseLine).toBe("legacy");
    expect(next.releaseLine).toBe("next");
  });

  it("should move the manifest to the pair, keep files, and apply it", async () => {
    const { actor, apply, emitted } = start();
    const manifest = projectManifest();

    actor.send({ type: "release.switch", manifest, tuple: next });
    expect(actor.getSnapshot().value).toBe("moving");
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    const [moved] = apply.mock.calls[0];

    expect(moved.dependencies).toMatchObject({ "drizzle-orm": next.ormVersion, "drizzle-kit": next.kitVersion });
    expect(moved.files).toEqual(manifest.files);
    expect(emitted).toEqual([{ type: "release.switched", manifest: moved, tuple: next }]);
    expect(actor.getSnapshot().context).toMatchObject({ request: undefined, moved: undefined, error: "" });
    actor.stop();
  });

  it("should switch the same pair to the effect flavor and back, setting and dropping guestFlavor", async () => {
    const { actor, apply } = start();
    const manifest = moveManifestToPair(projectManifest(), next);

    actor.send({ type: "release.switch", manifest, tuple: next, guestFlavor: "slim" });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "release.switch", manifest, tuple: next, guestFlavor: "effect" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    const [effectManifest] = apply.mock.calls[0];

    expect(effectManifest.guestFlavor).toBe("effect");

    actor.send({ type: "release.switch", manifest: effectManifest, tuple: next, guestFlavor: "slim" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle") && apply.mock.calls.length === 2);

    expect(apply.mock.calls[1][0]).not.toHaveProperty("guestFlavor");
    actor.stop();
  });

  it("should ignore a switch to the current pair, to another database's pair, and while locked", () => {
    const { actor, apply } = start();
    const manifest = projectManifest();

    actor.send({ type: "release.switch", manifest, tuple: legacy });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "release.switch", manifest, tuple: sqliteNext });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "release.lock" });
    actor.send({ type: "release.switch", manifest, tuple: next });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "release.unlock" });
    actor.send({ type: "release.switch", manifest, tuple: next });
    expect(actor.getSnapshot().value).toBe("moving");
    expect(apply).not.toHaveBeenCalled();
    actor.stop();
  });

  it("should start locked inside a guide", () => {
    const { actor } = start({}, true);

    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    expect(actor.getSnapshot().value).toBe("idle");
    actor.stop();
  });

  it("should ignore Retry and Dismiss outside failed, and a second switch while busy", async () => {
    const { actor, apply } = start();

    actor.send({ type: "release.retry" });
    actor.send({ type: "release.dismiss" });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(apply).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("should fail when the pair cannot take the manifest, then retry or dismiss", async () => {
    let attempts = 0;
    const move = vi.fn(({ manifest }: { manifest: RunManifest }) => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("drizzle-zod is not available with this pair.");
      }

      return moveManifestToPair(manifest, next);
    });
    const { actor, apply, emitted } = start({ move });

    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));

    expect(actor.getSnapshot().context.error).toBe("drizzle-zod is not available with this pair.");
    expect(emitted).toEqual([{ type: "release.switch.failed", error: "drizzle-zod is not available with this pair." }]);

    actor.send({ type: "release.retry" });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    expect(apply).toHaveBeenCalledOnce();

    move.mockImplementationOnce(() => {
      throw new Error("again");
    });
    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));
    actor.send({ type: "release.dismiss" });
    expect(actor.getSnapshot()).toMatchObject({ value: "idle", context: { error: "", request: undefined } });
    actor.stop();
  });

  it("should ignore Retry once a guide locked the pair after a failed switch", async () => {
    const move = vi.fn(() => {
      throw new Error("drizzle-zod is not available with this pair.");
    });
    const { actor } = start({ move });

    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));
    actor.send({ type: "release.lock" });
    actor.send({ type: "release.retry" });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(move).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("should fail when the host cannot apply, and switch again from failed", async () => {
    const apply = vi.fn<ReleaseSwitchServices["apply"]>(async () => {
      throw new Error("storage full");
    });
    const { actor } = start({ apply });

    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    await waitFor(actor, (snapshot) => snapshot.matches("failed"));
    expect(actor.getSnapshot().context.error).toBe("storage full");

    apply.mockResolvedValueOnce(undefined);
    actor.send({ type: "release.switch", manifest: projectManifest(), tuple: next });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));
    expect(apply).toHaveBeenCalledTimes(2);
    actor.stop();
  });
});
