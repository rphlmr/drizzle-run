import { describe, expect, it } from "vitest";

import {
  createDeploymentRecord,
  parseDeploymentRecord,
  parsePreviewNames,
  planRuntimeAssetPrune,
} from "./runtime-asset-deployments.ts";

const engineV1 = `${"1".repeat(64)}/engines/quickjs.tar.gz`;
const engineV2 = `${"2".repeat(64)}/engines/quickjs.tar.gz`;
const engineV3 = `${"3".repeat(64)}/engines/quickjs.tar.gz`;
const engineV4 = `${"4".repeat(64)}/engines/quickjs.tar.gz`;
const guest = `${"a".repeat(64)}/guests/orm-1.0.0-rc.5__kit-1.0.0-rc.5.tar.gz`;
const sdkIndex = `${"b".repeat(64)}/sdk/dist/index.js`;

/**
 * Returns a parsed record and its bucket object, the way the prune reads them back from R2.
 */
function makeRecord({
  assetKeys,
  uploadedAt,
  storedAt = uploadedAt,
  preview,
}: {
  assetKeys: string[];
  uploadedAt: string;
  storedAt?: string;
  preview?: string;
}) {
  const { key, body } = createDeploymentRecord({
    assetKeys,
    gitCommit: "abc123",
    uploadedAt: new Date(uploadedAt),
    preview,
  });

  return {
    record: parseDeploymentRecord(key, body),
    object: { key, size: body.length, uploaded: new Date(storedAt) },
  };
}

function makeAsset(key: string, uploadedAt = "2026-10-01T00:00:00Z") {
  return { key, size: 100, uploaded: new Date(uploadedAt) };
}

/**
 * Four deployments a day apart, each bumping the engine and sharing the guest and SDK.
 */
function makeFourDeployments() {
  const deployments = [
    makeRecord({ assetKeys: [engineV1, guest, sdkIndex], uploadedAt: "2026-10-01T12:00:00Z" }),
    makeRecord({ assetKeys: [engineV2, guest, sdkIndex], uploadedAt: "2026-10-02T12:00:00Z" }),
    makeRecord({ assetKeys: [engineV3, guest, sdkIndex], uploadedAt: "2026-10-03T12:00:00Z" }),
    makeRecord({ assetKeys: [engineV4, guest, sdkIndex], uploadedAt: "2026-10-04T12:00:00Z" }),
  ];

  return {
    records: deployments.map((deployment) => deployment.record),
    objects: [
      makeAsset(engineV1),
      makeAsset(engineV2),
      makeAsset(engineV3),
      makeAsset(engineV4),
      makeAsset(guest),
      makeAsset(sdkIndex),
      ...deployments.map((deployment) => deployment.object),
    ],
  };
}

/**
 * Pull request previews in one shared bucket: pr-3 deployed twice long ago, pr-5 once since, pr-7 last.
 */
function makePreviewDeployments() {
  const deployments = [
    makeRecord({ assetKeys: [engineV1, guest, sdkIndex], uploadedAt: "2026-10-01T12:00:00Z", preview: "pr-3" }),
    makeRecord({ assetKeys: [engineV2, guest, sdkIndex], uploadedAt: "2026-10-02T12:00:00Z", preview: "pr-3" }),
    makeRecord({ assetKeys: [engineV3, guest, sdkIndex], uploadedAt: "2026-10-03T12:00:00Z", preview: "pr-5" }),
    makeRecord({ assetKeys: [engineV4, guest, sdkIndex], uploadedAt: "2026-10-04T12:00:00Z", preview: "pr-7" }),
  ];

  return {
    records: deployments.map((deployment) => deployment.record),
    objects: [
      makeAsset(engineV1),
      makeAsset(engineV2),
      makeAsset(engineV3),
      makeAsset(engineV4),
      makeAsset(guest),
      makeAsset(sdkIndex),
      ...deployments.map((deployment) => deployment.object),
    ],
  };
}

function keysOf(objects: Array<{ key: string }>) {
  return objects.map((object) => object.key).toSorted();
}

