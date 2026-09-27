import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  PromotionTestCrash,
  readWorkerFoldPromotion,
  type PromotionTestHooks,
  type WorkerFoldPromotionRequest
} from "../extensions/worker/promotions.js";
import { repositoryCandidateId } from "../extensions/worker/repositories.js";

const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const raw = await mkdtemp(path.join(tmpdir(), "pi-worker-promotions-"));
  const directory = await realpath(raw);
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
type FixtureOptions = {
  squash?: boolean;
  setupBase?(target: string): Promise<void>;
  setupCandidate?(candidateRepo: string): Promise<void>;
};

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
    selection: { candidateId, targetRepo: target, targetRef: "refs/heads/main", purpose: `fold ${suffix}`, method: options.squash ? "squash" : "merge", dependsOn: [] }
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

function promote(root: string, manifest: PreparedWorkerFoldManifest, options: { signal?: AbortSignal; hooks?: PromotionTestHooks; gitPath?: string } = {}) {
  let tick = 0;
  return promotePreparedWorkerFold({
    request: requestFor(manifest),
    parentSessionFile: path.join(root, "parent.jsonl"),
    foldsRoot: path.join(root, "folds"),
    promotionsRoot: path.join(root, "promotions"),
    targetRoot: path.join(root, "targets"),
    now: () => new Date(Date.UTC(2026, 8, 23, 15, 0, tick++)),
    gitPath: options.gitPath ?? gitPath,
    signal: options.signal,
    testHooks: options.hooks
  });
}

function onlyJournal(root: string) {
  const ids = readdirSync(path.join(root, "promotions")).filter((entry) => entry.startsWith("promotion_"));
  assert.equal(ids.length, 1);
  return readWorkerFoldPromotion(path.join(root, "promotions"), ids[0]!);
}

function onlyJournalPath(root: string): string {
  const ids = readdirSync(path.join(root, "promotions")).filter((entry) => entry.startsWith("promotion_"));
  assert.equal(ids.length, 1);
  return path.join(root, "promotions", ids[0]!, "journal.json");
}

function refs(cwd: string): string[] {
  return git(cwd, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean).sort();
}

function assertLocksReleased(root: string): void {
  const lockRoot = path.join(root, "promotions", ".locks");
  if (!existsSync(lockRoot)) return;
  for (const lockDirectory of readdirSync(lockRoot)) {
    assert.equal(readdirSync(path.join(lockRoot, lockDirectory)).filter((entry) => entry.startsWith("claim-")).length, 0);
  }
}

test("promotes exact refs, synchronizes the eligible checked-out worktree, and retries idempotently", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "a");
    const manifest = prepare(root, [item]);
    const repository = manifest.repositories[0]!;
    const beforeRemotes = git(item.target, "remote");
    const unauthorized = requestFor(manifest);
    unauthorized.repositories[0] = { ...unauthorized.repositories[0]!, desiredCommit: "e".repeat(40) };
    await assert.rejects(() => promotePreparedWorkerFold({
      request: unauthorized,
      parentSessionFile: path.join(root, "parent.jsonl"),
      foldsRoot: path.join(root, "folds"),
      promotionsRoot: path.join(root, "promotions"),
      targetRoot: path.join(root, "targets"),
      now: () => new Date("2026-09-23T15:00:00.000Z"),
      gitPath
    }), /authorization does not exactly match/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), repository.targetExpectedCommit);
    const first = await promote(root, manifest);
    assert.equal(first.summary.status, "completed");
    assert.equal(first.summary.completedCount, 1);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), repository.desiredCommit);
    assert.equal(await readFile(path.join(item.target, "candidate-a.txt"), "utf8"), "candidate a\n");
    assert.equal(git(item.target, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(git(item.target, "remote"), beforeRemotes);

    const retry = await promote(root, manifest);
    assert.equal(retry.summary.status, "completed");
    assert.equal(retry.summary.promotionId, first.summary.promotionId);
    assertLocksReleased(root);
  });
});

