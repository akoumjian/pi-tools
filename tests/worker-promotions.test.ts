import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRepositoryChangeSet,
  type PreparedWorkerFoldManifest,
  type RepositoryChangeSetEntry,
  type ResolvedRepositoryCandidate
} from "../extensions/worker/folds.js";
import {
  promotePreparedWorkerFold,
  readWorkerFoldPromotion,
  type PromotionTestHooks,
  type WorkerFoldPromotionRequest
} from "../extensions/worker/promotions.js";
import { repositoryCandidateId } from "../extensions/worker/repositories.js";

const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-worker-promotions-")));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitPath, args, {
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

type Fixture = { resolved: ResolvedRepositoryCandidate; selection: RepositoryChangeSetEntry; target: string; candidateRepo: string };
type FixtureOptions = { setupBase?(target: string): Promise<void>; setupCandidate?(candidateRepo: string): Promise<void> };

async function fixture(root: string, suffix: string, options: FixtureOptions = {}): Promise<Fixture> {
  const target = path.join(root, "targets", `target-${suffix}`);
  const workspace = path.join(root, `workspace-${suffix}`);
  const candidateRepo = path.join(workspace, "repos", `candidate-${suffix}`);
  await mkdir(target, { recursive: true });
  await mkdir(path.dirname(candidateRepo), { recursive: true });
  git(target, "init", "--initial-branch=main");
  await writeFile(path.join(target, "base.txt"), "base\n");
  await options.setupBase?.(target);
  git(target, "add", "-A");
  const baseCommit = commit(target, "base");
  const baseTree = git(target, "rev-parse", "HEAD^{tree}");
  git(root, "clone", "--no-hardlinks", target, candidateRepo);
  await writeFile(path.join(candidateRepo, `candidate-${suffix}.txt`), `candidate ${suffix}\n`);
  await options.setupCandidate?.(candidateRepo);
  git(candidateRepo, "add", "-A");
  const headCommit = commit(candidateRepo, `candidate ${suffix}`);
  const headTree = git(candidateRepo, "rev-parse", "HEAD^{tree}");
  await writeFile(path.join(target, `target-${suffix}.txt`), `target ${suffix}\n`);
  git(target, "add", `target-${suffix}.txt`);
  commit(target, `target ${suffix}`);

  const workerId = `worker_20260923150000_${suffix.repeat(8).slice(0, 8)}`;
  const runId = `run_20260923150000_${suffix.repeat(8).slice(0, 8)}`;
  const workspaceRepo = `repos/candidate-${suffix}`;
  const candidateId = repositoryCandidateId({ workerId, runId, workspaceRepo, baseCommit, headCommit, headTree });
  const candidate = {
    candidateId, workerId, runId, workspaceRepo, reported: true, purpose: `candidate ${suffix}`, dependsOn: [], source: target,
    baseCommit, baseTree, headCommit, headTree, dirty: false, committedChanged: true, foldable: true, policyIssues: []
  };
  const inventoryFile = path.join(root, `inventory-${suffix}.json`);
  const inventoryContent = Buffer.from(`${JSON.stringify({
    version: 2, workerId, runId, workspaceRoot: workspace, generatedAt: "2026-09-23T15:00:00.000Z",
    candidates: [candidate], reportedIssues: [], scanCoverage: { complete: true, limitations: [] }
  }, null, 2)}\n`);
  await writeFile(inventoryFile, inventoryContent, { mode: 0o400 });
  return {
    target,
    candidateRepo,
    resolved: {
      workspaceRoot: workspace,
      inventory: { inventoryFile, inventorySha256: createHash("sha256").update(inventoryContent).digest("hex"), reportedIssues: [], scanCoverage: { complete: true, limitations: [] } },
      candidate
    },
    selection: { candidateId, targetRepo: target, targetRef: "refs/heads/main", purpose: `fold ${suffix}`, method: "merge", dependsOn: [] }
  };
}

function prepare(root: string, fixtures: Fixture[]): PreparedWorkerFoldManifest {
  const result = prepareRepositoryChangeSet({
    changeSet: { repositories: fixtures.map((item) => item.selection) },
    candidates: fixtures.map((item) => item.resolved),
    parentSessionFile: path.join(root, "parent.jsonl"),
    foldsRoot: path.join(root, "folds"),
    targetRoot: path.join(root, "targets"),
    createdAt: "2026-09-23T15:00:00.000Z",
    gitPath
  });
  assert.equal(result.manifest.status, "ready");
  return result.manifest;
}

function requestFor(manifest: PreparedWorkerFoldManifest): WorkerFoldPromotionRequest {
  return {
    preparedId: manifest.preparedId,
    manifestSha256: manifest.manifestSha256,
    repositories: manifest.repositories.map((repository) => ({
      candidateId: repository.candidateId,
      targetRepo: repository.targetRepo,
      targetRef: repository.targetRef,
      expectedCommit: repository.targetExpectedCommit,
      desiredCommit: repository.desiredCommit!
    })).reverse()
  };
}

