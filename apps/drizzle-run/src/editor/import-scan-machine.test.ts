import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { createImportScanMachine, IMPORT_SCAN_DELAY_MS, type ImportScanPorts } from "./import-scan-machine";

function startScan(options: { importKey?: () => string; load?: ImportScanPorts<string>["loadImports"] } = {}) {
  const importKey = "zod";
  const applied: string[] = [];
  const loadImports = vi.fn(options.load ?? (async () => ({ importKey, loaded: `declarations for ${importKey}` })));
  const reportFailure = vi.fn();
  const actor = createActor(
    createImportScanMachine<string>({
      readImportKey: options.importKey ?? (() => importKey),
      loadImports,
      applyImports: (loaded) => applied.push(loaded),
      reportFailure,
    }),
  ).start();

  return {
    actor,
    loadImports,
    reportFailure,
    applied,
  };
}

describe("import scan machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should load once edits pause, and skip a scan whose imports did not change", async () => {
    const { actor, loadImports, applied } = startScan();

    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS - 1);
    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);
    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);

    expect(loadImports).toHaveBeenCalledOnce();
    expect(applied).toEqual(["declarations for zod"]);
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("should scan again after a load when an edit came while it ran", async () => {
    const firstLoad = Promise.withResolvers<{ importKey: string; loaded: string }>();
    let loads = 0;
    let importKey = "zod";
    const { actor, applied } = startScan({
      importKey: () => importKey,
      load: () => {
        loads += 1;

        return loads === 1
          ? firstLoad.promise
          : Promise.resolve({ importKey, loaded: `declarations for ${importKey}` });
      },
    });

    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);
    importKey = "zod,valibot";
    actor.send({ type: "sources.edited" });
    firstLoad.resolve({ importKey: "zod", loaded: "declarations for zod" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);

    expect(applied).toEqual(["declarations for zod", "declarations for zod,valibot"]);
  });

  it("should apply nothing from a load that lands after the session closed", async () => {
    const load = Promise.withResolvers<{ importKey: string; loaded: string }>();
    const { actor, applied } = startScan({ load: () => load.promise });

    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);
    actor.send({ type: "scan.dispose" });
    load.resolve({ importKey: "zod", loaded: "declarations for zod" });
    await vi.advanceTimersByTimeAsync(0);

    expect(applied).toEqual([]);
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("should not load the imports the session opened with", async () => {
    const { actor, loadImports } = startScan();

    actor.send({ type: "imports.opened", importKey: "zod" });
    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);

    expect(loadImports).not.toHaveBeenCalled();
  });

  it("should report a failed load and try again on the next edit", async () => {
    let loads = 0;
    const { actor, reportFailure, applied } = startScan({
      load: async () => {
        loads += 1;

        if (loads === 1) {
          throw new Error("The registry is offline.");
        }

        return { importKey: "zod", loaded: "declarations for zod" };
      },
    });

    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);
    actor.send({ type: "sources.edited" });
    await vi.advanceTimersByTimeAsync(IMPORT_SCAN_DELAY_MS);

    expect(reportFailure).toHaveBeenCalledWith(new Error("The registry is offline."));
    expect(applied).toEqual(["declarations for zod"]);
  });
});