test("rejects moved refs and dirty worktrees before persisting promotion intent", async () => {
  await withTempDir(async (root) => {
    const moved = await fixture(root, "b");
    const movedManifest = prepare(root, [moved]);
    await writeFile(path.join(moved.target, "moved.txt"), "moved\n");
    git(moved.target, "add", "moved.txt");
    const movedCommit = commit(moved.target, "moved");
    await assert.rejects(() => promote(root, movedManifest), /Target ref moved before promotion/);
    assert.equal(git(moved.target, "rev-parse", "refs/heads/main"), movedCommit);
    assert.equal(readdirSync(path.join(root, "promotions")).filter((entry) => entry.startsWith("promotion_")).length, 0);
    assertLocksReleased(root);
  });
  await withTempDir(async (root) => {
    const dirty = await fixture(root, "c");
    const manifest = prepare(root, [dirty]);
    await writeFile(path.join(dirty.target, "dirty.txt"), "dirty\n");
    await assert.rejects(() => promote(root, manifest), /dirty before promotion/);
    assert.equal(git(dirty.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    assertLocksReleased(root);
  });
});

test("allows unrelated linked worktrees but rejects the target ref in an unauthorized linked worktree", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "d");
    const manifest = prepare(root, [item]);
    const linked = path.join(root, "linked-side");
    git(item.target, "branch", "side");
    git(item.target, "worktree", "add", linked, "side");
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assert.equal(git(linked, "status", "--porcelain=v1"), "");
  });
  await withTempDir(async (root) => {
    const item = await fixture(root, "e");
    const manifest = prepare(root, [item]);
    const linked = path.join(root, "linked-main");
    git(item.target, "checkout", "--detach");
    git(item.target, "worktree", "add", linked, "main");
    await assert.rejects(() => promote(root, manifest), /unauthorized linked worktree/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    assertLocksReleased(root);
  });
});

test("recovers forward from crashes before CAS and after CAS before worktree synchronization", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "f");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    await assert.rejects(() => promote(root, manifest, { hooks: { afterObjectsImported() { throw new PromotionTestCrash("crash before CAS"); } } }), /crash before CAS/);
    assert.equal(onlyJournal(root).repositories[0]!.status, "objects_imported");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), expected);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
  await withTempDir(async (root) => {
    const item = await fixture(root, "g");
    const manifest = prepare(root, [item]);
    const desired = manifest.repositories[0]!.desiredCommit!;
    await assert.rejects(() => promote(root, manifest, { hooks: { beforeWorktreeSync() { throw new PromotionTestCrash("crash after CAS"); } } }), /crash after CAS/);
    assert.equal(onlyJournal(root).repositories[0]!.status, "ref_updated");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), desired);
    assert.equal(existsSync(path.join(item.target, "candidate-g.txt")), false);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assert.equal(await readFile(path.join(item.target, "candidate-g.txt"), "utf8"), "candidate g\n");
  });
});

test("recovers a post-CAS worktree on retry and quarantines ambiguous ref reversal", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "h");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, { hooks: { beforeWorktreeSync() { throw new PromotionTestCrash("stop after CAS"); } } }), /stop after CAS/);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assert.equal(await readFile(path.join(item.target, "candidate-h.txt"), "utf8"), "candidate h\n");
  });
  await withTempDir(async (root) => {
    const item = await fixture(root, "i");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, { hooks: { beforeWorktreeSync() { throw new PromotionTestCrash("stop after CAS"); } } }), /stop after CAS/);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    git(item.target, "update-ref", "refs/heads/main", expected);
    const quarantined = await promote(root, manifest);
    assert.equal(quarantined.summary.status, "quarantined");
    assert.equal(quarantined.summary.repositories[0]!.status, "quarantined");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), expected);
  });
});

test("reports multi-repository partial completion and resumes only unfinished repositories", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "j");
    const second = await fixture(root, "k");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [second, first]);
    const dirtyFile = path.join(second.target, "late-dirty.txt");
    const partial = await promote(root, manifest, { hooks: { beforeRepository(index) { if (index === 1) readFileSync(path.join(first.target, "base.txt")); if (index === 1) requireWrite(dirtyFile); } } });
    assert.equal(partial.summary.status, "partial");
    assert.equal(partial.summary.completedCount, 1);
    assert.equal(git(first.target, "rev-parse", "refs/heads/main"), manifest.repositories.find((repository) => repository.candidateId === first.selection.candidateId)!.desiredCommit);
    assert.equal(git(second.target, "rev-parse", "refs/heads/main"), manifest.repositories.find((repository) => repository.candidateId === second.selection.candidateId)!.targetExpectedCommit);
    await unlink(dirtyFile);
    const completed = await promote(root, manifest);
    assert.equal(completed.summary.status, "completed");
    assert.equal(completed.summary.completedCount, 2);
    assertLocksReleased(root);
  });
});

function requireWrite(file: string): void {
  writeFileSync(file, "dirty\n");
}

test("recovers an owner-only temporary journal left in the pre-intent crash window", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "o");
    const manifest = prepare(root, [item]);
    const request = requestFor(manifest);
    const canonical = { ...request, repositories: manifest.order.map((candidateId) => request.repositories.find((repository) => repository.candidateId === candidateId)!) };
    const promotionId = `promotion_${createHash("sha256").update(Buffer.from(JSON.stringify(canonical))).digest("hex").slice(0, 24)}`;
    const promotionDirectory = path.join(root, "promotions", promotionId);
    await mkdir(promotionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(promotionDirectory, ".journal-1-aaaaaaaa.tmp"), "incomplete", { mode: 0o600 });
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "completed");
    assert.deepEqual(readdirSync(promotionDirectory), ["journal.json"]);
    assertLocksReleased(root);
  });
});

