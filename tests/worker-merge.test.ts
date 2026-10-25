import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyPreparedWorkerMerges, consumePreparedMergeSet, prepareWorkerMerges, readPreparedMergeSet } from "../extensions/worker/merge.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com" } }).trim();
}
function commit(repo: string, file: string, text: string, message: string): string {
  writeFileSync(path.join(repo, file), text); git(repo, ["add", file]); git(repo, ["commit", "-m", message]); return git(repo, ["rev-parse", "HEAD"]);
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-worker-merge-"));
  const targets = path.join(root, "targets");
  const preparedRoot = path.join(root, "prepared");
  const target = path.join(targets, "target");
  const candidate = path.join(root, "candidate");
  execFileSync("mkdir", ["-p", targets]);
  execFileSync("git", ["init", "-b", "main", target]);
  commit(target, "file.txt", "base\n", "base");
  execFileSync("git", ["clone", "--no-hardlinks", target, candidate]);
  return { root, targets, preparedRoot, target, candidate, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("merge test prepares and applies an exact merge commit", () => {
  const f = fixture();
  try {
    commit(f.candidate, "candidate.txt", "candidate\n", "candidate");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "source", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "merge candidate" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "a".repeat(24) });
    assert.equal(set.status, "ready");
    assert.equal(set.repositories[0]?.status, "ready");
    const result = applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets });
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(path.join(f.target, "candidate.txt"), "utf8"), "candidate\n");
  } finally { f.close(); }
});

test("merge test retains ordinary conflict state and can transfer the complete set", () => {
  const f = fixture();
  try {
    commit(f.candidate, "file.txt", "candidate\n", "candidate");
    commit(f.target, "file.txt", "target\n", "target");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "conflict", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "merge conflict" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "b".repeat(24) });
    assert.equal(set.status, "resolution_required");
    assert.equal(set.repositories[0]?.overlapCount, 1);
    const workspace = path.join(f.root, "worker");
    const moved = consumePreparedMergeSet("/parent.jsonl", set.preparedId, "worker_20260101000000_aaaaaaaa", workspace, { preparedRoot: f.preparedRoot });
    assert.equal(moved.consumedByWorkerId, "worker_20260101000000_aaaaaaaa");
    assert.equal(readPreparedMergeSet.bind(null, "/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot }) instanceof Function, true);
    assert.throws(() => readPreparedMergeSet("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot }));
  } finally { f.close(); }
});

test("application globally rejects target drift before updating any target", () => {
  const f = fixture();
  try {
    commit(f.candidate, "candidate.txt", "candidate\n", "candidate");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "source", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "squash", commitMessage: "squash candidate" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "c".repeat(24) });
    const moved = commit(f.target, "other.txt", "moved\n", "move target");
    assert.throws(() => applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets }), /moved from/);
    assert.equal(git(f.target, ["rev-parse", "HEAD"]), moved);
    assert.equal(readFileSync(path.join(f.target, "other.txt"), "utf8"), "moved\n");
  } finally { f.close(); }
});


test("integration transfer refuses a target that moved after conflict preparation", () => {
  const f = fixture();
  try {
    commit(f.candidate, "file.txt", "candidate\n", "candidate"); commit(f.target, "file.txt", "target\n", "target");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "conflict", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "merge conflict" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "e".repeat(24) });
    commit(f.target, "moved.txt", "moved\n", "move target");
    assert.throws(() => consumePreparedMergeSet("/parent.jsonl", set.preparedId, "worker_20260101000000_aaaaaaaa", path.join(f.root, "worker"), { preparedRoot: f.preparedRoot }), /run worker_merge_test again/);
  } finally { f.close(); }
});


