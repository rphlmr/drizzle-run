import type { ExecutionResult } from "../../src/quickjs/contract.ts";
import { defaultGuestSelection } from "../../src/quickjs/selection.ts";
import type {
  DependencyTemplate,
  ExecutionAssets,
  ExecutionWorker,
  WorkerMessage,
} from "../../src/quickjs/worker-contract.ts";

function ignoreMessage() {}

export function makeExecutionAssets(): ExecutionAssets {
  return {
    bundle: "",
    wasmBytes: new Uint8Array(),
    extensionBytes: [],
    catalog: { selection: defaultGuestSelection, approved: {}, exports: {} },
  };
}

export function makeExecutionResult(): ExecutionResult {
  return { status: "success", sql: [], value: { type: "undefined" }, displays: [] };
}

export function makeTemplate(): DependencyTemplate {
  return { memory: new Uint8Array(1_024), stackPointer: 0, runtimePtr: 0, contextPtr: 0, extensions: [] };
}

export function makeExecutionWorker({
  terminate = () => {},
  send,
}: {
  terminate?: ExecutionWorker["terminate"];
  send?: (receive: (message: WorkerMessage) => void) => void;
} = {}): ExecutionWorker {
  let receive: (message: unknown) => void = ignoreMessage;

  return {
    listen(callback) {
      receive = callback;
    },
    send() {
      if (send) {
        send(receive);
      } else {
        receive({ type: "result", result: makeExecutionResult() });
      }
    },
    terminate,
  };
}
