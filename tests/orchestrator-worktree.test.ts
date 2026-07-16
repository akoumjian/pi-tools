import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertManagedPath,
  commitAllWorktreeChanges,
  createManagedWorktree,
  finalizeManagedWorktree,
  inspectManagedWorktree,
  removeManagedWorktree,
  sanitizeId
} from "../extensions/orchestrator/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function createRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo, { recursive: true }));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Orchestrator Test");
  git(repo, "config", "user.email", "orchestrator@example.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return repo;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

test("managed worktree with no writes is removed with its branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-wt-clean-"));
  try {
    const repo = await createRepo(root);
    const managed = await createManagedWorktree({ cwd: repo, runId: "Run 1", taskId: "No Writes", managedRoot: path.join(root, "managed") });
    assert.equal(await exists(managed.path), true);
    assert.equal((await inspectManagedWorktree(managed)).hasWrites, false);
    const result = await finalizeManagedWorktree(managed);
    assert.equal(result.action, "removed");
    assert.equal(await exists(managed.path), false);
    assert.equal(await exists(path.dirname(managed.path)), false);
    assert.throws(() => git(repo, "show-ref", "--verify", `refs/heads/${managed.branch}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed worktree with uncommitted writes is kept for reconciliation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-wt-dirty-"));
  try {
    const repo = await createRepo(root);
    const managed = await createManagedWorktree({ cwd: repo, runId: "run", taskId: "writer", managedRoot: path.join(root, "managed") });
    await writeFile(path.join(managed.path, "new-file.txt"), "changed\n", "utf8");
    const inspection = await inspectManagedWorktree(managed);
    assert.equal(inspection.hasWrites, true);
    assert.match(inspection.status, /new-file\.txt/);
    const result = await finalizeManagedWorktree(managed);
    assert.equal(result.action, "kept");
    assert.equal(await exists(managed.path), true);
    await removeManagedWorktree(managed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed work counts as writes even with a clean worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-wt-commit-"));
  try {
    const repo = await createRepo(root);
    const managed = await createManagedWorktree({ cwd: repo, runId: "run", taskId: "commit", managedRoot: path.join(root, "managed") });
    await writeFile(path.join(managed.path, "README.md"), "# Fixture changed\n", "utf8");
    git(managed.path, "add", "README.md");
    git(managed.path, "commit", "-m", "writer change");
    const inspection = await inspectManagedWorktree(managed);
    assert.equal(inspection.status, "");
    assert.equal(inspection.aheadCount, 1);
    assert.equal(inspection.hasWrites, true);
    assert.equal((await finalizeManagedWorktree(managed)).action, "kept");
    await removeManagedWorktree(managed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi session state under .pi never counts as writes and is never committed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-wt-pi-state-"));
  try {
    const repo = await createRepo(root);
    await mkdir(path.join(repo, ".pi", "async-shell"), { recursive: true });
    await writeFile(path.join(repo, ".pi", "async-shell", "job.log"), "parent shell log\n", "utf8");
    const managed = await createManagedWorktree({ cwd: repo, runId: "run", taskId: "pi-state", managedRoot: path.join(root, "managed") });
    await mkdir(path.join(managed.path, ".pi", "async-shell"), { recursive: true });
    await writeFile(path.join(managed.path, ".pi", "async-shell", "child-job.log"), "child shell log\n", "utf8");
    assert.equal(await commitAllWorktreeChanges(managed, "orchestrator run/pi-state: shell only"), undefined);
    assert.equal((await inspectManagedWorktree(managed)).hasWrites, false);
    assert.equal((await finalizeManagedWorktree(managed)).action, "removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("harness commit captures writer changes exactly once with orchestrator identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-wt-harness-commit-"));
  try {
    const repo = await createRepo(root);
    const managed = await createManagedWorktree({ cwd: repo, runId: "run", taskId: "harness", managedRoot: path.join(root, "managed") });
    assert.equal(await commitAllWorktreeChanges(managed, "orchestrator run/harness (completed): noop"), undefined);
    await writeFile(path.join(managed.path, "writer-output.txt"), "writer content\n", "utf8");
    const commit = await commitAllWorktreeChanges(managed, "orchestrator run/harness (completed): writer change");
    assert.match(commit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(await commitAllWorktreeChanges(managed, "orchestrator run/harness (completed): repeat"), undefined);
    const inspection = await inspectManagedWorktree(managed);
    assert.equal(inspection.status, "");
    assert.equal(inspection.aheadCount, 1);
    assert.equal(inspection.hasWrites, true);
    assert.match(git(managed.path, "log", "-1", "--format=%an <%ae>"), /Pi Orchestrator <orchestrator@pi\.invalid>/);
    assert.equal((await finalizeManagedWorktree(managed)).action, "kept");
    await removeManagedWorktree(managed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dirty parent checkout is rejected before creating worktree artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-wt-parent-"));
  try {
    const repo = await createRepo(root);
    await writeFile(path.join(repo, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(
      () => createManagedWorktree({ cwd: repo, runId: "run", taskId: "task", managedRoot: path.join(root, "managed") }),
      /dirty parent checkout/
    );
    assert.equal(await exists(path.join(root, "managed")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed path and id guards reject traversal and normalize names", () => {
  assert.equal(sanitizeId(" Writer / API ", "task"), "writer-api");
  assert.equal(sanitizeId("***", "task"), "task");
  assert.doesNotThrow(() => assertManagedPath("/tmp/root/run/task", "/tmp/root"));
  assert.throws(() => assertManagedPath("/tmp/elsewhere", "/tmp/root"), /outside/);
  assert.throws(() => assertManagedPath("/tmp/root", "/tmp/root"), /outside/);
});