test("defers cancellation after CAS through worktree consistency and resumes the remaining repository", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "l");
    const second = await fixture(root, "m");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    const controller = new AbortController();
    await assert.rejects(() => promote(root, manifest, {
      signal: controller.signal,
      hooks: { afterRefUpdated(index) { if (index === 0) setImmediate(() => controller.abort()); } }
    }), /cancelled after 1\/2 repositories/);
    const journal = onlyJournal(root);
    assert.equal(journal.status, "partial");
    assert.equal(journal.repositories[0]!.status, "completed");
    assert.equal(journal.repositories[1]!.status, "pending");
    assert.equal(await readFile(path.join(first.target, "candidate-l.txt"), "utf8"), "candidate l\n");
    assert.equal(git(second.target, "rev-parse", "refs/heads/main"), journal.repositories[1]!.expectedCommit);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assertLocksReleased(root);
  });
});

test("honors cancellation before CAS while preserving a forward-recoverable journal", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "n");
    const manifest = prepare(root, [item]);
    const controller = new AbortController();
    await assert.rejects(() => promote(root, manifest, {
      signal: controller.signal,
      hooks: { afterObjectsImported() { setImmediate(() => controller.abort()); } }
    }), /cancelled after 0\/1 repositories/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    const journal = onlyJournal(root);
    assert.equal(journal.repositories[0]!.status, "objects_imported");
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assertLocksReleased(root);
  });
});

test("promotes a squash ref without touching a detached worktree or any other ref", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "p", { squash: true });
    const manifest = prepare(root, [item]);
    const record = manifest.repositories[0]!;
    git(item.target, "branch", "side", record.targetExpectedCommit);
    git(item.target, "checkout", "--detach", record.targetExpectedCommit);
    const beforeRefs = refs(item.target);
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "completed");
    assert.equal(result.summary.repositories[0]!.checkedOut, false);
    assert.equal(git(item.target, "rev-parse", "HEAD"), record.targetExpectedCommit);
    assert.equal(existsSync(path.join(item.target, "candidate-p.txt")), false);
    assert.deepEqual(git(item.target, "rev-list", "--parents", "-n", "1", record.desiredCommit!).split(/\s+/), [record.desiredCommit!, record.targetExpectedCommit]);
    const afterRefs = refs(item.target);
    assert.deepEqual(afterRefs.filter((line) => !line.startsWith("refs/heads/main ")), beforeRefs.filter((line) => !line.startsWith("refs/heads/main ")));
    assert.equal(afterRefs.find((line) => line.startsWith("refs/heads/main ")), `refs/heads/main ${record.desiredCommit}`);
  });
});

test("fails before CAS on ignored collisions and tracked edits without overwriting either", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "q");
    const manifest = prepare(root, [item]);
    const record = manifest.repositories[0]!;
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "candidate-q.txt\n");
    await writeFile(path.join(item.target, "candidate-q.txt"), "valuable ignored output\n");
    await assert.rejects(() => promote(root, manifest), /Ignored worktree path collides/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), record.targetExpectedCommit);
    assert.equal(await readFile(path.join(item.target, "candidate-q.txt"), "utf8"), "valuable ignored output\n");
    await unlink(path.join(item.target, "candidate-q.txt"));
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "r");
    const manifest = prepare(root, [item]);
    const record = manifest.repositories[0]!;
    const blocked = await promote(root, manifest, {
      hooks: { afterObjectsImported() { writeFileSync(path.join(item.target, "base.txt"), "concurrent tracked edit\n"); } }
    });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), record.targetExpectedCommit);
    assert.equal(await readFile(path.join(item.target, "base.txt"), "utf8"), "concurrent tracked edit\n");
    git(item.target, "checkout", "--", "base.txt");
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "ri");
    const manifest = prepare(root, [item]);
    const collision = path.join(item.target, "candidate-ri.txt");
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "candidate-ri.txt\n");
    const blocked = await promote(root, manifest, {
      hooks: { beforeWorktreeSync() { writeFileSync(collision, "late ignored output\n"); } }
    });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.repositories[0]!.status, "ref_updated");
    assert.equal(await readFile(collision, "utf8"), "late ignored output\n");
    await unlink(collision);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("revalidates HEAD and target ref around worktree synchronization races", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "s");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    git(item.target, "branch", "side", expected);
    const result = await promote(root, manifest, {
      hooks: { beforeWorktreeSync() { git(item.target, "symbolic-ref", "HEAD", "refs/heads/side"); } }
    });
    assert.equal(result.summary.status, "partial");
    assert.equal(git(item.target, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(git(item.target, "rev-parse", "refs/heads/side"), expected);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), result.summary.repositories[0]!.desiredCommit);
    assert.equal(existsSync(path.join(item.target, "candidate-s.txt")), false);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "t");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    const result = await promote(root, manifest, {
      hooks: { beforeWorktreeSync() { git(item.target, "update-ref", "refs/heads/main", expected); } }
    });
    assert.equal(result.summary.status, "partial");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), result.summary.repositories[0]!.desiredCommit);
    assert.equal(existsSync(path.join(item.target, "candidate-t.txt")), false);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("rejects symbolic target refs and in-progress rebase or bisect state", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "u");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    git(item.target, "branch", "real-main", expected);
    git(item.target, "symbolic-ref", "refs/heads/main", "refs/heads/real-main");
    await assert.rejects(() => promote(root, manifest), /target ref is symbolic/);
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "v");
    const manifest = prepare(root, [item]);
    await mkdir(path.join(item.target, ".git", "rebase-merge"));
    await assert.rejects(() => promote(root, manifest), /in-progress Git operation: rebase-merge/);
    await rm(path.join(item.target, ".git", "rebase-merge"), { recursive: true });
    await writeFile(path.join(item.target, ".git", "BISECT_LOG"), "bisect state\n");
    await assert.rejects(() => promote(root, manifest), /in-progress Git operation: BISECT_LOG/);
  });
});