function promote(root: string, manifest: PreparedWorkerFoldManifest, options: { hooks?: PromotionTestHooks; gitPath?: string } = {}) {
  let tick = 0;
  return promotePreparedWorkerFold({
    request: requestFor(manifest),
    parentSessionFile: path.join(root, "parent.jsonl"),
    foldsRoot: path.join(root, "folds"),
    promotionsRoot: path.join(root, "promotions"),
    targetRoot: path.join(root, "targets"),
    now: () => new Date(Date.UTC(2026, 8, 23, 15, 0, tick++)),
    gitPath: options.gitPath ?? gitPath,
    testHooks: options.hooks
  });
}

function onlyJournal(root: string) {
  const ids = readdirSync(path.join(root, "promotions")).filter((entry) => entry.startsWith("promotion_"));
  assert.equal(ids.length, 1);
  return readWorkerFoldPromotion(path.join(root, "promotions"), ids[0]!);
}

function assertNoClaims(root: string): void {
  const lockRoot = path.join(root, "promotions", ".locks");
  if (!existsSync(lockRoot)) return;
  for (const lockDirectory of readdirSync(lockRoot)) {
    assert.equal(readdirSync(path.join(lockRoot, lockDirectory)).filter((entry) => entry.startsWith("claim-")).length, 0);
  }
}

test("checked-out targets use one ordinary ff-only merge and retry idempotently", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "a");
    const manifest = prepare(root, [item]);
    const repository = manifest.repositories[0]!;
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "completed");
    assert.equal(result.summary.completedCount, 1);
    assert.equal(git(item.target, "rev-parse", "HEAD"), repository.desiredCommit);
    assert.equal(git(item.target, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assertNoClaims(root);
  });
});

test("nonchecked targets use exact ref CAS without inspecting unrelated ignored worktree files", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "b");
    const manifest = prepare(root, [item]);
    const record = manifest.repositories[0]!;
    git(item.target, "branch", "side", record.targetExpectedCommit);
    git(item.target, "checkout", "--detach", record.targetExpectedCommit);
    const beforeHead = git(item.target, "rev-parse", "HEAD");
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "candidate-b.txt\n");
    await writeFile(path.join(item.target, "candidate-b.txt"), "unrelated ignored worktree content\n");
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "completed");
    assert.equal(result.summary.repositories[0]!.checkedOut, false);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), record.desiredCommit);
    assert.equal(git(item.target, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(item.target, "rev-parse", "refs/heads/side"), record.targetExpectedCommit);
  });
});

test("global dirty or locked preflight prevents the first repository update", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "c");
    const second = await fixture(root, "d");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    await writeFile(path.join(second.target, "dirty.txt"), "dirty\n");
    const dirty = await promote(root, manifest);
    assert.equal(dirty.summary.status, "failed");
    assert.equal(dirty.summary.completedCount, 0);
    assert.equal(git(first.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    await unlink(path.join(second.target, "dirty.txt"));
    await writeFile(path.join(second.target, ".git", "index.lock"), "lock\n");
    const locked = await promote(root, manifest);
    assert.equal(locked.summary.status, "failed");
    assert.match(locked.summary.error ?? "", /locked/);
    assert.equal(git(first.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    await unlink(path.join(second.target, ".git", "index.lock"));
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("hostile branch mergeOptions fails global preflight before mutation", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "merge-options");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    git(item.target, "config", "--local", "branch.main.mergeOptions", "--squash");
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "failed");
    assert.match(result.summary.error ?? "", /unsupported_config:branch\.main\.mergeoptions/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), expected);
    assert.equal(existsSync(path.join(item.target, "candidate-merge-options.txt")), false);
  });
});

test("ignored collisions compare Unicode-normalized case-folded paths", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "unicode", {
      async setupCandidate(candidate) { await writeFile(path.join(candidate, "CAFÉ.txt"), "desired\n"); }
    });
    const manifest = prepare(root, [item]);
    const ignoredName = "cafe\u0301.txt";
    await writeFile(path.join(item.target, ".git", "info", "exclude"), `${ignoredName}\n`);
    await writeFile(path.join(item.target, ignoredName), "ignored\n");
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "failed");
    // Case-insensitive decomposing filesystems may report this alias as dirty before the explicit collision scan.
    assert.match(result.summary.error ?? "", /Ignored worktree path collides with promotion|Promotion target repository is dirty/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
  });
});

