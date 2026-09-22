import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRepositoryChangeSet,
  readPreparedWorkerFold,
  type RepositoryChangeSetEntry,
  type ResolvedRepositoryCandidate
} from "../extensions/worker/folds.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const raw = await mkdtemp(path.join(tmpdir(), "pi-worker-folds-"));
  const directory = await realpath(raw);
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD^{commit}");
}

async function fixture(
  root: string,
  suffix: string,
  options: { conflict?: boolean; squash?: boolean } = {}
): Promise<{ resolved: ResolvedRepositoryCandidate; selection: RepositoryChangeSetEntry; target: string }> {
  const targets = path.join(root, "targets");
  const workspace = path.join(root, "workspace");
  const target = path.join(targets, `target-${suffix}`);
  const candidateRepo = path.join(workspace, "repos", `candidate-${suffix}`);
  await mkdir(targets, { recursive: true });
  await mkdir(path.dirname(candidateRepo), { recursive: true });
  await mkdir(target, { recursive: true });
  git(target, "init", "--initial-branch=main");
  await writeFile(path.join(target, "shared.txt"), "base\n");
  git(target, "add", "shared.txt");
  const baseCommit = commit(target, "base");
  const baseTree = git(target, "rev-parse", "HEAD^{tree}");
  git(root, "clone", "--no-hardlinks", target, candidateRepo);

  if (options.conflict) {
    await writeFile(path.join(candidateRepo, "shared.txt"), "candidate\n");
    git(candidateRepo, "add", "shared.txt");
  } else {
    await writeFile(path.join(candidateRepo, `candidate-${suffix}.txt`), `candidate ${suffix}\n`);
    git(candidateRepo, "add", `candidate-${suffix}.txt`);
  }
  const headCommit = commit(candidateRepo, `candidate ${suffix}`);
  const headTree = git(candidateRepo, "rev-parse", "HEAD^{tree}");

  if (options.conflict) {
    await writeFile(path.join(target, "shared.txt"), "target\n");
    git(target, "add", "shared.txt");
  } else {
    await writeFile(path.join(target, `target-${suffix}.txt`), `target ${suffix}\n`);
    git(target, "add", `target-${suffix}.txt`);
  }
  commit(target, `target ${suffix}`);

  const candidateId = `candidate_${suffix.repeat(24).slice(0, 24)}`;
  return {
    target,
    resolved: {
      workspaceRoot: workspace,
      candidate: {
        candidateId,
        workerId: `worker_20260922220000_${suffix.repeat(8).slice(0, 8)}`,
        runId: `run_20260922220000_${suffix.repeat(8).slice(0, 8)}`,
        workspaceRepo: `repos/candidate-${suffix}`,
        reported: true,
        purpose: `candidate ${suffix}`,
        dependsOn: [],
        source: target,
        baseCommit,
        baseTree,
        headCommit,
        headTree,
        dirty: false,
        committedChanged: true,
        foldable: true,
        policyIssues: []
      }
    },
    selection: {
      candidateId,
      targetRepo: target,
      targetRef: "refs/heads/main",
      purpose: `fold ${suffix}`,
      method: options.squash ? "squash" : "merge",
      dependsOn: []
    }
  };
}

function prepare(root: string, resolved: ResolvedRepositoryCandidate[], repositories: RepositoryChangeSetEntry[]) {
  return prepareRepositoryChangeSet({
    changeSet: { repositories },
    candidates: resolved,
    parentSessionFile: path.join(root, "parent.jsonl"),
    foldsRoot: path.join(root, "folds"),
    targetRoot: path.join(root, "targets"),
    createdAt: "2026-09-22T22:00:00.000Z",
    gitPath: execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  });
}