test("preflights every pending target on resume before the first CAS", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "w");
    const second = await fixture(root, "x");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterJournalCreated() { throw new PromotionTestCrash("crash after intent"); } }
    }), /crash after intent/);
    await writeFile(path.join(second.target, "late-dirty.txt"), "drift\n");
    const retry = await promote(root, manifest);
    assert.equal(retry.summary.status, "partial");
    assert.equal(git(first.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    assert.equal(git(second.target, "rev-parse", "refs/heads/main"), manifest.repositories[1]!.targetExpectedCommit);
    await unlink(path.join(second.target, "late-dirty.txt"));
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("recovers exact crash windows immediately after CAS and after worktree synchronization", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "y");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterRefUpdated() { throw new PromotionTestCrash("crash after CAS before journal"); } }
    }), /crash after CAS before journal/);
    const journal = onlyJournal(root);
    assert.equal(journal.repositories[0]!.status, "objects_imported");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), journal.repositories[0]!.desiredCommit);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "z");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterWorktreeSynchronized() { throw new PromotionTestCrash("crash after worktree sync"); } }
    }), /crash after worktree sync/);
    const journal = onlyJournal(root);
    assert.equal(journal.repositories[0]!.status, "ref_updated");
    assert.equal(await readFile(path.join(item.target, "candidate-z.txt"), "utf8"), "candidate z\n");
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("quarantines physical identity drift but retries transient exact post-CAS state", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "aa");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterJournalCreated() { throw new PromotionTestCrash("stop after intent"); } }
    }), /stop after intent/);
    const oldGit = path.join(item.target, ".git-old");
    await rename(path.join(item.target, ".git"), oldGit);
    await cp(oldGit, path.join(item.target, ".git"), { recursive: true, preserveTimestamps: true });
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "partial");
    assert.equal(result.summary.repositories[0]!.status, "pending");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "ab");
    const manifest = prepare(root, [item]);
    const partial = await promote(root, manifest, {
      hooks: { beforeWorktreeSync() { throw new Error("transient sync interruption"); } }
    });
    assert.equal(partial.summary.status, "partial");
    assert.equal(partial.summary.repositories[0]!.status, "ref_updated");
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("preserves completed repository history when later movement quarantines continuation", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "ac");
    const second = await fixture(root, "ad");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    const dirty = path.join(second.target, "hold.txt");
    const partial = await promote(root, manifest, { hooks: { beforeRepository(index) { if (index === 1) writeFileSync(dirty, "hold\n"); } } });
    assert.equal(partial.summary.completedCount, 1);
    const firstRecord = partial.summary.repositories[0]!;
    git(first.target, "update-ref", firstRecord.targetRef, firstRecord.expectedCommit);
    await unlink(dirty);
    const quarantined = await promote(root, manifest);
    assert.equal(quarantined.summary.status, "quarantined");
    assert.equal(quarantined.summary.repositories[0]!.status, "completed");
    assert.match(quarantined.summary.repositories[0]!.error ?? "", /changed after durable completion/);
    assert.equal(git(second.target, "rev-parse", "refs/heads/main"), quarantined.summary.repositories[1]!.expectedCommit);
  });
});

