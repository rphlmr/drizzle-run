import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, type SnapshotFrom } from "xstate";

import { createImportScanMachine, IMPORT_SCAN_DELAY_MS } from "./import-scan-machine";

const SCAN_DELAY_EVENT = { type: `xstate.after.${IMPORT_SCAN_DELAY_MS}.importScan.debouncing` } as const;
const loadedZod = { importKey: "zod", loaded: "declarations for zod" };
const outcomes = {
  loadImports: { outputs: [loadedZod], error: new Error("The registry is offline.") },
} satisfies Record<string, ActorOutcome<{ importKey: string; loaded: string }>>;
const importScanMachine = createImportScanMachine<string>({
  readImportKey: () => "zod",
  loadImports: async () => loadedZod,
  applyImports: () => {},
  reportFailure: () => {},
});
const eventLabels = new Map<unknown, string>([[SCAN_DELAY_EVENT, `after ${IMPORT_SCAN_DELAY_MS} ms`]]);

function describeEvent(event: { type: string; output?: unknown }) {
  if (event.output === loadedZod) {
    return "done(loadImports) for zod";
  }

  return eventLabels.get(event);
}

function toModelState(snapshot: SnapshotFrom<typeof importScanMachine>) {
  return {
    value: snapshot.value,
    scanned: snapshot.context.scannedImportKey,
    editedWhileLoading: snapshot.context.isEditedWhileLoading,
  };
}

async function advanceTimers(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function startImportScan() {
  const settler = createActorSettler();
  const machine = importScanMachine.provide({ actors: { loadImports: settler.fromOutcome(outcomes.loadImports) } });

  return { actor: createActor(machine).start(), settler };
}

const paths = getMachinePaths(importScanMachine, {
  toModelState,
  describeEvent,
  events: (snapshot) => [
    { type: "imports.opened", importKey: "zod" },
    { type: "sources.edited" },
    { type: "scan.dispose" },
    ...(snapshot.matches("debouncing") ? [SCAN_DELAY_EVENT] : []),
    ...getSettleEvents(snapshot, outcomes),
  ],
});

describe("import scan machine paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should take the same transitions", () => {
    expect(toTransitionTable(paths)).toMatchSnapshot();
  });

  for (const path of paths) {
    it(`should take ${path.description}`, async () => {
      const { actor, settler } = startImportScan();

      await expect(
        replayMachinePath(path, {
          actor,
          settler,
          toModelState,
          advance: () => advanceTimers(IMPORT_SCAN_DELAY_MS),
          flush: () => advanceTimers(0),
        }),
      ).resolves.toBeUndefined();
      actor.stop();
    });
  }
});