test("merge preparation permits inert attributes under trusted config", () => {
  const f = fixture();
  try {
    commit(f.candidate, ".gitattributes", "*.txt merge=hostile\n", "hostile attributes");
    const prepared = prepareWorkerMerges("/parent.jsonl", [{ id: "unsafe", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "safe attributes" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "f".repeat(24) });
    assert.equal(prepared.status, "ready");
  } finally { f.close(); }
});

test("merge preparation rejects hostile local Git callbacks before any hook executes", () => {
  const f = fixture(); try {
    const marker = path.join(f.root, "executed"); const hook = path.join(f.root, "fsmonitor.sh"); writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); execFileSync("chmod", ["+x", hook]); git(f.candidate, ["config", "core.fsmonitor", hook]);
    assert.throws(() => prepareWorkerMerges("/parent.jsonl", [{ id: "unsafe-config", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "unsafe" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "1".repeat(24) }), /core.fsmonitor/); assert.equal(existsSync(marker), false);
  } finally { f.close(); }
});

test("merge preparation honors merge method and commit message even when target is an ancestor", () => {
  const f = fixture(); try {
    const candidateHead = commit(f.candidate, "candidate.txt", "candidate\n", "candidate");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "integrated", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "must not create redundant merge" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "2".repeat(24) });
    assert.notEqual(set.repositories[0]?.desiredCommit, candidateHead); assert.equal(git(set.repositories[0]!.preparedPath, ["rev-parse", "refs/worker/candidate"]), candidateHead); assert.equal(git(set.repositories[0]!.preparedPath, ["show", "-s", "--format=%s", "HEAD"]), "must not create redundant merge");
  } finally { f.close(); }
});

test("merge preparation rejects replace refs and graft metadata", () => {
  const f = fixture(); try {
    const head = git(f.candidate, ["rev-parse", "HEAD"]); git(f.candidate, ["update-ref", `refs/replace/${head}`, head]);
    assert.throws(() => prepareWorkerMerges("/parent.jsonl", [{ id: "replace", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "no" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "3".repeat(24) }), /replace refs/);
    git(f.candidate, ["update-ref", "-d", `refs/replace/${head}`]); const graft = path.join(f.candidate, ".git", "info", "grafts"); writeFileSync(graft, `${head}\n`);
    assert.throws(() => prepareWorkerMerges("/parent.jsonl", [{ id: "graft", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "no" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "4".repeat(24) }), /grafts/);
  } finally { f.close(); }
});

test("partial application records exact progress and retries remaining atomic ref updates", () => {
  const f = fixture();
  try {
    const target2 = path.join(f.targets, "target2"); const candidate2 = path.join(f.root, "candidate2");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", f.target, target2]); execFileSync("git", ["clone", "-q", "--no-hardlinks", target2, candidate2]);
    commit(f.candidate, "one.txt", "one\n", "one"); commit(candidate2, "two.txt", "two\n", "two"); git(f.target, ["checkout", "--detach"]); git(target2, ["checkout", "--detach"]);
    const set = prepareWorkerMerges("/parent.jsonl", [
      { id: "two", candidateRepo: candidate2, targetRepo: target2, targetRef: "refs/heads/main", method: "merge", commitMessage: "two", dependsOn: ["one"] },
      { id: "one", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "one" },
    ], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "5".repeat(24) });
    assert.deepEqual(set.order, ["one", "two"]);
    const lock = path.join(target2, ".git", "refs", "heads", "main.lock");
    const partial = applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets, sourceForCandidate: (repo) => { if (path.basename(repo) === path.basename(candidate2)) writeFileSync(lock, "locked\n"); return {}; } });
    assert.equal(partial.status, "partial"); assert.equal(partial.repositories[0]?.status, "applied"); assert.equal(partial.repositories[1]?.status, "failed");
    assert.equal(git(f.target, ["rev-parse", "refs/heads/main"]), set.repositories[0]!.desiredCommit); assert.equal(git(target2, ["rev-parse", "refs/heads/main"]), set.repositories[1]!.expectedCommit);
    rmSync(lock); const retried = applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets });
    assert.equal(retried.status, "completed"); assert.equal(git(target2, ["rev-parse", "refs/heads/main"]), set.repositories[1]!.desiredCommit);
  } finally { f.close(); }
});