test("rejects duplicate authorization and strictly validates journal mode, links, session, and fields", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "ae");
    const second = await fixture(root, "af");
    const manifest = prepare(root, [first, second]);
    const request = requestFor(manifest);
    request.repositories[1] = { ...request.repositories[0]! };
    await assert.rejects(() => promotePreparedWorkerFold({
      request, parentSessionFile: path.join(root, "parent.jsonl"), foldsRoot: path.join(root, "folds"), promotionsRoot: path.join(root, "promotions"), targetRoot: path.join(root, "targets"), now: () => new Date(), gitPath
    }), /candidate IDs must be unique/);
  });

  for (const kind of ["mode", "symlink", "hardlink", "session", "fields"] as const) {
    await withTempDir(async (root) => {
      const item = await fixture(root, `j${kind[0]}`);
      const manifest = prepare(root, [item]);
      await assert.rejects(() => promote(root, manifest, { hooks: { afterJournalCreated() { throw new PromotionTestCrash("journal ready"); } } }), /journal ready/);
      const journalFile = onlyJournalPath(root);
      if (kind === "mode") chmodSync(journalFile, 0o644);
      if (kind === "symlink") {
        const saved = `${journalFile}.saved`;
        await rename(journalFile, saved);
        await symlink(saved, journalFile);
      }
      if (kind === "hardlink") await link(journalFile, `${journalFile}.link`);
      if (kind === "session" || kind === "fields") {
        const value = JSON.parse(await readFile(journalFile, "utf8")) as Record<string, unknown>;
        if (kind === "session") value.parentSessionFile = path.join(root, "other-parent.jsonl");
        else value.unexpected = true;
        await writeFile(journalFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      }
      await assert.rejects(() => promote(root, manifest), kind === "session" ? /does not match this exact request\/session/ : /journal/);
    });
  }
});

test("uses durable Git mutation config, no reset, and update-ref --no-deref as the only ref mutation", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "ag");
    const manifest = prepare(root, [item]);
    const log = path.join(root, "git-argv.log");
    const shim = path.join(root, "git-shim");
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const before = refs(item.target);
    assert.equal((await promote(root, manifest, { gitPath: shim })).summary.status, "completed");
    const invocations = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    for (const command of ["bundle unbundle", "update-ref --no-deref", "read-tree -m -u --no-sparse-checkout --no-recurse-submodules"]) {
      const invocation = invocations.find((line) => line.includes(command));
      assert.ok(invocation, `logged ${command}`);
      assert.match(invocation, /-c core\.fsync=objects,reference,index -c core\.fsyncMethod=fsync/);
    }
    assert.equal(invocations.some((line) => /\breset\b/.test(line)), false);
    assert.equal(invocations.filter((line) => line.includes("update-ref --no-deref")).length, 1);
    const after = refs(item.target);
    assert.deepEqual(after.filter((line) => !line.startsWith("refs/heads/main ")), before.filter((line) => !line.startsWith("refs/heads/main ")));
  });
});

test("post-CAS guards preserve exact retry state when cancellation and ref movement race", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "ah");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    const controller = new AbortController();
    await assert.rejects(() => promote(root, manifest, {
      signal: controller.signal,
      hooks: {
        afterRefUpdated() { controller.abort(); },
        beforeWorktreeSync() { git(item.target, "update-ref", "refs/heads/main", expected); }
      }
    }), /cancelled after 0\/1 repositories/);
    const journal = onlyJournal(root);
    assert.equal(journal.status, "partial");
    assert.equal(journal.repositories[0]!.status, "ref_updated");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), journal.repositories[0]!.desiredCommit);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("keeps an objects-imported expected-ref worktree blocker retryable", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "ai");
    const manifest = prepare(root, [item]);
    const record = manifest.repositories[0]!;
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterObjectsImported() { throw new PromotionTestCrash("stop after objects"); } }
    }), /stop after objects/);
    git(item.target, "read-tree", "-m", "-u", record.targetExpectedCommit, record.desiredCommit!);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), record.targetExpectedCommit);
    const result = await promote(root, manifest);
    assert.equal(result.summary.status, "partial");
    assert.equal(result.summary.repositories[0]!.status, "objects_imported");
    assert.match(result.summary.error ?? "", /changed before CAS|not at its exact expected state/);
    assert.equal(await readFile(path.join(item.target, "candidate-ai.txt"), "utf8"), "candidate ai\n");
  });
});

