import { createRecordedRun, digestPlaygroundSnapshot, type RecordedRun } from "@drizzle-run/core/contracts";
import {
  type ActorOutcome,
  createActorSettler,
  getMachinePaths,
  getSettleEvents,
  type ModelEvent,
  replayMachinePath,
  toTransitionTable,
} from "@drizzle-run/machine-paths";
import { fakeRunResult, legacyGuest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createActor, type InputFrom, type SnapshotFrom } from "xstate";

import { createRecordedRunsService } from "../embed/recorded-runs-service";
import { createProject } from "../project/projects";
import { VolatileProjectStorage, type ShareLinkRecord } from "../store/storage";
import { createPlaygroundsService } from "./playgrounds-service";
import { sharePublishMachine, type PublishOutcome, type ShareStartView } from "./publish-machine";

const linkId = "123e4567-e89b-42d3-a456-426614174000";
const project = createProject("Captured", { dialect: "sqlite" });
const frozen = { snapshotVersion: 1 as const, name: project.name, manifest: project.manifest };
const existing: ShareLinkRecord = {
  linkId,
  publishedAt: "2026-10-10T00:00:00.000Z",
};
const existingListed: ShareLinkRecord = { ...existing, listing: { topic: "playground" } };

function makeRecording(): RecordedRun {
  const created = createRecordedRun({
    result: fakeRunResult("succeeded", { target: { dialect: "sqlite" }, displays: [{ label: "Users", values: [] }] }),
    guests: [legacyGuest()],
    snapshotDigest: digestPlaygroundSnapshot(frozen),
    recordedAt: "2026-10-11T00:00:00.000Z",
  });

  if (created.status !== "recorded") {
    throw new Error(`Expected a recording, but got '${created.status}'`);
  }

  return created.recording;
}

function makeOutcome(record: ShareLinkRecord): PublishOutcome {
  return {
    link: {
      id: linkId,
      digest: digestPlaygroundSnapshot(frozen),
      updatedAt: "2026-10-11T00:00:00.000Z",
      url: `/s/${linkId}`,
      embedUrl: `/embed/${linkId}`,
    },
    record,
    linkSaved: true,
  };
}

const publishedUnlisted = makeOutcome(existing);
const publishedListed = makeOutcome(existingListed);
const recordRunOutcome: ActorOutcome<void> = { outputs: [undefined], error: new Error("The recording was refused.") };
const outcomes = {
  findLink: { outputs: [undefined, existing, existingListed] },
  publish: { outputs: [publishedUnlisted, publishedListed], error: new Error("The Worker is unavailable.") },
  recordRun: recordRunOutcome,
} satisfies Record<string, ActorOutcome<unknown>>;

const giveConsent = { type: "consent.change", consent: true } as const;
const changeDescription = { type: "description.change", description: "Bank transfers" } as const;
const changeLink = { type: "link.change", record: existingListed } as const;
const eventLabels = new Map<unknown, string>([
  [giveConsent, "consent.change on"],
  [changeLink, "link.change to a listed link"],
]);
const outputLabels = new Map<unknown, string>([
  [existing, "a link"],
  [existingListed, "a listed link"],
  [publishedUnlisted, "an unlisted link"],
  [publishedListed, "a listed link"],
]);

function describeEvent(event: ModelEvent) {
  const settled = /^xstate\.done\.actor\.0\.sharePublish\.(?:published\.)?(\w+)$/.exec(event.type);

  if (settled !== null && event.output === undefined && settled[1] === "lookingUp") {
    return "done(lookingUp) without a link";
  }

  if (settled !== null && outputLabels.has(event.output)) {
    return `done(${settled[1]}) with ${outputLabels.get(event.output)}`;
  }

  return eventLabels.get(event);
}

type SharePublishSnapshot = SnapshotFrom<typeof sharePublishMachine>;

function toModelState(snapshot: SharePublishSnapshot) {
  const { existing: link, consent, result } = snapshot.context;

  if (snapshot.matches("published")) {
    return { value: snapshot.value };
  }

  return {
    value: snapshot.value,
    link: link === undefined ? "none" : link.listing === undefined ? "unlisted" : "listed",
    consent,
    ...(result === undefined ? {} : { resultListed: result.record.listing !== undefined }),
  };
}

function makeInput({
  snapshot = frozen,
  recording = true,
  startView = "link",
}: {
  snapshot?: typeof frozen;
  recording?: boolean;
  startView?: ShareStartView;
} = {}) {
  const dependencies = { fetch: vi.fn(), origin: "https://run.example.test" };

  return {
    services: {
      playgrounds: createPlaygroundsService(dependencies),
      recordedRuns: createRecordedRunsService(dependencies),
    },
    recording: recording ? makeRecording() : undefined,
    snapshot,
    idempotencyKey: "8e03978e-40d5-43e8-bc93-6894a57f9324",
    error: "",
    projectId: "project-1",
    links: new VolatileProjectStorage(),
    startView,
  } satisfies InputFrom<typeof sharePublishMachine>;
}

function startSharePublish(input: InputFrom<typeof sharePublishMachine>) {
  const settler = createActorSettler();
  const machine = sharePublishMachine.provide({
    actors: {
      findLink: settler.fromOutcome(outcomes.findLink),
      publish: settler.fromOutcome(outcomes.publish),
      recordRun: settler.fromOutcome(outcomes.recordRun),
    },
  });

  return { actor: createActor(machine, { input }).start(), settler };
}

const publishEvents = [{ type: "push.open" }, giveConsent, { type: "share.publish" }] as const;
const unlistedOutcomes = { ...outcomes, publish: { ...outcomes.publish, outputs: [publishedUnlisted] } };
const firstShareOutcomes = { ...unlistedOutcomes, findLink: { outputs: [undefined] } };
const walks = [
  {
    label: "preparing a push",
    input: makeInput({ recording: false }),
    events: [...publishEvents, { type: "push.cancel" }, changeDescription, changeLink],
    settleOutcomes: unlistedOutcomes,
  },
  {
    label: "opening on the push step",
    input: makeInput({ recording: false, startView: "push" }),
    events: [{ type: "push.cancel" }, ...publishEvents],
    settleOutcomes: unlistedOutcomes,
  },
  {
    label: "pushing to a listed link",
    input: makeInput({ recording: false }),
    events: publishEvents,
    settleOutcomes: outcomes,
  },
  {
    label: "uploading the recording",
    input: makeInput(),
    events: [...publishEvents, { type: "recording.retry" }],
    settleOutcomes: firstShareOutcomes,
  },
  {
    label: "without a snapshot",
    input: makeInput({ snapshot: undefined }),
    events: publishEvents,
    settleOutcomes: firstShareOutcomes,
  },
] satisfies {
  label: string;
  input: InputFrom<typeof sharePublishMachine>;
  events: readonly ModelEvent[];
  settleOutcomes: Record<string, ActorOutcome<unknown>>;
}[];

describe("share publish machine paths", () => {
  for (const { label, input, events, settleOutcomes } of walks) {
    const paths = getMachinePaths(sharePublishMachine, {
      input,
      toModelState,
      describeEvent,
      events: (snapshot) => [...events, ...getSettleEvents(snapshot, settleOutcomes)],
    });

    describe(`${label} paths`, () => {
      it("should take the same transitions", () => {
        expect(toTransitionTable(paths)).toMatchSnapshot();
      });

      for (const path of paths) {
        it(`should take ${path.description}`, async () => {
          const { actor, settler } = startSharePublish(input);

          await expect(replayMachinePath(path, { actor, settler, toModelState })).resolves.toBeUndefined();
          actor.stop();
        });
      }
    });
  }
});