describe("planRuntimeAssetPrune", () => {
  it("should keep the newest deployments' assets and delete only the older engine", () => {
    const { objects, records } = makeFourDeployments();
    const plan = planRuntimeAssetPrune({
      objects,
      records,
      currentAssetKeys: [engineV4, guest, sdkIndex],
      keepDeployments: 3,
    });

    expect(keysOf(plan.deletableObjects)).toEqual([engineV1]);
    expect(keysOf(plan.staleRecords)).toEqual([records[0].key]);
    expect(keysOf(plan.keptRecords)).toEqual(keysOf(records.slice(1)));
    expect(plan.recordShortfall).toBe(0);
  });

  it("should keep only the current deployment's assets with a keep window of 1, the release default", () => {
    const { objects, records } = makeFourDeployments();
    const plan = planRuntimeAssetPrune({
      objects,
      records,
      currentAssetKeys: [engineV4, guest, sdkIndex],
      keepDeployments: 1,
    });

    expect(keysOf(plan.deletableObjects)).toEqual([engineV1, engineV2, engineV3].toSorted());
    expect(plan.keptRecords.map((record) => record.key)).toEqual([records[3].key]);
    expect(keysOf(plan.staleRecords)).toEqual(keysOf(records.slice(0, 3)));
    expect(plan.recordShortfall).toBe(0);
  });

  it("should keep the current inventory's gzip types artifacts", () => {
    const { objects, records } = makeFourDeployments();
    const currentTypes = `${"c".repeat(64)}/types/drizzle-orm__1.0.0-rc.5.json.gz`;
    const oldTypes = `${"d".repeat(64)}/types/drizzle-orm__1.0.0-rc.3.json.gz`;
    const plan = planRuntimeAssetPrune({
      objects: [...objects, makeAsset(currentTypes), makeAsset(oldTypes)],
      records,
      currentAssetKeys: [engineV4, guest, sdkIndex, currentTypes],
      keepDeployments: 1,
    });

    expect(keysOf(plan.deletableObjects)).toEqual([engineV1, engineV2, engineV3, oldTypes].toSorted());
  });

  it("should order records by their upload time, not by key or list order", () => {
    const { objects, records } = makeFourDeployments();
    const plan = planRuntimeAssetPrune({
      objects: objects.toReversed(),
      records: records.toReversed(),
      currentAssetKeys: [],
      keepDeployments: 1,
    });

    expect(plan.keptRecords.map((record) => record.key)).toEqual([records[3].key]);
    expect(keysOf(plan.deletableObjects)).toEqual([engineV1, engineV2, engineV3].toSorted());
  });

  it("should keep the current inventory even when no kept record names it", () => {
    const { objects, records } = makeFourDeployments();
    const plan = planRuntimeAssetPrune({ objects, records, currentAssetKeys: [engineV1], keepDeployments: 1 });

    expect(keysOf(plan.deletableObjects)).toEqual([engineV2, engineV3].toSorted());
  });

  it("should keep assets stored after the latest record, which an unfinished upload left", () => {
    const { objects, records } = makeFourDeployments();
    const unrecordedEngine = `${"5".repeat(64)}/engines/quickjs.tar.gz`;
    const plan = planRuntimeAssetPrune({
      objects: [...objects, makeAsset(unrecordedEngine, "2026-10-05T00:00:00Z")],
      records,
      currentAssetKeys: [],
      keepDeployments: 3,
    });

    expect(keysOf(plan.recentObjects)).toEqual([unrecordedEngine]);
    expect(keysOf(plan.deletableObjects)).toEqual([engineV1]);
  });

  it("should keep an asset stored in the last day, though a later record of another upload landed after it", () => {
    const { objects, records } = makeFourDeployments();
    const uploadingEngine = `${"5".repeat(64)}/engines/quickjs.tar.gz`;
    const plan = planRuntimeAssetPrune({
      objects: [...objects, makeAsset(uploadingEngine, "2026-10-04T06:00:00Z")],
      records,
      currentAssetKeys: [],
      keepDeployments: 3,
      now: new Date("2026-10-04T18:00:00Z"),
    });

    expect(keysOf(plan.recentObjects)).toEqual([uploadingEngine]);
    expect(keysOf(plan.deletableObjects)).toEqual([engineV1]);
  });

  it("should compare asset upload times with the time R2 stored the records, not their uploadedAt", () => {
    const old = makeRecord({
      assetKeys: [engineV1],
      uploadedAt: "2026-09-01T00:00:00Z",
      storedAt: "2026-10-10T00:00:00Z",
    });
    const plan = planRuntimeAssetPrune({
      objects: [makeAsset(engineV1), makeAsset(engineV2, "2026-10-09T00:00:00Z"), old.object],
      records: [old.record],
      currentAssetKeys: [],
      keepDeployments: 1,
    });

    expect(keysOf(plan.deletableObjects)).toEqual([engineV2]);
    expect(plan.recentObjects).toEqual([]);
  });

  it("should leave objects that are not runtime assets or deployment records alone", () => {
    const { objects, records } = makeFourDeployments();
    const plan = planRuntimeAssetPrune({
      objects: [...objects, makeAsset("notes/readme.txt"), makeAsset("abc/engines/quickjs.tar.gz")],
      records,
      currentAssetKeys: [],
      keepDeployments: 3,
    });

    expect(keysOf(plan.unmanagedObjects)).toEqual(["abc/engines/quickjs.tar.gz", "notes/readme.txt"]);
    expect(keysOf(plan.deletableObjects)).toEqual([engineV1]);
  });

  it("should report a shortfall while there are fewer records than the keep window", () => {
    const { objects, records } = makeFourDeployments();
    const plan = planRuntimeAssetPrune({
      objects,
      records: records.slice(2),
      currentAssetKeys: [],
      keepDeployments: 3,
    });

    expect(plan.recordShortfall).toBe(1);
    expect(plan.staleRecords).toEqual([]);
  });

  it("should treat every unreferenced asset as recent when the bucket has no record", () => {
    const plan = planRuntimeAssetPrune({
      objects: [makeAsset(engineV1), makeAsset(engineV2)],
      records: [],
      currentAssetKeys: [engineV2],
      keepDeployments: 1,
    });

    expect(plan.deletableObjects).toEqual([]);
    expect(keysOf(plan.recentObjects)).toEqual([engineV1]);
    expect(plan.recordShortfall).toBe(1);
  });

  it("should keep an open preview's newest inventory past the keep window, and prune its older ones", () => {
    const { objects, records } = makePreviewDeployments();
    const plan = planRuntimeAssetPrune({
      objects,
      records,
      currentAssetKeys: [engineV4, guest, sdkIndex],
      keepDeployments: 1,
      openPreviews: ["pr-3", "pr-7"],
    });

    expect(keysOf(plan.keptRecords)).toEqual(keysOf([records[1], records[3]]));
    expect(keysOf(plan.staleRecords)).toEqual(keysOf([records[0], records[2]]));
    expect(keysOf(plan.deletableObjects)).toEqual([engineV1, engineV3].toSorted());
  });

  it("should prune a closed preview's inventory once it falls out of the keep window", () => {
    const { objects, records } = makePreviewDeployments();
    const plan = planRuntimeAssetPrune({
      objects,
      records,
      currentAssetKeys: [engineV4, guest, sdkIndex],
      keepDeployments: 2,
      openPreviews: ["pr-7"],
    });

    expect(keysOf(plan.keptRecords)).toEqual(keysOf(records.slice(2)));
    expect(keysOf(plan.deletableObjects)).toEqual([engineV1, engineV2].toSorted());
  });

  it("should plan the same prune as before when no preview is open", () => {
    const { objects, records } = makePreviewDeployments();
    const options = { objects, records, currentAssetKeys: [engineV4, guest, sdkIndex], keepDeployments: 2 };

    expect(planRuntimeAssetPrune({ ...options, openPreviews: [] })).toEqual(planRuntimeAssetPrune(options));
  });

  it("should reject an open preview that is not a preview name", () => {
    expect(() =>
      planRuntimeAssetPrune({
        objects: [],
        records: [],
        currentAssetKeys: [],
        keepDeployments: 1,
        openPreviews: ["PR 3"],
      }),
    ).toThrow('Expected a preview name such as pr-12, but got "PR 3"');
  });

  it("should reject a keep window below 1", () => {
    expect(() => planRuntimeAssetPrune({ objects: [], records: [], currentAssetKeys: [], keepDeployments: 0 })).toThrow(
      "Expected keepDeployments to be a whole number of at least 1, but got 0",
    );
  });
});