test("revalidates every unmutated target immediately before each CAS", async () => {
  await withTempDir(async (root) => {
    const first = await fixture(root, "ga");
    const second = await fixture(root, "gb");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    let injected = false;
    const blocked = await promote(root, manifest, {
      hooks: {
        beforeRepositoryCas(index) {
          if (index === 0 && !injected) {
            injected = true;
            writeFileSync(path.join(second.target, "late-global-drift.txt"), "drift\n");
          }
        }
      }
    });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.completedCount, 0);
    assert.equal(git(first.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    assert.equal(git(second.target, "rev-parse", "refs/heads/main"), manifest.repositories[1]!.targetExpectedCommit);
    assert.match(blocked.summary.repositories[1]!.error ?? "", /Global pre-CAS preflight/);
    await unlink(path.join(second.target, "late-global-drift.txt"));
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const first = await fixture(root, "gc");
    const second = await fixture(root, "gd");
    second.selection.dependsOn = [first.selection.candidateId];
    const manifest = prepare(root, [first, second]);
    let injected = false;
    const blocked = await promote(root, manifest, {
      hooks: {
        afterRepositoryCompleted(index) {
          if (index === 0 && !injected) {
            injected = true;
            writeFileSync(path.join(second.target, "between-cas-drift.txt"), "drift\n");
          }
        }
      }
    });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.repositories[0]!.status, "completed");
    assert.equal(blocked.summary.repositories[1]!.status, "pending");
    assert.equal(git(second.target, "rev-parse", "refs/heads/main"), manifest.repositories[1]!.targetExpectedCommit);
    await unlink(path.join(second.target, "between-cas-drift.txt"));
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("completed journal retries preserve immutable historical completion after later drift", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "hist");
    const manifest = prepare(root, [item]);
    const completed = await promote(root, manifest);
    assert.equal(completed.summary.status, "completed");
    const journalFile = completed.summary.journalFile;
    const durableJournal = await readFile(journalFile, "utf8");
    await writeFile(path.join(item.target, "later.txt"), "later\n");
    git(item.target, "add", "later.txt");
    const laterCommit = commit(item.target, "later accepted work");
    await writeFile(path.join(item.target, "dirty-after-completion.txt"), "dirty\n");
    const staleHeadLock = path.join(item.target, ".git", "HEAD.lock");
    await writeFile(staleHeadLock, `pi-tools-worker-fold ${completed.summary.promotionId} ${completed.summary.repositories[0]!.candidateId}\n`, { mode: 0o600 });
    const retry = await promote(root, manifest);
    assert.equal(retry.summary.status, "completed");
    assert.equal(retry.summary.completedCount, 1);
    assert.equal(await readFile(journalFile, "utf8"), durableJournal);
    assert.equal(existsSync(staleHeadLock), false);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), laterCommit);
    assert.equal(await readFile(path.join(item.target, "dirty-after-completion.txt"), "utf8"), "dirty\n");
  });
});

test("objects-imported expected-ref dirtiness and transient inspection failures remain retryable", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "retry");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterObjectsImported() { throw new PromotionTestCrash("stop after import"); } }
    }), /stop after import/);
    await writeFile(path.join(item.target, "ordinary-local-edit.txt"), "local\n");
    const blocked = await promote(root, manifest);
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.repositories[0]!.status, "objects_imported");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    await unlink(path.join(item.target, "ordinary-local-edit.txt"));
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "inspect");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterJournalCreated() { throw new PromotionTestCrash("intent only"); } }
    }), /intent only/);
    const shim = path.join(root, "git-transient-policy-shim");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" config --local "*) echo 'transient policy probe' >&2; exit 71;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const blocked = await promote(root, manifest, { gitPath: shim });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.repositories[0]!.status, "pending");
    assert.match(blocked.summary.error ?? "", /retryable/);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });
});

test("exact tree transition handles binary mode symlink deletion rename and file-directory transitions", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "paths", {
      async setupBase(target) {
        await writeFile(path.join(target, "delete.txt"), "delete me\n");
        await writeFile(path.join(target, "rename.txt"), "rename me\n");
        await writeFile(path.join(target, "mode.sh"), "#!/bin/sh\necho old\n");
        chmodSync(path.join(target, "mode.sh"), 0o644);
        await writeFile(path.join(target, "shape"), "was a file\n");
        await mkdir(path.join(target, "dirshape"));
        await writeFile(path.join(target, "dirshape", "child.txt"), "was a directory\n");
        await symlink("base.txt", path.join(target, "old-link"));
      },
      async setupCandidate(candidate) {
        await unlink(path.join(candidate, "delete.txt"));
        await rename(path.join(candidate, "rename.txt"), path.join(candidate, "renamed.txt"));
        await writeFile(path.join(candidate, "mode.sh"), "#!/bin/sh\necho new\n");
        chmodSync(path.join(candidate, "mode.sh"), 0o755);
        await unlink(path.join(candidate, "shape"));
        await mkdir(path.join(candidate, "shape"));
        await writeFile(path.join(candidate, "shape", "child.bin"), Buffer.from([0, 1, 2, 255, 0, 7]));
        await rm(path.join(candidate, "dirshape"), { recursive: true });
        await writeFile(path.join(candidate, "dirshape"), "now a file\n");
        await unlink(path.join(candidate, "old-link"));
        await symlink("renamed.txt", path.join(candidate, "old-link"));
        await writeFile(path.join(candidate, "binary.dat"), Buffer.from([0, 255, 13, 10, 0, 128]));
      }
    });
    const manifest = prepare(root, [item]);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assert.equal(existsSync(path.join(item.target, "delete.txt")), false);
    assert.equal(await readFile(path.join(item.target, "renamed.txt"), "utf8"), "rename me\n");
    assert.match(git(item.target, "ls-files", "-s", "mode.sh"), /^100755 /);
    assert.deepEqual(await readFile(path.join(item.target, "shape", "child.bin")), Buffer.from([0, 1, 2, 255, 0, 7]));
    assert.equal(await readFile(path.join(item.target, "dirshape"), "utf8"), "now a file\n");
    assert.equal(await readlink(path.join(item.target, "old-link")), "renamed.txt");
    assert.deepEqual(await readFile(path.join(item.target, "binary.dat")), Buffer.from([0, 255, 13, 10, 0, 128]));
    assert.equal(git(item.target, "status", "--porcelain=v1", "--untracked-files=all"), "");
  });
});

