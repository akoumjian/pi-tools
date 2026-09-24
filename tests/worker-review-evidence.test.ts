import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_MANAGED_REVIEW_EVIDENCE_CHARS,
  MAX_MANAGED_REVIEW_STAT_PATHS,
  buildWorkerReviewEvidence
} from "../extensions/worker/review-evidence.js";
import type { RepositoryCandidate } from "../extensions/worker/repositories.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Review Evidence Test",
      GIT_AUTHOR_EMAIL: "review-evidence@example.invalid",
      GIT_COMMITTER_NAME: "Review Evidence Test",
      GIT_COMMITTER_EMAIL: "review-evidence@example.invalid"
    }
  }).trim();
}

test("managed review evidence omits patch content and bounds huge lines and many paths at Git", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-evidence-"));
  const repository = path.join(root, "repository");
  const state = path.join(root, "state");
  await mkdir(repository);
  try {
    git(repository, "init", "-q");
    await writeFile(path.join(repository, "large.txt"), "base\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-qm", "base");
    const baseCommit = git(repository, "rev-parse", "HEAD");
    const baseTree = git(repository, "rev-parse", "HEAD^{tree}");

    await writeFile(path.join(repository, "large.txt"), `SENSITIVE_PATCH_SENTINEL_${"x".repeat(2_000_000)}\n`);
    await writeFile(path.join(repository, "odd\nname.ts"), "UNUSUAL_PATH_PATCH_SENTINEL\n");
    for (let index = 0; index < MAX_MANAGED_REVIEW_STAT_PATHS + 50; index += 1) {
      await writeFile(path.join(repository, `path-${String(index).padStart(3, "0")}.txt`), `PATCH_${index}\n`);
    }
    git(repository, "add", "--all");
    git(repository, "commit", "-qm", "candidate");
    const headCommit = git(repository, "rev-parse", "HEAD");
    const headTree = git(repository, "rev-parse", "HEAD^{tree}");
    const candidate: RepositoryCandidate = {
      candidateId: "candidate-review-evidence",
      workerId: "worker_20260924161404_cf830f3a",
      runId: "run_20260924161404_3a12893e",
      workspaceRepo: "repos/project",
      reported: true,
      purpose: "SENSITIVE_REPORTED_PURPOSE",
      dependsOn: [],
      baseCommit,
      baseTree,
      headCommit,
      headTree,
      dirty: false,
      committedChanged: true,
      foldable: true,
      policyIssues: []
    };
    const evidence = buildWorkerReviewEvidence({
      workerId: candidate.workerId,
      runId: candidate.runId,
      taskIds: ["personal-93pp8"],
      candidate,
      repository,
      trustedStateRoot: state
    });

    assert.ok(evidence.length < MAX_MANAGED_REVIEW_EVIDENCE_CHARS);
    assert.match(evidence, new RegExp(`Exact base: ${baseCommit}`));
    assert.match(evidence, new RegExp(`Exact base tree: ${baseTree}`));
    assert.match(evidence, new RegExp(`Exact HEAD: ${headCommit}`));
    assert.match(evidence, new RegExp(`Exact HEAD tree: ${headTree}`));
    assert.match(evidence, /252 files changed/);
    assert.match(evidence, /Git-limited to 200 entries/);
    assert.match(evidence, /odd\\nname\.ts/);
    assert.doesNotMatch(evidence, /path-249\.txt/);
    assert.doesNotMatch(evidence, /SENSITIVE_PATCH_SENTINEL|UNUSUAL_PATH_PATCH_SENTINEL|SENSITIVE_REPORTED_PURPOSE/);
    assert.doesNotMatch(evidence, /diff --git|@@ /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
