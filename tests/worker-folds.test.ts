import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, statSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRepositoryChangeSet,
  readPreparedWorkerFold,
  type RepositoryChangeSetEntry,
  type ResolvedRepositoryCandidate
} from "../extensions/worker/folds.js";
import { repositoryCandidateId } from "../extensions/worker/repositories.js";

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

  const workerId = `worker_20260922220000_${suffix.repeat(8).slice(0, 8)}`;
  const runId = `run_20260922220000_${suffix.repeat(8).slice(0, 8)}`;
  const workspaceRepo = `repos/candidate-${suffix}`;
  const candidateId = repositoryCandidateId({ workerId, runId, workspaceRepo, baseCommit, headCommit, headTree });
  const candidate = {
    candidateId,
    workerId,
    runId,
    workspaceRepo,
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
  };
  const inventoryFile = path.join(root, `inventory-${suffix}.json`);
  const inventoryContent = Buffer.from(`${JSON.stringify({
    version: 2,
    workerId,
    runId,
    workspaceRoot: workspace,
    generatedAt: "2026-09-22T22:00:00.000Z",
    candidates: [candidate],
    reportedIssues: [],
    scanCoverage: { complete: true, limitations: [] }
  }, null, 2)}\n`);
  await writeFile(inventoryFile, inventoryContent, { mode: 0o400 });
  return {
    target,
    resolved: {
      workspaceRoot: workspace,
      inventory: {
        inventoryFile,
        inventorySha256: createHash("sha256").update(inventoryContent).digest("hex"),
        reportedIssues: [],
        scanCoverage: { complete: true, limitations: [] }
      },
      candidate
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

async function refreshInventory(resolved: ResolvedRepositoryCandidate): Promise<void> {
  const content = Buffer.from(`${JSON.stringify({
    version: 2,
    workerId: resolved.candidate.workerId,
    runId: resolved.candidate.runId,
    workspaceRoot: resolved.workspaceRoot,
    generatedAt: "2026-09-22T22:00:00.000Z",
    candidates: [resolved.candidate],
    reportedIssues: resolved.inventory.reportedIssues,
    scanCoverage: resolved.inventory.scanCoverage
  }, null, 2)}\n`);
  chmodSync(resolved.inventory.inventoryFile, 0o600);
  await writeFile(resolved.inventory.inventoryFile, content);
  chmodSync(resolved.inventory.inventoryFile, 0o400);
  resolved.inventory.inventorySha256 = createHash("sha256").update(content).digest("hex");
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
    await refreshInventory(merge.resolved);
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
    assert.equal(statSync(path.join(path.dirname(result.summary.manifestFile), mergeRecord.artifact.file)).mode & 0o222, 0);
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

test("detects immutable artifact tampering while disposable view changes do not invalidate the manifest", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "9");
    const result = prepare(root, [item.resolved], [item.selection]);
    const preparedRoot = path.dirname(result.summary.manifestFile);
    const record = result.manifest.repositories[0]!;
    const artifact = path.join(preparedRoot, record.artifact.file);
    const content = await readFile(artifact);
    chmodSync(artifact, 0o600);
    await writeFile(artifact, "poisoned");
    assert.throws(() => readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), /artifact failed immutable file or hash validation/);
    await writeFile(artifact, content);
    chmodSync(artifact, 0o400);
    const hardlink = `${artifact}.hardlink`;
    await link(artifact, hardlink);
    assert.throws(() => readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), /artifact failed immutable file or hash validation/);
    await rm(hardlink);
    const preparedInventory = path.join(preparedRoot, record.candidateInventory.inventoryFile);
    assert.equal(statSync(preparedInventory).mode & 0o222, 0);
    chmodSync(item.resolved.inventory.inventoryFile, 0o600);
    await writeFile(item.resolved.inventory.inventoryFile, "source inventory changed after preparation");
    assert.deepEqual(readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), result.manifest);

    await writeFile(path.join(preparedRoot, record.viewPath, "shared.txt"), "tampered\n");
    assert.deepEqual(readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), result.manifest);
    await rm(path.join(preparedRoot, record.viewPath), { recursive: true, force: true });
    assert.deepEqual(readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), result.manifest);
  });
});

test("pins an A-B-A candidate race to the inventory head instead of mutable HEAD", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "8");
    const candidateRepo = path.join(item.resolved.workspaceRoot, item.resolved.candidate.workspaceRepo);
    const originalHead = item.resolved.candidate.headCommit!;
    const result = prepareRepositoryChangeSet({
      changeSet: { repositories: [item.selection] },
      candidates: [item.resolved],
      parentSessionFile: path.join(root, "parent.jsonl"),
      foldsRoot: path.join(root, "folds"),
      targetRoot: path.join(root, "targets"),
      createdAt: "2026-09-22T22:00:00.000Z",
      gitPath: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
      testHooks: {
        beforeCandidateSourceBundle(repo) {
          git(repo, "checkout", "--orphan", "race-head");
          git(repo, "rm", "-rf", ".");
          execFileSync("sh", ["-c", "printf race > race.txt"], { cwd: repo });
          git(repo, "add", "race.txt");
          commit(repo, "racing head");
        },
        afterCandidateSourceBundle(repo) { git(repo, "checkout", "main"); }
      }
    });
    const record = result.manifest.repositories[0]!;
    assert.equal(record.candidateHeadCommit, originalHead);
    assert.equal(record.artifact.heads.candidate.oid, originalHead);
    assert.notEqual(git(candidateRepo, "rev-parse", "race-head"), originalHead);
    assert.deepEqual(readPreparedWorkerFold(path.join(root, "folds"), result.manifest.preparedId), result.manifest);
  });
});