test("exact tree transition is independent of hostile diff formatting configuration", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "config");
    const manifest = prepare(root, [item]);
    git(item.target, "config", "diff.noprefix", "true");
    git(item.target, "config", "diff.srcPrefix", "evil/");
    git(item.target, "config", "diff.dstPrefix", "worse/");
    git(item.target, "config", "diff.context", "0");
    git(item.target, "config", "color.diff", "always");
    git(item.target, "config", "diff.external", "/bin/false");
    const log = path.join(root, "hostile-config-git.log");
    const shim = path.join(root, "hostile-config-git");
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    assert.equal((await promote(root, manifest, { gitPath: shim })).summary.status, "completed");
    const invocations = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    assert.ok(invocations.some((line) => line.includes(" read-tree -m -u --no-sparse-checkout --no-recurse-submodules ")));
    assert.equal(invocations.some((line) => line.includes(" apply --index ") || line.includes(" diff --binary ")), false);
  });
});

test("ignored collision discovery collapses large directories and catches parent collisions before intent", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "scale");
    const manifest = prepare(root, [item]);
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "node_modules/\n");
    await mkdir(path.join(item.target, "node_modules", "package", "deep"), { recursive: true });
    for (let index = 0; index < 500; index += 1) await writeFile(path.join(item.target, "node_modules", "package", "deep", `file-${index}.js`), "ignored\n");
    const log = path.join(root, "ignored-list.log");
    const shim = path.join(root, "ignored-list-git");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" ls-files --others --ignored --exclude-standard "*) case " $* " in *" --directory "*) :;; *) echo 'uncollapsed ignored traversal' >&2; exit 72;; esac;; esac\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    assert.equal((await promote(root, manifest, { gitPath: shim })).summary.status, "completed");
    assert.match(await readFile(log, "utf8"), /ls-files --others --ignored --exclude-standard --directory -z/);
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "parent", {
      async setupCandidate(candidate) {
        await mkdir(path.join(candidate, "dist"));
        await writeFile(path.join(candidate, "dist", "index.js"), "desired\n");
      }
    });
    const manifest = prepare(root, [item]);
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "dist/\n");
    await mkdir(path.join(item.target, "dist"));
    await writeFile(path.join(item.target, "dist", "valuable.bin"), "valuable\n");
    await assert.rejects(() => promote(root, manifest), /Ignored worktree path collides/);
    assert.equal(await readFile(path.join(item.target, "dist", "valuable.bin"), "utf8"), "valuable\n");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
  });
});

test("post-CAS tree transition errors preserve the original cause and exact retry state", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "lock");
    const manifest = prepare(root, [item]);
    const indexLock = path.join(item.target, ".git", "index.lock");
    const blocked = await promote(root, manifest, {
      hooks: { beforeWorktreeSync() { writeFileSync(indexLock, "late external lock\n"); } }
    });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.repositories[0]!.status, "ref_updated");
    assert.match(blocked.summary.error ?? "", /index\.lock|Unable to create/);
    assert.equal(existsSync(path.join(item.target, "candidate-lock.txt")), false);
    await unlink(indexLock);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "after");
    const manifest = prepare(root, [item]);
    const shim = path.join(root, "git-read-tree-after-success");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" read-tree -m -u "*) ${JSON.stringify(gitPath)} "$@" || exit $?; echo 'sentinel after exact tree transition' >&2; exit 73;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const result = await promote(root, manifest, { gitPath: shim });
    assert.equal(result.summary.status, "completed");
    assert.equal(await readFile(path.join(item.target, "candidate-after.txt"), "utf8"), "candidate after\n");
  });
});