test("sequential failure preserves earlier completion and simple expected-state retry", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "e");
    const second = await fixture(root, "f");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    const blocker = path.join(second.target, "late.txt");
    let blocked = false;
    const partial = await promote(root, manifest, {
      hooks: { beforeRepository(index) { if (index === 1 && !blocked) { blocked = true; execFileSync("sh", ["-c", `printf dirty > ${JSON.stringify(blocker)}`]); } } }
    });
    assert.equal(partial.summary.status, "failed");
    assert.equal(partial.summary.completedCount, 1);
    assert.equal(partial.summary.repositories[0]!.status, "completed");
    assert.equal(partial.summary.repositories[1]!.status, "failed");
    await unlink(blocker);
    const retry = await promote(root, manifest);
    assert.equal(retry.summary.status, "completed");
    assert.equal(retry.summary.completedCount, 2);
  });
});

test("retry accepts a pending repository already at the exact desired clean state", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "g");
    const manifest = prepare(root, [item]);
    const desired = manifest.repositories[0]!.desiredCommit!;
    let interrupted = false;
    const first = await promote(root, manifest, {
      hooks: { beforeRepository() { if (interrupted) return; interrupted = true; git(item.target, "merge", "--ff-only", desired); throw new Error("modeled command-boundary interruption"); } }
    });
    assert.equal(first.summary.status, "failed");
    assert.equal(git(item.target, "rev-parse", "HEAD"), desired);
    const retry = await promote(root, manifest);
    assert.equal(retry.summary.status, "completed");
    assert.equal(retry.summary.repositories[0]!.status, "completed");
  });
});

test("external ref drift stops retry and requires fresh preparation", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "h");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    await promote(root, manifest, { hooks: { beforeRepository() { throw new Error("stop before update"); } } });
    await writeFile(path.join(item.target, "drift.txt"), "drift\n");
    git(item.target, "add", "drift.txt");
    const drift = commit(item.target, "drift");
    const retry = await promote(root, manifest);
    assert.equal(retry.summary.status, "failed");
    assert.match(retry.summary.error ?? "", /neither the exact expected nor desired commit/);
    assert.equal(git(item.target, "rev-parse", "HEAD"), drift);
    assert.notEqual(drift, expected);
  });
});

test("promotion disables hooks and uses only merge or one exact CAS mutation", async () => {
  await withTempDir(async (root) => {
    const checked = await fixture(root, "i");
    const detached = await fixture(root, "j");
    detached.selection.dependsOn = [checked.selection.candidateId];
    const manifest = prepare(root, [checked, detached]);
    git(detached.target, "checkout", "--detach", manifest.repositories.find((repository) => repository.candidateId === detached.selection.candidateId)!.targetExpectedCommit);
    const hookSentinel = path.join(root, "hook-ran");
    const hook = path.join(checked.target, ".git", "hooks", "post-merge");
    await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(hookSentinel)}\n`, { mode: 0o700 });
    chmodSync(hook, 0o700);
    const log = path.join(root, "git.log");
    const shim = path.join(root, "git-shim");
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const rejected = await promote(root, manifest, { gitPath: shim });
    assert.equal(rejected.summary.status, "failed");
    assert.match(rejected.summary.error ?? "", /repository_hooks/);
    assert.equal(existsSync(hookSentinel), false);
    await unlink(hook);
    const result = await promote(root, manifest, { gitPath: shim });
    assert.equal(result.summary.status, "completed");
    assert.equal(existsSync(hookSentinel), false);
    const invocations = await readFile(log, "utf8");
    assert.match(invocations, / merge --ff-only --no-edit --no-stat /);
    assert.equal((invocations.match(/ update-ref --no-deref /g) ?? []).length, 1);
    assert.doesNotMatch(invocations, /\s(?:fetch|push|rebase|reset|apply|read-tree|checkout)\s/);
  });
});

test("errors are bounded and exact request binding remains strict", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "k");
    const manifest = prepare(root, [item]);
    const shim = path.join(root, "git-error");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" merge --ff-only "*) head -c 5000 /dev/zero | tr '\\000' X >&2; exit 73;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const result = await promote(root, manifest, { gitPath: shim });
    assert.equal(result.summary.status, "failed");
    assert.ok(Buffer.byteLength(result.summary.error ?? "", "utf8") <= 1000);
    assert.equal(onlyJournal(root).status, "failed");

    const unauthorized = requestFor(manifest);
    unauthorized.repositories[0] = { ...unauthorized.repositories[0]!, desiredCommit: "e".repeat(40) };
    await assert.rejects(() => promotePreparedWorkerFold({
      request: unauthorized,
      parentSessionFile: path.join(root, "parent.jsonl"),
      foldsRoot: path.join(root, "folds"),
      promotionsRoot: path.join(root, "other-promotions"),
      targetRoot: path.join(root, "targets"),
      now: () => new Date(),
      gitPath
    }), /authorization does not exactly match/);
  });
});