test("checks policy on exact target and dirty candidate commit trees", async () => {
  await withTempDir(async (root) => {
    const targetPolicy = await fixture(root, "7");
    const cleanHead = git(targetPolicy.target, "rev-parse", "HEAD");
    git(targetPolicy.target, "checkout", "-b", "policy");
    await writeFile(path.join(targetPolicy.target, ".gitattributes"), "* text\n");
    git(targetPolicy.target, "add", ".gitattributes");
    commit(targetPolicy.target, "policy tree");
    git(targetPolicy.target, "checkout", "main");
    assert.equal(git(targetPolicy.target, "rev-parse", "HEAD"), cleanHead);
    targetPolicy.selection.targetRef = "refs/heads/policy";
    await assert.rejects(async () => prepare(root, [targetPolicy.resolved], [targetPolicy.selection]), /exact-tree policy/);

    const candidatePolicy = await fixture(root, "6");
    const repo = path.join(candidatePolicy.resolved.workspaceRoot, candidatePolicy.resolved.candidate.workspaceRepo);
    await writeFile(path.join(repo, ".gitattributes"), "* text\n");
    git(repo, "add", ".gitattributes");
    const headCommit = commit(repo, "candidate policy");
    const headTree = git(repo, "rev-parse", "HEAD^{tree}");
    await rm(path.join(repo, ".gitattributes"));
    const c = candidatePolicy.resolved.candidate;
    c.headCommit = headCommit;
    c.headTree = headTree;
    c.dirty = true;
    c.candidateId = repositoryCandidateId({ workerId: c.workerId, runId: c.runId, workspaceRepo: c.workspaceRepo, baseCommit: c.baseCommit!, headCommit, headTree });
    candidatePolicy.selection.candidateId = c.candidateId;
    await assert.rejects(async () => prepare(root, [candidatePolicy.resolved], [candidatePolicy.selection]), /candidate policy changed/);
  });
});


test("fails closed when the prepared view cannot supply exact policy evidence", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "5");
    await assert.rejects(async () => prepareRepositoryChangeSet({
      changeSet: { repositories: [item.selection] },
      candidates: [item.resolved],
      parentSessionFile: path.join(root, "parent.jsonl"),
      foldsRoot: path.join(root, "folds"),
      targetRoot: path.join(root, "targets"),
      createdAt: "2026-09-22T22:00:00.000Z",
      gitPath: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
      testHooks: {
        afterTargetReset(view) { renameSync(path.join(view, ".git", "objects"), path.join(view, ".git", "objects-unreadable")); }
      }
    }), /Prepared target .* view failed policy/);
  });
});

test("restart verification rejects a hash-updated artifact with mismatched advertised heads", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "4");
    const result = prepare(root, [item.resolved], [item.selection]);
    const oldRoot = path.dirname(result.summary.manifestFile);
    const record = result.manifest.repositories[0]!;
    const view = path.join(oldRoot, record.viewPath);
    git(view, "update-ref", "refs/worker-fold/candidate", record.targetExpectedCommit);
    const replacement = path.join(oldRoot, `${record.artifact.file}.replacement`);
    git(view, "bundle", "create", replacement, "refs/worker-fold/target", "refs/worker-fold/candidate", "refs/worker-fold/desired");
    const artifact = path.join(oldRoot, record.artifact.file);
    chmodSync(artifact, 0o600);
    renameSync(replacement, artifact);
    chmodSync(artifact, 0o400);

    const manifest = JSON.parse(await readFile(result.summary.manifestFile, "utf8")) as Record<string, any>;
    manifest.repositories[0].artifact.sha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
    delete manifest.preparedId;
    delete manifest.manifestSha256;
    const manifestSha256 = createHash("sha256").update(Buffer.from(JSON.stringify(manifest))).digest("hex");
    const preparedId = `prepared_${manifestSha256.slice(0, 24)}`;
    manifest.preparedId = preparedId;
    manifest.manifestSha256 = manifestSha256;
    chmodSync(result.summary.manifestFile, 0o600);
    await writeFile(result.summary.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(result.summary.manifestFile, 0o400);
    const newRoot = path.join(path.dirname(oldRoot), preparedId);
    renameSync(oldRoot, newRoot);
    assert.throws(() => readPreparedWorkerFold(path.join(root, "folds"), preparedId), /advertised heads do not match/);
  });
});


test("rejects two candidate mappings to one physical target identity", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "3");
    const secondWorker = "worker_20260922220000_duplicate";
    const secondRun = "run_20260922220000_duplicate";
    const c = first.resolved.candidate;
    const secondId = repositoryCandidateId({ workerId: secondWorker, runId: secondRun, workspaceRepo: c.workspaceRepo, baseCommit: c.baseCommit!, headCommit: c.headCommit!, headTree: c.headTree! });
    const second: ResolvedRepositoryCandidate = {
      workspaceRoot: first.resolved.workspaceRoot,
      inventory: first.resolved.inventory,
      candidate: { ...c, candidateId: secondId, workerId: secondWorker, runId: secondRun }
    };
    await assert.rejects(async () => prepare(root, [first.resolved, second], [
      first.selection,
      { ...first.selection, candidateId: secondId, purpose: "duplicate physical target" }
    ]), /one candidate per physical target/);
  });
});