test("post-CAS tree transition has no tool SIGKILL deadline and errors stay schema-bounded", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "slow");
    const manifest = prepare(root, [item]);
    const shim = path.join(root, "git-slow-read-tree");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" read-tree -m -u "*) sleep 6;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    assert.equal((await promote(root, manifest, { gitPath: shim })).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "huge");
    const manifest = prepare(root, [item]);
    const shim = path.join(root, "git-huge-read-tree-error");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" read-tree -m -u "*) printf 'corrupt\\n' > ${JSON.stringify(path.join(item.target, "base.txt"))}; head -c 5000 /dev/zero | tr '\\000' X >&2; exit 74;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const result = await promote(root, manifest, { gitPath: shim });
    assert.equal(result.summary.status, "quarantined");
    assert.ok(Buffer.byteLength(result.summary.error ?? "", "utf8") <= 1000);
    assert.ok(Buffer.byteLength(result.summary.repositories[0]!.error ?? "", "utf8") <= 1000);
    assert.equal(readWorkerFoldPromotion(path.join(root, "promotions"), result.summary.promotionId).status, "quarantined");
  });
});

test("exact tree transition cannot follow pre-existing or raced ignored symlink parents outside the worktree", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "symlinkexisting", {
      async setupCandidate(candidate) {
        await mkdir(path.join(candidate, "parent"));
        await writeFile(path.join(candidate, "parent", "new.txt"), "desired\n");
      }
    });
    const manifest = prepare(root, [item]);
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "parent\n");
    const outside = path.join(root, "outside-existing");
    await mkdir(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "unchanged\n");
    await symlink(outside, path.join(item.target, "parent"));
    await assert.rejects(() => promote(root, manifest), /Ignored worktree path collides/);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
    assert.equal(existsSync(path.join(outside, "new.txt")), false);
    assert.equal(await readlink(path.join(item.target, "parent")), outside);
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "symlinkrace", {
      async setupCandidate(candidate) {
        await mkdir(path.join(candidate, "parent"));
        await writeFile(path.join(candidate, "parent", "new.txt"), "desired\n");
      }
    });
    const manifest = prepare(root, [item]);
    await writeFile(path.join(item.target, ".git", "info", "exclude"), "parent\n");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "unchanged\n");
    const shim = path.join(root, "git-symlink-race");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" read-tree -m -u "*) ln -s ${JSON.stringify(outside)} ${JSON.stringify(path.join(item.target, "parent"))};; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const result = await promote(root, manifest, { gitPath: shim });
    assert.equal(result.summary.status, "completed");
    assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
    assert.equal(existsSync(path.join(outside, "new.txt")), false);
    assert.equal(await readFile(path.join(item.target, "parent", "new.txt"), "utf8"), "desired\n");
    assert.equal((await lstat(path.join(item.target, "parent"))).isDirectory(), true);
  });
});

test("intent-to-add and stale managed index guards block or recover without CAS ambiguity", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "ita");
    const manifest = prepare(root, [item]);
    const intentPath = path.join(item.target, "intent.txt");
    let injected = false;
    const blocked = await promote(root, manifest, {
      hooks: {
        afterObjectsImported() {
          if (injected) return;
          injected = true;
          writeFileSync(intentPath, "intent\n");
          git(item.target, "add", "--intent-to-add", "intent.txt");
        }
      }
    });
    assert.equal(blocked.summary.status, "partial");
    assert.equal(blocked.summary.repositories[0]!.status, "objects_imported");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
    git(item.target, "reset", "--", "intent.txt");
    await unlink(intentPath);
    assert.equal((await promote(root, manifest)).summary.status, "completed");
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "guard");
    const manifest = prepare(root, [item]);
    await assert.rejects(() => promote(root, manifest, {
      hooks: { afterJournalCreated() { throw new PromotionTestCrash("guard crash"); } }
    }), /guard crash/);
    const journal = onlyJournal(root);
    const indexLock = path.join(item.target, ".git", "index.lock");
    await writeFile(indexLock, `pi-tools-worker-fold-index ${journal.promotionId} ${journal.repositories[0]!.candidateId}\n`, { mode: 0o600 });
    assert.equal((await promote(root, manifest)).summary.status, "completed");
    assert.equal(existsSync(indexLock), false);
  });
});

test("promotion fails closed below the required Git feature floor", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "oldgit");
    const manifest = prepare(root, [item]);
    const shim = path.join(root, "git-old-version");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" --version "*) echo 'git version 2.35.9'; exit 0;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    await assert.rejects(() => promote(root, manifest, { gitPath: shim }), /requires Git 2\.36 or newer/);
    assert.equal(existsSync(path.join(root, "promotions")), true);
    assert.equal(readdirSync(path.join(root, "promotions")).filter((entry) => entry.startsWith("promotion_")).length, 0);
  });
});

test("candidate-controlled textconv remains unsupported for exact tree transition", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "textconv");
    const manifest = prepare(root, [item]);
    git(item.target, "config", "diff.binary.textconv", "/bin/false");
    await assert.rejects(() => promote(root, manifest), /unsupported_config:diff\.binary\.textconv/);
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), manifest.repositories[0]!.targetExpectedCommit);
  });
});