test("prepares exact merge and squash commits without changing authoritative targets", async () => {
  await withTempDir(async (root) => {
    const merge = await fixture(root, "a");
    const squash = await fixture(root, "b", { squash: true });
    await writeFile(path.join(merge.resolved.workspaceRoot, merge.resolved.candidate.workspaceRepo, "uncommitted.txt"), "inspection signal\n");
    merge.resolved.candidate.dirty = true;
    await writeFile(path.join(squash.target, ".gitignore"), "node_modules/\n");
    git(squash.target, "add", ".gitignore");
    commit(squash.target, "ignore build dependencies");
    await mkdir(path.join(squash.target, "node_modules"), { recursive: true });
    await writeFile(path.join(squash.target, "node_modules", "ignored.txt"), "ignored\n");
    squash.selection.dependsOn = [merge.selection.candidateId];
    const snapshots = [merge, squash].map((item) => ({
      ref: git(item.target, "rev-parse", "refs/heads/main"),
      status: git(item.target, "status", "--porcelain=v1", "--untracked-files=all"),
      shared: readFileSync(path.join(item.target, "shared.txt"), "utf8")
    }));

    const result = prepare(root, [merge.resolved, squash.resolved], [squash.selection, merge.selection]);
    assert.equal(result.manifest.status, "ready");
    assert.deepEqual(result.manifest.order, [merge.selection.candidateId, squash.selection.candidateId]);
    assert.equal(result.summary.repositoryCount, 2);
    assert.equal(statSync(result.summary.manifestFile).mode & 0o222, 0);
    const mergeRecord = result.manifest.repositories.find((item) => item.candidateId === merge.selection.candidateId)!;
    const squashRecord = result.manifest.repositories.find((item) => item.candidateId === squash.selection.candidateId)!;
    assert.equal(statSync(path.join(path.dirname(result.summary.manifestFile), mergeRecord.bundleFile)).mode & 0o222, 0);
    assert.equal(git(path.join(path.dirname(result.summary.manifestFile), mergeRecord.viewPath), "rev-list", "--parents", "-n", "1", mergeRecord.desiredCommit!).split(/\s+/).length, 3);
    assert.equal(git(path.join(path.dirname(result.summary.manifestFile), squashRecord.viewPath), "rev-list", "--parents", "-n", "1", squashRecord.desiredCommit!).split(/\s+/).length, 2);
    assert.equal(await readFile(path.join(path.dirname(result.summary.manifestFile), mergeRecord.viewPath, "candidate-a.txt"), "utf8"), "candidate a\n");
    assert.equal(await readFile(path.join(path.dirname(result.summary.manifestFile), mergeRecord.viewPath, "target-a.txt"), "utf8"), "target a\n");
    await assert.rejects(readFile(path.join(path.dirname(result.summary.manifestFile), mergeRecord.viewPath, "uncommitted.txt"), "utf8"), /ENOENT/);
    assert.equal(mergeRecord.candidateDirty, true);

    for (const [index, item] of [merge, squash].entries()) {
      assert.equal(git(item.target, "rev-parse", "refs/heads/main"), snapshots[index]!.ref);
      assert.equal(git(item.target, "status", "--porcelain=v1", "--untracked-files=all"), snapshots[index]!.status);
      assert.equal(readFileSync(path.join(item.target, "shared.txt"), "utf8"), snapshots[index]!.shared);
    }

    const reloaded = readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId, path.join(root, "parent.jsonl"));
    assert.deepEqual(reloaded, result.manifest);
  });
});

test("persists conflicts as bounded resolution cases without a desired commit", async () => {
  await withTempDir(async (root) => {
    const conflict = await fixture(root, "c", { conflict: true });
    const targetBefore = git(conflict.target, "rev-parse", "refs/heads/main");
    const result = prepare(root, [conflict.resolved], [conflict.selection]);
    assert.equal(result.manifest.status, "resolution_required");
    assert.equal(result.manifest.resolutionCases.length, 1);
    assert.equal(result.summary.overlapCount, 1);
    assert.deepEqual(result.manifest.overlaps, [{ targetRepo: conflict.target, candidateIds: [conflict.selection.candidateId], pathCount: 1 }]);
    assert.equal(result.manifest.repositories[0]?.status, "resolution_required");
    assert.equal(result.manifest.repositories[0]?.desiredCommit, undefined);
    assert.equal(git(conflict.target, "rev-parse", "refs/heads/main"), targetBefore);
    assert.equal(await readFile(path.join(conflict.target, "shared.txt"), "utf8"), "target\n");
  });
});

test("fails closed for stale candidates, dirty targets, unsupported policy, and dependency cycles", async () => {
  await withTempDir(async (root) => {
    const stale = await fixture(root, "d");
    await writeFile(path.join(path.dirname(stale.resolved.workspaceRoot), "unused"), "x");
    await writeFile(path.join(stale.resolved.workspaceRoot, stale.resolved.candidate.workspaceRepo, "late.txt"), "late\n");
    git(path.join(stale.resolved.workspaceRoot, stale.resolved.candidate.workspaceRepo), "add", "late.txt");
    commit(path.join(stale.resolved.workspaceRoot, stale.resolved.candidate.workspaceRepo), "late");
    await assert.rejects(async () => prepare(root, [stale.resolved], [stale.selection]), /identity moved/);

    const dirty = await fixture(root, "e");
    await writeFile(path.join(dirty.target, "dirty.txt"), "dirty\n");
    await assert.rejects(async () => prepare(root, [dirty.resolved], [dirty.selection]), /Target repository is dirty/);

    const policy = await fixture(root, "f");
    git(policy.target, "config", "core.hooksPath", "/tmp/hooks");
    await assert.rejects(async () => prepare(root, [policy.resolved], [policy.selection]), /unsupported Git policy/);

    const first = await fixture(root, "1");
    const second = await fixture(root, "2");
    first.selection.dependsOn = [second.selection.candidateId];
    second.selection.dependsOn = [first.selection.candidateId];
    await assert.rejects(async () => prepare(root, [first.resolved, second.resolved], [first.selection, second.selection]), /contains a cycle/);
  });
});

test("detects manifest and candidate bundle tampering after restart", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "9");
    const result = prepare(root, [item.resolved], [item.selection]);
    const preparedRoot = path.dirname(result.summary.manifestFile);
    const record = result.manifest.repositories[0]!;
    const bundle = path.join(preparedRoot, record.bundleFile);
    const bundleContent = await readFile(bundle);
    chmodSync(bundle, 0o600);
    await writeFile(bundle, "poisoned");
    assert.throws(() => readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), /bundle hash mismatch/);
    await writeFile(bundle, bundleContent);
    chmodSync(bundle, 0o400);
    await writeFile(path.join(preparedRoot, record.viewPath, "shared.txt"), "tampered\n");
    assert.throws(() => readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), /view identity mismatch/);
  });
});
