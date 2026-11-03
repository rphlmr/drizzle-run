import type { CloudProjectRemoval, CloudRemovalPolicy } from "../store/service";

/** A sign-out either completed or stopped before removal because newer edits need confirmation. */
export type CloudSignOutResult = { kind: "signed_out" } | { kind: "unsaved"; projectIds: string[] };

/** The account leaving this browser and whether its owner accepted losing unsaved edits. */
export interface CloudSignOutInput {
  githubId: number;
  policy: "require_saved" | "discard";
}

/** Storage operations needed to end a Cloud session without leaving deletion markers behind. */
export interface CloudSessionStore {
  removeCloudProjects(githubId: number | null, policy: CloudRemovalPolicy): Promise<CloudProjectRemoval>;
}

/** Serializes Cloud work across tabs, including local cleanup and server logout as one operation. */
export interface CloudSession {
  run<Result>(work: (signal: AbortSignal) => Promise<Result>, signal: AbortSignal): Promise<Result>;
  signOut(input: CloudSignOutInput, signal: AbortSignal): Promise<CloudSignOutResult>;
  expire(githubId: number | null, signal: AbortSignal): Promise<void>;
}
