import type { ComparisonController, ComparisonOptions } from "./comparison-contract.ts";
import { createComparisonController as createController } from "./comparison.ts";

/** Coordinate two runs, preserving the host's parallel or sequential policy. */
export function createComparisonController(options: ComparisonOptions): ComparisonController {
  return createController(options);
}

export type {
  ComparisonController,
  ComparisonOptions,
  ComparisonOutcome,
  ComparisonState,
  ComparisonSubmitOptions,
  PairSideInput,
  PairSideOutcome,
  PairSideRun,
} from "./comparison-contract.ts";
