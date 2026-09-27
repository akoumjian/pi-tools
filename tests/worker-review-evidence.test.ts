import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_MANAGED_REVIEW_EVIDENCE_CHARS,
  MAX_MANAGED_REVIEW_STAT_CHARS,
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
    await writeFile(path.join(repository, "aaa-deleted.txt"), "deleted at candidate HEAD\n");
    await writeFile(path.join(repository, "aaa-source.txt"), "renamed without content change\n");
    await writeFile(path.join(repository, "aaa-mode.txt"), "mode change\n");
    await writeFile(path.join(repository, "aaa-type.txt"), "regular file becomes symlink\n");
    await writeFile(path.join(repository, "type-target.txt"), "symlink target\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-qm", "base");
    const baseCommit = git(repository, "rev-parse", "HEAD");
    const baseTree = git(repository, "rev-parse", "HEAD^{tree}");

    await writeFile(path.join(repository, "large.txt"), `SENSITIVE_PATCH_SENTINEL_${"x".repeat(2_000_000)}\n`);
    await writeFile(path.join(repository, "odd\nname.ts"), "UNUSUAL_PATH_PATCH_SENTINEL\n");
    await writeFile(path.join(repository, `long-${"q".repeat(220)}.txt`), "LONG_PATH_PATCH_SENTINEL\n");
    await writeFile(path.join(repository, "aaa-unicode-é.ts"), "UNICODE_PATH_PATCH_SENTINEL\n");
    await rm(path.join(repository, "aaa-deleted.txt"));
    git(repository, "mv", "aaa-source.txt", "bbb-destination.ts");
    await chmod(path.join(repository, "aaa-mode.txt"), 0o755);
    await rm(path.join(repository, "aaa-type.txt"));
    await symlink("type-target.txt", path.join(repository, "aaa-type.txt"));
    for (let index = 0; index < MAX_MANAGED_REVIEW_STAT_PATHS + 50; index += 1) {
      await writeFile(path.join(repository, `path-${String(index).padStart(3, "0")}.txt`), `PATCH_${index}\n`);
    }
    git(repository, "add", "--all");
    git(repository, "commit", "-qm", "candidate");
    const headCommit = git(repository, "rev-parse", "HEAD");
    const headTree = git(repository, "rev-parse", "HEAD^{tree}");
    // Hostile repository config must not enable external diffs, colors, raw
    // path quoting, or suppress rename detection in trusted evidence.
    git(repository, "config", "diff.external", "/definitely/not/a/real/executable");
    git(repository, "config", "color.ui", "always");
    git(repository, "config", "core.quotePath", "false");
    git(repository, "config", "diff.renames", "false");
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
    assert.match(evidence, /files changed/);
    assert.match(evidence, /Git-limited to 200 entries/);
    assert.match(evidence, /odd\\nname\.ts/);
    assert.match(evidence, /aaa-deleted\.txt.*gone/);
    assert.match(evidence, /aaa-source\.txt.*bbb-destination\.ts.*100%/);
    assert.match(evidence, /aaa-mode\.txt.*mode \+x/);
    assert.match(evidence, /aaa-type\.txt.*mode \+l/);
    assert.match(evidence, /aaa-unicode-\\303\\251\.ts/);
    assert.match(evidence, /Deleted content is absent at candidate HEAD/);
    assert.doesNotMatch(evidence, /path-249\.txt/);
    assert.doesNotMatch(evidence, new RegExp(`long-${"q".repeat(220)}\\.txt`));
    assert.doesNotMatch(evidence, /\x1b\[/);
    assert.ok((evidence.split("### Changed-path and status overview")[1] ?? "").length < MAX_MANAGED_REVIEW_STAT_CHARS);
    assert.doesNotMatch(evidence, /SENSITIVE_PATCH_SENTINEL|UNUSUAL_PATH_PATCH_SENTINEL|LONG_PATH_PATCH_SENTINEL|UNICODE_PATH_PATCH_SENTINEL|SENSITIVE_REPORTED_PURPOSE/);
    assert.doesNotMatch(evidence, /diff --git|@@ /);

    assert.throws(() => buildWorkerReviewEvidence({
      workerId: "w".repeat(MAX_MANAGED_REVIEW_EVIDENCE_CHARS),
      runId: candidate.runId,
      taskIds: ["personal-93pp8"],
      candidate,
      repository,
      trustedStateRoot: state
    }), /aggregate bound/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