test("a parent-resolved prepared repository can be revalidated through Git-native input", () => {
  const f = fixture();
  try {
    commit(f.candidate, "file.txt", "candidate\n", "candidate");
    commit(f.target, "file.txt", "target\n", "target");
    const conflicted = prepareWorkerMerges("/parent.jsonl", [{ id: "conflict", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "conflict" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "6".repeat(24) });
    const preparedPath = conflicted.repositories[0]!.preparedPath;
    writeFileSync(path.join(preparedPath, "file.txt"), "resolved\n");
    git(preparedPath, ["add", "file.txt"]); git(preparedPath, ["commit", "--no-verify", "-m", "resolve conflict"]);
    const revalidated = prepareWorkerMerges("/parent.jsonl", [{ id: "resolved", candidateRepo: preparedPath, candidateRef: "HEAD", targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "apply resolved conflict" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "7".repeat(24) });
    assert.equal(revalidated.status, "ready");
    const applied = applyPreparedWorkerMerges("/parent.jsonl", revalidated.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets });
    assert.equal(applied.status, "completed"); assert.equal(readFileSync(path.join(f.target, "file.txt"), "utf8"), "resolved\n");
  } finally { f.close(); }
});

test("application updates a target ref through its exact linked worktree", () => {
  const f = fixture();
  try {
    git(f.target, ["branch", "release"]);
    const linked = path.join(f.root, "release-worktree"); execFileSync("git", ["-C", f.target, "worktree", "add", "-q", linked, "release"]);
    const candidate = path.join(f.root, "release-candidate"); execFileSync("git", ["clone", "-q", "--no-hardlinks", f.target, candidate]); git(candidate, ["checkout", "release"]);
    commit(candidate, "release.txt", "release\n", "release candidate");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "release", candidateRepo: candidate, targetRepo: f.target, targetRef: "refs/heads/release", method: "merge", commitMessage: "merge release" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "8".repeat(24) });
    assert.equal(applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets }).status, "completed");
    assert.equal(readFileSync(path.join(linked, "release.txt"), "utf8"), "release\n");
  } finally { f.close(); }
});

test("apply checks only the exact checked-out target worktree and treats untracked nested repositories as dirty", () => {
  const f = fixture();
  try {
    commit(f.candidate, "candidate.txt", "candidate\n", "candidate");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "source", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "candidate" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "a1".repeat(12) });
    const nested = path.join(f.target, "untracked-nested"); execFileSync("git", ["init", "-q", nested]);
    assert.throws(() => applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets }), /Target repository is dirty/);
    rmSync(nested, { recursive: true, force: true });
    writeFileSync(path.join(f.target, ".git", "info", "exclude"), "ignored-nested/\n"); const ignored = path.join(f.target, "ignored-nested"); execFileSync("git", ["init", "-q", ignored]);
    assert.equal(applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets }).status, "completed");
  } finally { f.close(); }
});


test("checked-out apply refuses an ignored file collision without changing the file or ref", () => {
  const f = fixture();
  try {
    commit(f.candidate, "generated.txt", "tracked candidate\n", "track generated file");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "source", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "candidate" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "c3".repeat(12) });
    const expected = git(f.target, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(f.target, ".git", "info", "exclude"), "generated.txt\n");
    writeFileSync(path.join(f.target, "generated.txt"), "local ignored value\n");

    const result = applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /untracked working tree files would be overwritten|would be overwritten by merge/i);
    assert.equal(readFileSync(path.join(f.target, "generated.txt"), "utf8"), "local ignored value\n");
    assert.equal(git(f.target, ["rev-parse", "HEAD"]), expected);
    assert.equal(git(f.target, ["rev-parse", "refs/heads/main"]), expected);
  } finally { f.close(); }
});

test("apply does not reject an unrelated dirty worktree when the target ref is not checked out", () => {
  const f = fixture();
  try {
    git(f.target, ["branch", "release"]); const candidate = path.join(f.root, "release-detached-candidate"); execFileSync("git", ["clone", "-q", "--no-hardlinks", f.target, candidate]); git(candidate, ["checkout", "release"]); commit(candidate, "release.txt", "release\n", "release");
    const set = prepareWorkerMerges("/parent.jsonl", [{ id: "release", candidateRepo: candidate, targetRepo: f.target, targetRef: "refs/heads/release", method: "merge", commitMessage: "release" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "b2".repeat(12) });
    writeFileSync(path.join(f.target, "unrelated-untracked.txt"), "dirty\n");
    assert.equal(applyPreparedWorkerMerges("/parent.jsonl", set.preparedId, { preparedRoot: f.preparedRoot, targetRoot: f.targets }).status, "completed");
    assert.equal(git(f.target, ["rev-parse", "refs/heads/release"]), set.repositories[0]!.desiredCommit);
  } finally { f.close(); }
});
