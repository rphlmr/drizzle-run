import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGithubRelease, getReleaseNotes } from "./github-releases.ts";

void describe("getReleaseNotes", () => {
  void it("should keep only the requested version and preserve nested headings", () => {
    const changelog =
      "# Package\r\n\r\n## 1.2.0\r\n\r\n### Minor Changes\r\n\r\n- New API\r\n\r\n## 1.1.0\r\n\r\n- Old API\r\n";

    assert.equal(getReleaseNotes(changelog, "1.2.0"), "### Minor Changes\n\n- New API");
    assert.equal(getReleaseNotes(changelog, "1.1.0"), "- Old API");
  });

  void it("should reject missing or empty version notes", () => {
    assert.throws(() => getReleaseNotes("## 1.1.0\n- Old API", "1.2.0"), /no notes/);
    assert.throws(() => getReleaseNotes("## 1.2.0\n\n## 1.1.0\n- Old API", "1.2.0"), /empty/);
  });
});

function makeReleaseOptions({ status = 404, createdStatus = 201, prerelease = false, latest = false } = {}) {
  const requests: { url: string; body?: string }[] = [];
  const options = {
    repository: "owner/repository",
    token: "test-token",
    sha: "release-commit",
    tag: "@drizzle-run/core@1.2.0",
    prerelease,
    latest,
    readNotes: async () => "### Minor Changes\n\n- New API",
    fetchRelease: async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      assert.ok(body === undefined || typeof body === "string");
      requests.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, body });

      return new Response(null, { status: init?.method === "POST" ? createdStatus : status });
    },
  };

  return { options, requests };
}

void describe("createGithubRelease", () => {
  void it("should create a package release with version notes at the exact commit", async () => {
    const { options, requests } = makeReleaseOptions();

    await createGithubRelease(options);

    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.endsWith("/tags/%40drizzle-run%2Fcore%401.2.0"));
    assert.deepEqual(JSON.parse(requests[1].body ?? ""), {
      tag_name: options.tag,
      target_commitish: options.sha,
      name: options.tag,
      body: await options.readNotes(),
      prerelease: false,
      make_latest: "false",
    });
  });

  void it("should skip an existing release without reading notes or posting", async () => {
    const { options, requests } = makeReleaseOptions({ status: 200 });
    options.readNotes = async () => {
      throw new Error("Must not read notes for an existing release");
    };

    await createGithubRelease(options);

    assert.equal(requests.length, 1);
  });

  void it("should stop on lookup failures instead of treating them as missing releases", async () => {
    for (const status of [401, 403, 500]) {
      const { options, requests } = makeReleaseOptions({ status });

      await assert.rejects(createGithubRelease(options), new RegExp(`HTTP ${status}`));
      assert.equal(requests.length, 1);
    }
  });

  void it("should propagate release creation failures", async () => {
    const { options } = makeReleaseOptions({ createdStatus: 422 });

    await assert.rejects(createGithubRelease(options), /HTTP 422/);
  });

  void it("should mark only stable app releases as latest", async () => {
    for (const prerelease of [false, true]) {
      const { options, requests } = makeReleaseOptions({ latest: true, prerelease });
      options.tag = `drizzle-run-app@1.2.0${prerelease ? "-rc.1" : ""}`;

      await createGithubRelease(options);

      const body = JSON.parse(requests[1].body ?? "");
      assert.equal(body.prerelease, prerelease);
      assert.equal(body.make_latest, prerelease ? "false" : "true");
    }
  });
});