describe("deployment records", () => {
  it("should name one inventory with the same key whatever the asset order", () => {
    const uploadedAt = new Date("2026-10-01T00:00:00Z");
    const first = createDeploymentRecord({ assetKeys: [engineV1, guest], gitCommit: "a", uploadedAt });
    const second = createDeploymentRecord({ assetKeys: [guest, engineV1, guest], gitCommit: "b", uploadedAt });
    const other = createDeploymentRecord({ assetKeys: [engineV2, guest], gitCommit: "a", uploadedAt });

    expect(first.key).toMatch(/^deployments\/[0-9a-f]{64}\.json$/);
    expect(second.key).toBe(first.key);
    expect(other.key).not.toBe(first.key);
  });

  it("should read back what it writes", () => {
    const { key, body } = createDeploymentRecord({
      assetKeys: [guest, engineV1],
      gitCommit: "abc123",
      uploadedAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(parseDeploymentRecord(key, body)).toEqual({
      key,
      gitCommit: "abc123",
      uploadedAt: new Date("2026-10-01T00:00:00Z"),
      assetKeys: [engineV1, guest],
    });
  });

  it("should give each preview on one inventory a record of its own, and read its preview back", () => {
    const uploadedAt = new Date("2026-10-01T00:00:00Z");
    const shared = createDeploymentRecord({ assetKeys: [engineV1, guest], gitCommit: "a", uploadedAt });
    const pr3 = createDeploymentRecord({ assetKeys: [engineV1, guest], gitCommit: "a", uploadedAt, preview: "pr-3" });
    const pr7 = createDeploymentRecord({ assetKeys: [engineV1, guest], gitCommit: "a", uploadedAt, preview: "pr-7" });

    expect(pr3.key).toBe(shared.key.replace(/\.json$/, ".pr-3.json"));
    expect(pr7.key).not.toBe(pr3.key);
    expect(parseDeploymentRecord(pr3.key, pr3.body)).toEqual({
      key: pr3.key,
      preview: "pr-3",
      gitCommit: "a",
      uploadedAt,
      assetKeys: [engineV1, guest],
    });
  });

  it("should reject a record it cannot trust", () => {
    expect(() => parseDeploymentRecord("deployments/x.json", "{")).toThrow(
      "Deployment record deployments/x.json is not valid JSON",
    );
    expect(() =>
      parseDeploymentRecord(
        "deployments/x.json",
        JSON.stringify({
          version: 1,
          gitCommit: "a",
          uploadedAt: "2026-10-01T00:00:00Z",
          assetKeys: ["engines/quickjs.tar.gz"],
        }),
      ),
    ).toThrow("Deployment record deployments/x.json does not match version 1");

    for (const record of [
      { version: 2, preview: "pr-3" },
      { version: 1, preview: "PR 3" },
    ]) {
      expect(() =>
        parseDeploymentRecord(
          "deployments/x.json",
          JSON.stringify({ ...record, gitCommit: "a", uploadedAt: "2026-10-01T00:00:00Z", assetKeys: [engineV1] }),
        ),
      ).toThrow("does not match version 1");
    }
  });
});

describe("parsePreviewNames", () => {
  it("should read a comma-separated list, and an empty text as no open preview", () => {
    expect(parsePreviewNames("pr-3, pr-7,")).toEqual(["pr-3", "pr-7"]);
    expect(parsePreviewNames("")).toEqual([]);
  });

  it("should reject a name that is not a preview name", () => {
    expect(() => parsePreviewNames("pr-3,../x")).toThrow('Expected a preview name such as pr-12, but got "../x"');
  });
});
