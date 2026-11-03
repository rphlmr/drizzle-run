import { createRecordedRun, type RecordedRun } from "@drizzle-run/core/contracts";
import { fakeRunResult, legacyGuest } from "@drizzle-run/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../lib/api";
import { createRecordedRunsService } from "./recorded-runs-service";

const origin = "https://run.example.test";
const linkId = "123e4567-e89b-42d3-a456-426614174000";
const snapshotDigest = "b".repeat(64);

function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeService(fetch: Fetch) {
  return createRecordedRunsService({ fetch, origin });
}

/** A succeeded run of the snapshot whose digest is `snapshotDigest`. */
function makeRecording(): RecordedRun {
  const created = createRecordedRun({
    result: fakeRunResult("succeeded", { target: { dialect: "sqlite" } }),
    guests: [legacyGuest()],
    snapshotDigest,
    recordedAt: "2026-10-11T00:00:00.000Z",
  });

  if (created.status !== "recorded") {
    throw new Error(`Expected a recording, but got '${created.status}'`);
  }

  return created.recording;
}

describe("recorded runs service", () => {
  it("should load a recording of the same snapshot, with the caller's abort signal", async () => {
    const recording = makeRecording();
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ recording }));

    await expect(makeService(fetchMock).getRecordedRun({ linkId, snapshotDigest, signal })).resolves.toEqual(recording);
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/playgrounds/${linkId}/recording`,
      expect.objectContaining({ method: "GET", signal }),
    );
  });

  it("should read a missing, unreadable or other-snapshot recording as none", async () => {
    const request = { linkId, signal: new AbortController().signal };

    await expect(
      makeService(
        vi.fn<Fetch>(async () => makeResponse({ error: { code: "recording_not_found" } }, 404)),
      ).getRecordedRun({ ...request, snapshotDigest }),
    ).resolves.toBeNull();
    await expect(
      makeService(vi.fn<Fetch>(async () => makeResponse({ recording: { kind: "nope" } }))).getRecordedRun({
        ...request,
        snapshotDigest,
      }),
    ).resolves.toBeNull();
    await expect(
      makeService(vi.fn<Fetch>(async () => makeResponse({ recording: makeRecording() }))).getRecordedRun({
        ...request,
        snapshotDigest: "c".repeat(64),
      }),
    ).resolves.toBeNull();
  });

  it("should read a recording made on a guest a companion refresh replaced as none", async () => {
    const recording = makeRecording();
    const olderGuest = { ...recording.guests[0], lockDigest: `sha256-${"0".repeat(64)}` };
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ recording: { ...recording, guests: [olderGuest] } }));

    await expect(
      makeService(fetchMock).getRecordedRun({
        linkId,
        snapshotDigest,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });

  it("should send a recording with the caller's signal, and name the Worker's refusal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ error: { code: "recording_exists" } }, 409));

    await expect(
      makeService(fetchMock).recordRun({
        linkId,
        recording: makeRecording(),
        signal,
      }),
    ).rejects.toThrow("This shared playground already has a recorded run.");
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/playgrounds/${linkId}/recording`,
      expect.objectContaining({
        method: "PUT",
        signal,
      }),
    );
  });

  it("should refuse an invalid link id before any request", async () => {
    const fetchMock = vi.fn<Fetch>();

    await expect(
      makeService(fetchMock).getRecordedRun({
        linkId: "not a link",
        snapshotDigest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Expected a playground ID, but got 'not a link'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should reject as cancelled when the request is aborted while the recording is read", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const fetchMock = vi.fn<Fetch>(async () => {
      controller.abort(aborted);

      return Object.assign(makeResponse({}), { json: () => Promise.reject(aborted) });
    });

    await expect(
      makeService(fetchMock).getRecordedRun({ linkId, snapshotDigest, signal: controller.signal }),
    ).rejects.toBe(aborted);
  });
});
