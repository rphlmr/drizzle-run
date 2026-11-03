import { describe, expect, it, vi } from "vitest";

import type { Fetch } from "../lib/api";
import { createProject } from "../project/projects";
import { createCloudService } from "./service";

const origin = "https://run.example.test";
const projectId = "123e4567-e89b-42d3-a456-426614174000";

function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeService(fetch: Fetch) {
  return createCloudService({ fetch, origin });
}

function makeSummary(revision = 1) {
  return {
    id: projectId,
    name: "Synced",
    revision,
    digest: "a".repeat(64),
    byteSize: 512,
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

describe("cloud service", () => {
  it("should load a project from the origin, with the caller's abort signal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ project: makeSummary(), record: { id: projectId } }));

    await expect(makeService(fetchMock).fetchCloudProject({ id: projectId, signal })).resolves.toEqual({
      project: makeSummary(),
      record: { id: projectId },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/cloud/projects/${projectId}`,
      expect.objectContaining({ signal }),
    );
  });

  it("should refuse a project answered for another id", async () => {
    const fetchMock = vi.fn<Fetch>(async () =>
      makeResponse({ project: { ...makeSummary(), id: "00000000-0000-4000-8000-000000000000" } }),
    );

    await expect(
      makeService(fetchMock).fetchCloudProject({ id: projectId, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("should refuse a save answer that does not say whether the copy changed", async () => {
    const fetchMock = vi.fn<Fetch>(async () => makeResponse({ project: makeSummary() }));
    const project = { ...createProject("Synced", { dialect: "sqlite" }), id: projectId };

    const saving = makeService(fetchMock).saveCloudProject({
      project,
      baseRevision: 0,
      signal: new AbortController().signal,
    });

    await expect(saving).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("should refuse a status whose project summary is invalid", async () => {
    const fetchMock = vi.fn<Fetch>(async () =>
      makeResponse({
        githubId: 583231,
        limits: { maxProjects: 1, maxProjectBytes: 1, maxTotalBytes: 1 },
        usage: { projects: 1, bytes: 1 },
        projects: [{ ...makeSummary(), revision: 0 }],
      }),
    );

    await expect(
      makeService(fetchMock).fetchCloudStatus({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("should read a conflict with the current summary, and pass the signal and keepalive on", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () =>
      makeResponse({ error: { code: "cloud_conflict", message: "Newer elsewhere.", current: makeSummary(4) } }, 409),
    );

    await expect(
      makeService(fetchMock).saveCloudProject({
        project: { ...createProject("Synced", { dialect: "sqlite" }), id: projectId },
        baseRevision: 3,
        keepalive: true,
        signal,
      }),
    ).resolves.toEqual({ kind: "conflict", current: makeSummary(4) });
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/cloud/projects/${projectId}`,
      expect.objectContaining({ method: "PUT", keepalive: true, signal }),
    );
  });

  it("should read a rate limited save with the wait the Worker asked for", async () => {
    const fetchMock = vi.fn<Fetch>(async () =>
      makeResponse({ error: { code: "cloud_rate_limited", message: "Too many.", retryAfterMs: 60_000 } }, 429),
    );

    await expect(
      makeService(fetchMock).saveCloudProject({
        project: { ...createProject("Synced", { dialect: "sqlite" }), id: projectId },
        baseRevision: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 60_000 });
  });

  it("should delete at a revision and digest with the caller's abort signal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<Fetch>(async () => new Response(null, { status: 204 }));

    const digest = "a".repeat(64);

    await expect(
      makeService(fetchMock).deleteCloudProject({ id: projectId, revision: 2, digest, signal }),
    ).resolves.toEqual({ kind: "deleted" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${origin}/api/cloud/projects/${projectId}?revision=2&digest=${digest}`,
      expect.objectContaining({ method: "DELETE", signal }),
    );
  });
});
