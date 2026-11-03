import type { QuickjsRunner } from "../../src/quickjs/contract.ts";
import { createQuickjsRuntime } from "../../src/quickjs/runtime.ts";
import { makeExecutionResult } from "./runner-fixture.ts";

export function makeRuntimeDependencies(overrides: Partial<Parameters<typeof createQuickjsRuntime>[0]> = {}) {
  return {
    checkCapabilities: async () => ({ status: "available", reasons: [] }) as const,
    createRunner: async (): Promise<QuickjsRunner> => ({ run: async () => makeExecutionResult(), close() {} }),
    ...overrides,
  } satisfies Parameters<typeof createQuickjsRuntime>[0];
}
