import type { RunResult } from "@drizzle-run/core/contracts";
import type { GuideManifest, GuideProject } from "@drizzle-run/core/guide";

import type { GuideCheckedRun, GuideProgress, GuideRunResult, PairRunResult } from "./guide-contract.ts";
import {
  guideRunOutcome as resolveOutcome,
  isPairRunResult as isPair,
  listGuideCheckedRuns as listRuns,
  readGuideProgress as readProgress,
} from "./machines/guide.ts";

export type * from "./guide-contract.ts";

export function isPairRunResult(result: GuideRunResult): result is PairRunResult {
  return isPair(result);
}

export function listGuideCheckedRuns(result: GuideRunResult, project: GuideProject): GuideCheckedRun[] {
  return listRuns(result, project);
}

export function guideRunOutcome(result: GuideRunResult): RunResult["outcome"] {
  return resolveOutcome(result);
}

export function readGuideProgress(value: unknown, manifest: GuideManifest): GuideProgress | undefined {
  return readProgress(value, manifest);
}
