import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  changedFilesForBranch,
  completeInPlaceResolution,
  findCandidateOverlaps,
  foldCandidate,
  mergeIntegrationIntoCandidate,
  orderReconcileCandidates,
  probeMerge
} from "../extensions/orchestrator/reconcile.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function createRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Orchestrator Test");
  git(repo, "config", "user.email", "orchestrator@example.invalid");
  await writeFile(path.join(repo, "a.txt"), "base a\n", "utf8");
  await writeFile(path.join(repo, "b.txt"), "base b\n", "utf8");
  await writeFile(path.join(repo, "shared.txt"), "base shared\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return repo;
}

async function createBranch(repo: string, branch: string, file: string, content: string): Promise<void> {
  git(repo, "switch", "main");
  git(repo, "switch", "-c", branch);
  await writeFile(path.join(repo, file), content, "utf8");
  git(repo, "add", file);
  git(repo, "commit", "-m", branch);
  git(repo, "switch", "main");
}

test("reconcile ordering is stable and overlap reporting is explicit", () => {
  const candidates = [
    { branch: "orch/z", changedFiles: ["a", "b"] },
    { branch: "orch/a", changedFiles: ["b"] },
    { branch: "orch/b", changedFiles: ["c"] }
  ];
  assert.deepEqual(orderReconcileCandidates(candidates).map((item) => item.branch), ["orch/a", "orch/b", "orch/z"]);
  assert.deepEqual(findCandidateOverlaps(candidates), [{ left: "orch/z", right: "orch/a", files: ["b"] }]);
});

test("merge-tree probe and fold merge a clean candidate then validate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-reconcile-clean-"));
  try {
    const repo = await createRepo(root);
    await createBranch(repo, "orch/run-a", "a.txt", "changed a\n");
    const base = git(repo, "rev-parse", "main");
    assert.deepEqual(await changedFilesForBranch(repo, base, "orch/run-a"), ["a.txt"]);
    const probe = await probeMerge(repo, "main", "orch/run-a");
    assert.equal(probe.clean, true);
    assert.match(probe.treeOid ?? "", /^[0-9a-f]{40}$/);

    git(repo, "switch", "-c", "orch/run-integration", "main");
    const result = await foldCandidate(repo, "orch/run-a", {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 5_000
    });
    assert.equal(result.status, "merged");
    assert.notEqual(result.afterCommit, result.beforeCommit);
    assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(repo, "a.txt"), "utf8")), "changed a\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicting candidate is reported without mutating integration HEAD", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-reconcile-conflict-"));
  try {
    const repo = await createRepo(root);
    await createBranch(repo, "orch/conflict-a", "shared.txt", "change a\n");
    await createBranch(repo, "orch/conflict-b", "shared.txt", "change b\n");
    git(repo, "switch", "-c", "orch/conflict-integration", "main");
    assert.equal((await foldCandidate(repo, "orch/conflict-a")).status, "merged");
    const before = git(repo, "rev-parse", "HEAD");
    const result = await foldCandidate(repo, "orch/conflict-b");
    assert.equal(result.status, "conflict");
    assert.equal(git(repo, "rev-parse", "HEAD"), before);
    assert.match(result.probe.output, /CONFLICT|Auto-merging/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve-in-place keeps writer work and completes a validated merge refactor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-reconcile-in-place-"));
  try {
    const repo = await createRepo(root);
    await createBranch(repo, "orch/owner-a", "shared.txt", "change a\n");
    await createBranch(repo, "orch/owner-b", "shared.txt", "change b\n");
    git(repo, "switch", "-c", "orch/owner-integration", "main");
    assert.equal((await foldCandidate(repo, "orch/owner-a")).status, "merged");
    git(repo, "switch", "orch/owner-b");

    const merge = await mergeIntegrationIntoCandidate(repo, "orch/owner-integration");
    assert.equal(merge.status, "conflict");
    assert.deepEqual(merge.conflictedFiles, ["shared.txt"]);
    assert.equal((await completeInPlaceResolution(repo)).status, "unresolved");

    await writeFile(path.join(repo, "shared.txt"), "combined a and b\n", "utf8");
    const completed = await completeInPlaceResolution(repo, {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 5_000
    });
    assert.equal(completed.status, "completed");
    assert.match(completed.commit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation failure rolls integration back to the prior commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-reconcile-validation-"));
  try {
    const repo = await createRepo(root);
    await createBranch(repo, "orch/invalid", "b.txt", "candidate b\n");
    git(repo, "switch", "-c", "orch/validation-integration", "main");
    const before = git(repo, "rev-parse", "HEAD");
    const result = await foldCandidate(repo, "orch/invalid", {
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      timeoutMs: 5_000
    });
    assert.equal(result.status, "validation_failed");
    assert.equal(result.validation?.code, 7);
    assert.equal(git(repo, "rev-parse", "HEAD"), before);
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", "orch/invalid", "HEAD"], { cwd: repo });
    assert.notEqual(ancestry.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
