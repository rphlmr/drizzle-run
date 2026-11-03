import type { RecordedGuest, RecordedRun } from "@drizzle-run/core/contracts";
import { digestPlaygroundSnapshot, safeParseRecordedRun, toRecordedGuest } from "@drizzle-run/core/contracts";
import { resolveStep } from "@drizzle-run/core/guide";
import type { RunManifest } from "@drizzle-run/core/manifest";
import type { PairManifest } from "@drizzle-run/core/pair";
import { PAIR_SIDES, pairSide } from "@drizzle-run/core/pair";

import type { OfficialExample } from "../examples/catalog";
import { isPairManifest } from "../project/projects";

/**
 * An official example, or one step of its guide, that an embed opens with its recorded run
 *
 * Only steps that run are embeddable, so every official embed has a recording to show where it cannot run.
 */
export interface OfficialEmbed {
  example: OfficialExample;
  /** The guide step it opens; absent for the example's own files. */
  step?: {
    id: string;
    /** 0-based, as the guide counts it. */
    index: number;
  };
  /** The code it opens: one version, or both sides of a side-by-side guide. */
  manifest: RunManifest | PairManifest;
  /** Where its recording lives, relative to `apps/drizzle-run`. */
  recordingPath: string;
}

/**
 * List every official embed
 *
 * Each example, then each step of its guide that runs, in guide order. Guides without an example, such as the home
 * page's first run, are not embeddable.
 */
export function listOfficialEmbeds(examples: readonly OfficialExample[]): OfficialEmbed[] {
  const embeds: OfficialEmbed[] = [];

  for (const example of examples) {
    embeds.push({ example, manifest: example.manifest, recordingPath: `examples/${example.folder}/recording.json` });

    const { guide, guideFolder } = example;

    if (guide === undefined || guideFolder === undefined) {
      continue;
    }

    for (const [index, step] of guide.steps.entries()) {
      if (step.run === "none") {
        continue;
      }

      embeds.push({
        example,
        step: { id: step.id, index },
        manifest: resolveStep(guide, index).project,
        recordingPath: `guides/${guideFolder}/recordings/${step.id}.json`,
      });
    }
  }

  return embeds;
}

/**
 * Resolve the official embed an address names
 *
 * Returns `null` for an unknown example, an unknown step, or a step that does not run.
 */
export function resolveOfficialEmbed(
  examples: readonly OfficialExample[],
  { example, step }: { example: string; step?: string },
): OfficialEmbed | null {
  return (
    listOfficialEmbeds(examples).find((embed) => embed.example.slug === example && embed.step?.id === step) ?? null
  );
}

/**
 * Get the digest an official recording must carry
 *
 * The SHA-256 of the code alone, as a snapshot named "run", so a recording is shown only for exactly the code it ran.
 */
export function digestOfficialManifest(manifest: RunManifest | PairManifest): string {
  return digestPlaygroundSnapshot({ snapshotVersion: 1, name: "run", manifest });
}

/**
 * List the guests an official embed runs on
 *
 * One for one version, one per side in side order for side by side, each with the catalog's current lock digest.
 * Throws when the catalog ships no guest for the embed's pair and flavor, which the manifest checks rule out.
 */
export function listOfficialGuests(manifest: RunManifest | PairManifest): RecordedGuest[] {
  const runs = isPairManifest(manifest) ? PAIR_SIDES.map((side) => pairSide(manifest, side)) : [manifest];

  return runs.map((run) => {
    const guest = toRecordedGuest(run);

    if (guest === null) {
      throw new Error(
        `Expected a guest for orm ${run.dependencies["drizzle-orm"]} with kit ${run.dependencies["drizzle-kit"]}, but the catalog ships none.`,
      );
    }

    return guest;
  });
}

/** How an official recording compares with the embed it belongs to. */
export type OfficialRecordingCheck =
  | { status: "valid"; recording: RecordedRun }
  /** Not a recording, or one of another kind: one result for one version, both sides for side by side. */
  | { status: "invalid" }
  | { status: "other_code" }
  /** Recorded on a guest the catalog has since refreshed or replaced. */
  | { status: "older_guest"; guest: RecordedGuest };

/**
 * Compare a recording with the official embed it belongs to
 *
 * It is valid when it parses, was recorded for exactly the embed's code, fits its kind, and ran on the guests the
 * catalog ships for its pair and flavor now, lock digest included: a companion refresh changes no manifest, so the
 * lock digest is what flags a recording made before it.
 */
export function checkOfficialRecording(embed: OfficialEmbed, value: unknown): OfficialRecordingCheck {
  const parsed = safeParseRecordedRun(value);

  if (!parsed.success) {
    return { status: "invalid" };
  }

  if (parsed.data.snapshotDigest !== digestOfficialManifest(embed.manifest)) {
    return { status: "other_code" };
  }

  const fitsKind = isPairManifest(embed.manifest) ? parsed.data.sides !== undefined : parsed.data.result !== undefined;

  if (!fitsKind) {
    return { status: "invalid" };
  }

  const currentGuests = listOfficialGuests(embed.manifest);
  const olderGuest = parsed.data.guests.find(
    (guest, index) =>
      guest.imageId !== currentGuests[index]?.imageId || guest.lockDigest !== currentGuests[index]?.lockDigest,
  );

  return olderGuest === undefined
    ? { status: "valid", recording: parsed.data }
    : { status: "older_guest", guest: olderGuest };
}

/**
 * Check a recording against the official embed it belongs to
 *
 * Returns the recording when `checkOfficialRecording` finds it valid, and `null` otherwise.
 */
export function resolveOfficialRecording(embed: OfficialEmbed, value: unknown): RecordedRun | null {
  const checked = checkOfficialRecording(embed, value);

  return checked.status === "valid" ? checked.recording : null;
}
