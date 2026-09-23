import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

type Fixture = { resolved: ResolvedRepositoryCandidate; selection: RepositoryChangeSetEntry; target: string };

async function fixture(root: string, suffix: string, options: { squash?: boolean } = {}): Promise<Fixture> {
  const target = path.join(root, "targets", `target-${suffix}`);
  const workspace = path.join(root, `workspace-${suffix}`);
  const candidateRepo = path.join(workspace, "repos", `candidate-${suffix}`);
  await mkdir(target, { recursive: true });
  await mkdir(path.dirname(candidateRepo), { recursive: true });
  git(target, "init", "--initial-branch=main");
  await writeFile(path.join(target, "base.txt"), "base\n");
  git(target, "add", "base.txt");
  const baseCommit = commit(target, "base");
  const baseTree = git(target, "rev-parse", "HEAD^{tree}");
  git(root, "clone", "--no-hardlinks", target, candidateRepo);
  await writeFile(path.join(candidateRepo, `candidate-${suffix}.txt`), `candidate ${suffix}\n`);
  git(candidateRepo, "add", `candidate-${suffix}.txt`);
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
    const blocked = await promote(root, manifest);
    assert.equal(blocked.summary.status, "partial");
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
    const shim = path.join(root, "git-inject-ignored-collision");
    await writeFile(shim, `#!/bin/sh\ncase " $* " in *" apply --index --whitespace=nowarn "*) printf '%s\n' 'late ignored output' > ${JSON.stringify(collision)};; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`, { mode: 0o700 });
    const blocked = await promote(root, manifest, { gitPath: shim });
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
    assert.equal(result.summary.status, "quarantined");
    assert.equal(git(item.target, "rev-parse", "refs/heads/side"), expected);
    assert.equal(existsSync(path.join(item.target, "candidate-s.txt")), false);
  });

  await withTempDir(async (root) => {
    const item = await fixture(root, "t");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    const result = await promote(root, manifest, {
      hooks: { beforeWorktreeSync() { git(item.target, "update-ref", "refs/heads/main", expected); } }
    });
    assert.equal(result.summary.status, "quarantined");
    assert.equal(git(item.target, "rev-parse", "refs/heads/main"), expected);
    assert.equal(existsSync(path.join(item.target, "candidate-t.txt")), false);
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
    assert.equal(result.summary.status, "quarantined");
    assert.equal(result.summary.repositories[0]!.status, "quarantined");
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
    for (const command of ["bundle unbundle", "update-ref --no-deref", "apply --index --whitespace=nowarn"]) {
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

test("post-CAS quarantine remains truthful when cancellation is already requested", async () => {
  await withTempDir(async (root) => {
    const item = await fixture(root, "ah");
    const manifest = prepare(root, [item]);
    const expected = manifest.repositories[0]!.targetExpectedCommit;
    const controller = new AbortController();
    const result = await promote(root, manifest, {
      signal: controller.signal,
      hooks: {
        afterRefUpdated() { controller.abort(); },
        beforeWorktreeSync() { git(item.target, "update-ref", "refs/heads/main", expected); }
      }
    });
    assert.equal(result.summary.status, "quarantined");
    assert.equal(result.summary.repositories[0]!.status, "quarantined");
    assert.match(result.summary.repositories[0]!.error ?? "", /Target ref changed before worktree synchronization/);
  });
});

test("quarantines an objects-imported crash window whose expected ref has a desired worktree", async () => {
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
    assert.equal(result.summary.status, "quarantined");
    assert.match(result.summary.repositories[0]!.error ?? "", /expected ref but non-expected worktree/);
    assert.equal(await readFile(path.join(item.target, "candidate-ai.txt"), "utf8"), "candidate ai\n");
  });
});
