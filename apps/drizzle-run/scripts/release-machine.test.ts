import { describe, expect, it, vi } from "vitest";

import { runRelease } from "./release-machine.ts";

type ReleaseStep = "build" | "upload" | "migrate" | "deploy" | "verify" | "prune";

/**
 * Returns release steps that record their order, with `failing` rejecting.
 */
function makeSteps({ failing }: { failing?: ReleaseStep } = {}) {
  const calls: ReleaseStep[] = [];
  const makeStep = (step: ReleaseStep) =>
    vi.fn(async () => {
      calls.push(step);

      if (step === failing) {
        throw new Error(`${step} failed`);
      }
    });

  return {
    calls,
    steps: {
      build: makeStep("build"),
      upload: makeStep("upload"),
      migrate: makeStep("migrate"),
      deploy: makeStep("deploy"),
      verify: makeStep("verify"),
      prune: makeStep("prune"),
    },
  };
}

describe("runRelease", () => {
  it("should build, upload, migrate, deploy, verify, then prune", async () => {
    const { calls, steps } = makeSteps();

    const snapshot = await runRelease(steps);

    expect(snapshot.matches("released")).toBe(true);
    expect(calls).toEqual(["build", "upload", "migrate", "deploy", "verify", "prune"]);
  });

  it("should stop before the prune when the verification fails", async () => {
    const { calls, steps } = makeSteps({ failing: "verify" });

    const snapshot = await runRelease(steps);

    expect(snapshot.matches("failed")).toBe(true);
    expect(snapshot.context.failedStep).toBe("verify");
    expect(snapshot.context.error).toEqual(new Error("verify failed"));
    expect(calls).toEqual(["build", "upload", "migrate", "deploy", "verify"]);
    expect(steps.prune).not.toHaveBeenCalled();
  });

  it.each(["build", "upload", "migrate", "deploy"] as const)(
    "should run nothing after a failed %s step",
    async (failing) => {
      const { calls, steps } = makeSteps({ failing });

      const snapshot = await runRelease(steps);

      expect(snapshot.context.failedStep).toBe(failing);
      expect(calls.at(-1)).toBe(failing);
      expect(steps.verify).not.toHaveBeenCalled();
      expect(steps.prune).not.toHaveBeenCalled();
    },
  );

  it("should not deploy when a migration fails", async () => {
    const { calls, steps } = makeSteps({ failing: "migrate" });

    const snapshot = await runRelease(steps);

    expect(snapshot.context.failedStep).toBe("migrate");
    expect(calls).toEqual(["build", "upload", "migrate"]);
    expect(steps.deploy).not.toHaveBeenCalled();
  });

  it("should report a failed prune after the deployment is verified", async () => {
    const { calls, steps } = makeSteps({ failing: "prune" });

    const snapshot = await runRelease(steps);

    expect(snapshot.context.failedStep).toBe("prune");
    expect(calls).toEqual(["build", "upload", "migrate", "deploy", "verify", "prune"]);
  });
});
