import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


test("merge preparation rejects callback-bearing Git attributes", () => {
  const f = fixture();
  try {
    commit(f.candidate, ".gitattributes", "*.txt merge=hostile\n", "hostile attributes");
    assert.throws(() => prepareWorkerMerges("/parent.jsonl", [{ id: "unsafe", candidateRepo: f.candidate, targetRepo: f.target, targetRef: "refs/heads/main", method: "merge", commitMessage: "unsafe" }], { preparedRoot: f.preparedRoot, targetRoot: f.targets, randomHex: () => "f".repeat(24) }), /callback-bearing/);
  } finally { f.close(); }
});
