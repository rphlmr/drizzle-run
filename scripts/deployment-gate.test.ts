import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deployment-gate.yml", import.meta.url), "utf8");
const inlineScript = workflow.split("        run: |\n")[1];
assert.ok(inlineScript, "Deployment gate must contain its inline verification script");
const gateScript = inlineScript.replace(/^          /gm, "");

function runGate({
  branch = "feature",
  mergeSha = "merge-commit",
  deployedSha = "head-commit",
  sourceRepository = "owner/repository",
  deploymentState = "success",
  lookupFails = false,
} = {}) {
  const pull = {
    number: 5,
    head: { sha: "head-commit", ref: branch, repo: { full_name: sourceRepository } },
    base: { sha: "base-commit" },
    merge_commit_sha: mergeSha,
  };
  const mockGh = `
    gh() {
      if [[ "$*" == *--slurp*--jq* ]]; then
        echo 'gh api cannot combine --slurp with --jq' >&2
        return 1
      fi
      local endpoint argument
      for argument in "$@"; do
        if [[ "$argument" == repos/* ]]; then endpoint="$argument"; fi
      done
      case "$endpoint" in
        */pulls'?'*) printf '%s' "$PULL_PAGES" ;;
        */deployments'?'*)
          if [[ "$LOOKUP_FAILS" == true ]]; then return 1; fi
          if [[ "$endpoint" == *"sha=$DEPLOYED_SHA&environment=$EXPECTED_ENVIRONMENT&"* ]]; then
            echo 123
          fi
          ;;
        */deployments/123/statuses'?'*) printf '%s' "$STATUS_PAGES" ;;
        */statuses/head-commit) printf '%s\\n' "$@" ;;
        *) echo "Unexpected GitHub API call: $endpoint" >&2; return 1 ;;
      esac
    }
  `;

  return spawnSync("bash", ["-s"], {
    input: `${mockGh}\n${gateScript}`,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_SERVER_URL: "https://github.com",
      PULL_PAGES: JSON.stringify([[], [pull]]),
      STATUS_PAGES: JSON.stringify([
        [{ state: "inactive" }],
        [{ state: deploymentState, log_url: "https://example.com/deployment" }],
      ]),
      DEPLOYED_SHA: deployedSha,
      EXPECTED_ENVIRONMENT: branch === "changeset-release/main" ? "next" : "preview",
      LOOKUP_FAILS: String(lookupFails),
    },
  });
}

void describe("deployment gate workflow", () => {
  void it("should verify the PR head deployment when the merge SHA differs", () => {
    const result = runGate();

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("state=success"), result.stdout);
    assert.ok(result.stdout.includes("target_url=https://example.com/deployment"));
  });

  void it("should verify previews without a computed merge SHA", () => {
    const result = runGate({ mergeSha: "" });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("state=success"), result.stdout);
  });

  void it("should keep a new head pending when only an older deployment exists", () => {
    const result = runGate({ deployedSha: "previous-head" });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("state=pending"), result.stdout);
  });

  void it("should verify Version Packages against the base commit in next", () => {
    const result = runGate({ branch: "changeset-release/main", deployedSha: "base-commit" });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("state=success"), result.stdout);
  });

  void it("should preserve pending and failed deployment states", () => {
    for (const deploymentState of ["queued", "failure", "error"]) {
      const result = runGate({ deploymentState });

      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`state=${deploymentState === "queued" ? "pending" : "failure"}`));
    }
  });

  void it("should skip fork PRs", () => {
    const result = runGate({ sourceRepository: "someone/fork" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  void it("should fail without posting a status when the deployment lookup fails", () => {
    const result = runGate({ lookupFails: true });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  });
});
